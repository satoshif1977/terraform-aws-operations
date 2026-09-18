"""
CloudWatch メトリクス発行ユーティリティ（Embedded Metric Format）

メトリクスを EMF（Embedded Metric Format）の 1 行 JSON として標準出力に書き出す。
CloudWatch Logs 側がログから自動でメトリクスを抽出するため、PutMetricData を
呼ぶ必要がなく、API 呼び出しのレイテンシもスロットリングも発生しない。

同ディレクトリの retry.py / logger.py と同じ「AWS 呼び出しの運用品質を揃える」
方針の第 3 弾。retry_metrics() を retry_call の on_retry に渡して結線できる
（logger.py の retry_logger() と同じ形）。

index.py と同一ディレクトリに配置され、archive_file のデプロイパッケージにも
同じ階層で格納される。同リポジトリの TypeScript 版（lambda_ts/streams-alert/metrics.ts）
および Go 版（lambda_go/guardduty-notifier/metrics.go）と並置する 3 言語目。

設計方針:
  - now_ms / sink を注入可能にして、テストを決定的に保つ（時刻と出力先を固定できる）
  - EMF 仕様の上限（1 ドキュメント 100 メトリクス / 1 メトリクス 100 値）に達したら
    例外ではなく自動で flush して継続する。メトリクスは副次処理であり、
    上限超過で本処理を落とすよりデータを出し切るほうが望ましいため
  - 一方で「名前空間が空」「単位が不正」などの設定ミスは ValueError で即座に落とす。
    CloudWatch 側は不正な EMF を黙って破棄するので、気づけないままメトリクスが
    欠落するほうが有害だから
  - ディメンションは高カーディナリティにしないこと（組み合わせごとに課金対象の
    カスタムメトリクスが作られる）。request_id のような値は set_property() を使う
  - NaN / Infinity は json.dumps が非標準トークンを出力し EMF 全体が破棄されるため、
    値の追加時点で弾く

仕様の出典:
  https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html

使い方:
    metrics = create_metrics_from_env()
    metrics.set_dimensions(Service="transform", Environment="dev")
    metrics.set_property("request_id", context.aws_request_id)
    with metrics.timer("ProcessingLatency"):
        do_work()
    metrics.add_metric("ProcessedItems", 12, unit="Count")
    metrics.flush()
"""

from __future__ import annotations

import json
import math
import os
import sys
import time
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, TextIO

# ── EMF 仕様の上限 ─────────────────────────────────────────
# いずれも公式スキーマの定義値。破ると CloudWatch 側でドキュメントごと
# 破棄されてしまうため、ここで守り切る。

MAX_METRICS_PER_DOCUMENT = 100
"""1 つの MetricDirective が持てる MetricDefinition の最大数"""

MAX_VALUES_PER_METRIC = 100
"""1 メトリクスの値配列の最大要素数"""

MAX_DIMENSION_KEYS = 30
"""1 つの DimensionSet が持てるディメンションキーの最大数"""

MAX_NAMESPACE_LENGTH = 1024
MAX_METRIC_NAME_LENGTH = 1024
MAX_DIMENSION_NAME_LENGTH = 250
MAX_DIMENSION_VALUE_LENGTH = 1024

MAX_EVENT_BYTES = 1024 * 1024
"""CloudWatch Logs の 1 イベントあたりの上限（1 MB）"""

RESERVED_ROOT_KEY = "_aws"
"""EMF のメタデータ用に予約されたルートキー"""

# CloudWatch が受け付ける単位。公式スキーマの Unit パターンと同一。
VALID_UNITS: frozenset[str] = frozenset(
    {
        "Seconds",
        "Microseconds",
        "Milliseconds",
        "Bytes",
        "Kilobytes",
        "Megabytes",
        "Gigabytes",
        "Terabytes",
        "Bits",
        "Kilobits",
        "Megabits",
        "Gigabits",
        "Terabits",
        "Percent",
        "Count",
        "Bytes/Second",
        "Kilobytes/Second",
        "Megabytes/Second",
        "Gigabytes/Second",
        "Terabytes/Second",
        "Bits/Second",
        "Kilobits/Second",
        "Megabits/Second",
        "Gigabits/Second",
        "Terabits/Second",
        "Count/Second",
        "None",
    }
)

DEFAULT_UNIT = "None"
"""Unit 省略時に CloudWatch が想定する既定値"""

VALID_STORAGE_RESOLUTIONS: tuple[int, ...] = (1, 60)
DEFAULT_STORAGE_RESOLUTION = 60

DEFAULT_NAMESPACE = "Application"
NAMESPACE_ENV_VAR = "METRICS_NAMESPACE"
ENABLED_ENV_VAR = "METRICS_ENABLED"


# ── 検証 ───────────────────────────────────────────────────


def validate_namespace(namespace: str) -> str:
    """名前空間を検証して返す。不正なら ValueError。"""
    if not isinstance(namespace, str) or not namespace.strip():
        raise ValueError("メトリクスの名前空間は空にできません")
    if len(namespace) > MAX_NAMESPACE_LENGTH:
        raise ValueError(
            f"メトリクスの名前空間は {MAX_NAMESPACE_LENGTH} 文字以内にしてください"
            f"（実際: {len(namespace)} 文字）"
        )
    return namespace


def validate_unit(unit: str | None) -> str:
    """単位を検証して返す。None は既定値に読み替える。"""
    if unit is None:
        return DEFAULT_UNIT
    if unit not in VALID_UNITS:
        raise ValueError(
            f"{unit!r} は CloudWatch の単位として無効です。"
            f"有効な値: {', '.join(sorted(VALID_UNITS))}"
        )
    return unit


def validate_storage_resolution(resolution: int) -> int:
    """ストレージ解像度（1 = 高解像度 / 60 = 標準）を検証して返す。"""
    if resolution not in VALID_STORAGE_RESOLUTIONS:
        raise ValueError(
            "storage_resolution は 1（高解像度）か 60（標準）のみ指定できます"
            f"（実際: {resolution!r}）"
        )
    return resolution


def _coerce_number(value: Any) -> float | int:
    """メトリクス値を JSON で表現できる数値に変換する。

    bool は int のサブクラスだが、メトリクス値として渡すのはほぼ誤りなので弾く。
    Decimal は DynamoDB 由来の値をそのまま渡せるよう float に変換する。
    """
    if isinstance(value, bool):
        raise ValueError("メトリクス値に bool は指定できません")
    if isinstance(value, Decimal):
        value = float(value)
    if not isinstance(value, (int, float)):
        raise ValueError(
            f"メトリクス値は数値である必要があります（実際: {type(value).__name__}）"
        )
    if not math.isfinite(value):
        # json.dumps は NaN / Infinity を非標準トークンとして出力するため、
        # CloudWatch 側で EMF ドキュメント全体が破棄されてしまう
        raise ValueError("メトリクス値に NaN / Infinity は指定できません")
    return value


def _coerce_dimension_value(name: str, value: Any) -> str:
    """ディメンション値を文字列に正規化する。空文字は EMF 側で無効。"""
    text = value if isinstance(value, str) else str(value)
    if not text:
        raise ValueError(f"ディメンション {name!r} の値は空にできません")
    if len(text) > MAX_DIMENSION_VALUE_LENGTH:
        raise ValueError(
            f"ディメンション {name!r} の値は {MAX_DIMENSION_VALUE_LENGTH} 文字以内に"
            f"してください（実際: {len(text)} 文字）"
        )
    return text


def _validate_dimension_name(name: str) -> str:
    if not isinstance(name, str) or not name:
        raise ValueError("ディメンション名は空にできません")
    if name == RESERVED_ROOT_KEY:
        raise ValueError(f"{RESERVED_ROOT_KEY!r} は EMF の予約キーのため使用できません")
    if len(name) > MAX_DIMENSION_NAME_LENGTH:
        raise ValueError(
            f"ディメンション名は {MAX_DIMENSION_NAME_LENGTH} 文字以内にしてください"
            f"（実際: {len(name)} 文字）"
        )
    return name


def _validate_metric_name(name: str) -> str:
    if not isinstance(name, str) or not name:
        raise ValueError("メトリクス名は空にできません")
    if name == RESERVED_ROOT_KEY:
        raise ValueError(f"{RESERVED_ROOT_KEY!r} は EMF の予約キーのため使用できません")
    if len(name) > MAX_METRIC_NAME_LENGTH:
        raise ValueError(
            f"メトリクス名は {MAX_METRIC_NAME_LENGTH} 文字以内にしてください"
            f"（実際: {len(name)} 文字）"
        )
    return name


# ── EMF ドキュメントの組み立て ─────────────────────────────


@dataclass(frozen=True)
class MetricEntry:
    """1 メトリクス分の定義と観測値。"""

    name: str
    values: tuple[float | int, ...]
    unit: str = DEFAULT_UNIT
    storage_resolution: int = DEFAULT_STORAGE_RESOLUTION

    def definition(self) -> dict[str, Any]:
        """MetricDefinition オブジェクトを組み立てる。

        Unit / StorageResolution は既定値と同じときは省略する
        （EMF 側の既定と一致するので、出力を小さく保つ）。
        """
        payload: dict[str, Any] = {"Name": self.name}
        if self.unit != DEFAULT_UNIT:
            payload["Unit"] = self.unit
        if self.storage_resolution != DEFAULT_STORAGE_RESOLUTION:
            payload["StorageResolution"] = self.storage_resolution
        return payload

    def target_value(self) -> Any:
        """ルートノードに載せる値。1 件なら数値、複数なら配列。"""
        return self.values[0] if len(self.values) == 1 else list(self.values)


def build_emf_document(
    namespace: str,
    metrics: Mapping[str, MetricEntry],
    dimensions: Mapping[str, str],
    properties: Mapping[str, Any],
    timestamp_ms: int,
) -> dict[str, Any]:
    """EMF ドキュメント（ルートノード）を組み立てる。

    ディメンションもメトリクスの値も、どちらもルートノード直下に置く必要がある
    （Target members）。名前が衝突するとどちらかが黙って上書きされるため、
    検出したら例外にする。
    """
    document: dict[str, Any] = {
        RESERVED_ROOT_KEY: {
            "Timestamp": timestamp_ms,
            "CloudWatchMetrics": [
                {
                    "Namespace": namespace,
                    "Dimensions": [list(dimensions.keys())],
                    "Metrics": [entry.definition() for entry in metrics.values()],
                }
            ],
        }
    }

    for key, value in properties.items():
        if key == RESERVED_ROOT_KEY:
            raise ValueError(
                f"{RESERVED_ROOT_KEY!r} は EMF の予約キーのため使用できません"
            )
        document[key] = value

    for key, value in dimensions.items():
        document[key] = value

    for name, entry in metrics.items():
        if name in dimensions:
            raise ValueError(
                f"{name!r} がメトリクス名とディメンション名で重複しています。"
                "EMF ではどちらもルートノードの同じキーを使うため、片方を改名してください"
            )
        document[name] = entry.target_value()

    return document


def serialize_document(document: Mapping[str, Any]) -> str:
    """EMF ドキュメントを 1 行の JSON にする。

    CloudWatch Logs は 1 イベント = 1 行なので、改行を含めてはいけない。
    """
    return json.dumps(document, ensure_ascii=False, separators=(",", ":"), default=str)


# ── 出力先 ─────────────────────────────────────────────────


def stdout_sink(line: str) -> None:
    """標準出力へ 1 行書き出す（Lambda では CloudWatch Logs に届く）。"""
    stream: TextIO = sys.stdout
    print(line, file=stream)


def _utc_now_ms() -> int:
    """EMF の Timestamp（1970-01-01 UTC からのミリ秒）。"""
    return int(time.time() * 1000)


# ── メトリクス本体 ─────────────────────────────────────────


@dataclass
class MetricsCollector:
    """EMF メトリクスを蓄積し、flush でまとめて出力する。

    logger.py の StructuredLogger と違い、値を溜め込む性質上ミュータブルにしている。
    """

    namespace: str = DEFAULT_NAMESPACE
    enabled: bool = True
    sink: Callable[[str], None] = stdout_sink
    now_ms: Callable[[], int] = _utc_now_ms
    default_dimensions: dict[str, str] = field(default_factory=dict)

    _metrics: dict[str, MetricEntry] = field(
        default_factory=dict, init=False, repr=False
    )
    _dimensions: dict[str, str] = field(default_factory=dict, init=False, repr=False)
    _properties: dict[str, Any] = field(default_factory=dict, init=False, repr=False)

    def __post_init__(self) -> None:
        self.namespace = validate_namespace(self.namespace)
        self.default_dimensions = {
            _validate_dimension_name(k): _coerce_dimension_value(k, v)
            for k, v in self.default_dimensions.items()
        }

    # ── ディメンション / プロパティ ──

    def set_dimensions(self, **dimensions: Any) -> None:
        """このドキュメントのディメンションを置き換える。"""
        new = {
            _validate_dimension_name(k): _coerce_dimension_value(k, v)
            for k, v in dimensions.items()
        }
        self._check_dimension_count(new)
        self._dimensions = new

    def add_dimension(self, name: str, value: Any) -> None:
        """ディメンションを 1 つ追加する。"""
        key = _validate_dimension_name(name)
        candidate = dict(self._dimensions)
        candidate[key] = _coerce_dimension_value(key, value)
        self._check_dimension_count(candidate)
        self._dimensions = candidate

    def _check_dimension_count(self, dimensions: Mapping[str, str]) -> None:
        total = len({**self.default_dimensions, **dimensions})
        if total > MAX_DIMENSION_KEYS:
            raise ValueError(
                f"ディメンションは 1 ドキュメントあたり {MAX_DIMENSION_KEYS} 個までです"
                f"（実際: {total} 個）"
            )

    def set_property(self, name: str, value: Any) -> None:
        """メトリクス化せず、ログにだけ残す値を設定する。

        request_id のような高カーディナリティな値はこちらに入れる。
        ディメンションにすると、値の種類の数だけ課金対象のカスタムメトリクスが
        作られてしまうため。
        """
        if name == RESERVED_ROOT_KEY:
            raise ValueError(
                f"{RESERVED_ROOT_KEY!r} は EMF の予約キーのため使用できません"
            )
        self._properties[name] = value

    # ── メトリクス ──

    def add_metric(
        self,
        name: str,
        value: Any,
        unit: str | None = None,
        storage_resolution: int = DEFAULT_STORAGE_RESOLUTION,
    ) -> None:
        """メトリクスを 1 件追加する。

        同じ名前で複数回呼ぶと値が配列として蓄積され、CloudWatch 側で
        統計（Sum / Average / Maximum ...）として集計できる。

        EMF の上限に達した場合は例外ではなく自動で flush して継続する
        （メトリクスの取りこぼしより、ドキュメントが増えるほうが害が小さい）。
        """
        metric_name = _validate_metric_name(name)
        resolved_unit = validate_unit(unit)
        resolved_resolution = validate_storage_resolution(storage_resolution)
        number = _coerce_number(value)

        existing = self._metrics.get(metric_name)

        if existing is None and len(self._metrics) >= MAX_METRICS_PER_DOCUMENT:
            # 新しいメトリクスを足すと 100 件を超えるので、いったん出し切る
            self.flush()
            existing = None
        elif existing is not None and len(existing.values) >= MAX_VALUES_PER_METRIC:
            # 同名メトリクスの値配列が 100 件に達した
            self.flush()
            existing = None

        if existing is None:
            self._metrics[metric_name] = MetricEntry(
                name=metric_name,
                values=(number,),
                unit=resolved_unit,
                storage_resolution=resolved_resolution,
            )
            return

        if existing.unit != resolved_unit:
            raise ValueError(
                f"メトリクス {metric_name!r} の単位が一致しません"
                f"（既存: {existing.unit} / 今回: {resolved_unit}）"
            )
        self._metrics[metric_name] = MetricEntry(
            name=metric_name,
            values=existing.values + (number,),
            unit=existing.unit,
            storage_resolution=existing.storage_resolution,
        )

    @contextmanager
    def timer(
        self,
        name: str,
        unit: str = "Milliseconds",
        clock: Callable[[], float] | None = None,
    ) -> Iterator[None]:
        """ブロックの所要時間をメトリクスとして記録する。

        例外が起きても計測値は記録してから送出する（失敗時のレイテンシも見たいため）。
        clock を注入できるようにしてテストを決定的に保つ。
        """
        tick = clock or time.perf_counter
        started = tick()
        try:
            yield
        finally:
            elapsed = tick() - started
            measured = elapsed * 1000 if unit == "Milliseconds" else elapsed
            self.add_metric(name, measured, unit=unit)

    # ── 出力 ──

    def flush(self) -> list[str]:
        """蓄積したメトリクスを EMF として出力し、バッファを空にする。

        メトリクスが 1 件も無い場合は何も出力しない（メトリクスを含まない EMF は
        CloudWatch 側で無意味なうえ、ログのノイズにもなるため）。
        戻り値は実際に出力した行のリスト（テストと呼び出し側の検証用）。
        """
        if not self._metrics:
            self._properties.clear()
            return []

        if not self.enabled:
            self._metrics.clear()
            self._properties.clear()
            return []

        document = build_emf_document(
            namespace=self.namespace,
            metrics=self._metrics,
            dimensions={**self.default_dimensions, **self._dimensions},
            properties=self._properties,
            timestamp_ms=self.now_ms(),
        )
        line = serialize_document(document)

        self._metrics.clear()
        self._properties.clear()

        if len(line.encode("utf-8")) > MAX_EVENT_BYTES:
            raise ValueError(
                f"EMF ドキュメントが CloudWatch Logs の上限（{MAX_EVENT_BYTES} バイト）を"
                "超えています。プロパティを減らすか、flush の間隔を短くしてください"
            )

        self.sink(line)
        return [line]

    def __enter__(self) -> MetricsCollector:
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        # 例外で抜けるときも flush する（失敗時の計測値こそ残したいため）
        self.flush()


def create_metrics(
    namespace: str = DEFAULT_NAMESPACE,
    *,
    enabled: bool = True,
    sink: Callable[[str], None] = stdout_sink,
    now_ms: Callable[[], int] = _utc_now_ms,
    **default_dimensions: Any,
) -> MetricsCollector:
    """MetricsCollector を組み立てる。"""
    return MetricsCollector(
        namespace=namespace,
        enabled=enabled,
        sink=sink,
        now_ms=now_ms,
        default_dimensions=dict(default_dimensions),
    )


def create_metrics_from_env(
    env: Mapping[str, str] | None = None,
    **default_dimensions: Any,
) -> MetricsCollector:
    """環境変数から MetricsCollector を組み立てる。

    METRICS_NAMESPACE: 名前空間（未設定なら 'Application'）
    METRICS_ENABLED:   'false' / '0' / 'no' / 'off' のときだけ無効化する。
                       未知の値で黙って無効化されるとメトリクスが消えてしまうため、
                       明示的な否定語だけを無効として扱う。
    """
    source = os.environ if env is None else env
    namespace = source.get(NAMESPACE_ENV_VAR) or DEFAULT_NAMESPACE
    raw_enabled = (source.get(ENABLED_ENV_VAR) or "").strip().lower()
    enabled = raw_enabled not in ("false", "0", "no", "off")
    return create_metrics(namespace, enabled=enabled, **default_dimensions)


# ── リトライとの連携 ───────────────────────────────────────


def retry_metrics(
    metrics: MetricsCollector,
    operation: str,
    metric_name: str = "RetryAttempts",
) -> Callable[[int, float, BaseException], None]:
    """retry_call の on_retry に渡せるフックを返す。

    リトライの発生回数と待機時間をメトリクス化し、スロットリングの状況を
    CloudWatch のダッシュボードやアラームで追えるようにする。
    operation はプロパティとして残す（ディメンションにすると呼び出し箇所の数だけ
    カスタムメトリクスが増えてしまうため）。
    """

    def on_retry(attempt: int, delay_seconds: float, exc: BaseException) -> None:
        metrics.set_property("retry_operation", operation)
        metrics.set_property("retry_attempt", attempt)
        metrics.set_property("retry_last_error", type(exc).__name__)
        metrics.add_metric(metric_name, 1, unit="Count")
        metrics.add_metric("RetryDelay", delay_seconds * 1000, unit="Milliseconds")

    return on_retry

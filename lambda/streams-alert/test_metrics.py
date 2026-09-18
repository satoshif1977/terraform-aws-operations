"""metrics.py（EMF メトリクス）のユニットテスト

sink と now_ms を注入して、出力先と時刻を固定した決定的なテストにする。
"""

from __future__ import annotations

import json
import math
from decimal import Decimal

import pytest
from metrics import (
    DEFAULT_NAMESPACE,
    DEFAULT_STORAGE_RESOLUTION,
    MAX_DIMENSION_KEYS,
    MAX_METRICS_PER_DOCUMENT,
    MAX_VALUES_PER_METRIC,
    RESERVED_ROOT_KEY,
    VALID_UNITS,
    MetricEntry,
    MetricsCollector,
    build_emf_document,
    create_metrics,
    create_metrics_from_env,
    retry_metrics,
    serialize_document,
    validate_namespace,
    validate_storage_resolution,
    validate_unit,
)

FIXED_NOW_MS = 1_574_109_732_004


class Recorder:
    """sink に渡された行を記録するだけのヘルパー。"""

    def __init__(self) -> None:
        self.lines: list[str] = []

    def __call__(self, line: str) -> None:
        self.lines.append(line)

    @property
    def documents(self) -> list[dict]:
        return [json.loads(line) for line in self.lines]

    @property
    def last(self) -> dict:
        return self.documents[-1]


def make_metrics(**kwargs) -> tuple[MetricsCollector, Recorder]:
    recorder = Recorder()
    collector = create_metrics(
        kwargs.pop("namespace", "TestApp"),
        sink=recorder,
        now_ms=lambda: FIXED_NOW_MS,
        **kwargs,
    )
    return collector, recorder


def directive(document: dict) -> dict:
    return document[RESERVED_ROOT_KEY]["CloudWatchMetrics"][0]


# ── EMF ドキュメントの構造 ─────────────────────────────────


class TestDocumentStructure:
    def test_必須のメタデータが含まれる(self) -> None:
        metrics, rec = make_metrics()
        metrics.set_dimensions(Service="transform")
        metrics.add_metric("ProcessedItems", 3, unit="Count")
        metrics.flush()

        doc = rec.last
        assert RESERVED_ROOT_KEY in doc
        assert doc[RESERVED_ROOT_KEY]["Timestamp"] == FIXED_NOW_MS
        assert directive(doc)["Namespace"] == "TestApp"

    def test_ディメンションはキー名の配列として入る(self) -> None:
        metrics, rec = make_metrics()
        metrics.set_dimensions(Service="transform", Environment="dev")
        metrics.add_metric("Count1", 1)
        metrics.flush()

        assert directive(rec.last)["Dimensions"] == [["Service", "Environment"]]

    def test_ディメンションの値はルートノードに置かれる(self) -> None:
        metrics, rec = make_metrics()
        metrics.set_dimensions(Service="transform")
        metrics.add_metric("Count1", 1)
        metrics.flush()

        assert rec.last["Service"] == "transform"

    def test_メトリクス値はルートノードに置かれる(self) -> None:
        metrics, rec = make_metrics()
        metrics.add_metric("Latency", 12.5, unit="Milliseconds")
        metrics.flush()

        assert rec.last["Latency"] == 12.5

    def test_単一値は数値で出力される(self) -> None:
        metrics, rec = make_metrics()
        metrics.add_metric("Latency", 10, unit="Milliseconds")
        metrics.flush()

        assert rec.last["Latency"] == 10
        assert not isinstance(rec.last["Latency"], list)

    def test_同名で複数回追加すると配列になる(self) -> None:
        metrics, rec = make_metrics()
        for value in (10, 20, 30):
            metrics.add_metric("Latency", value, unit="Milliseconds")
        metrics.flush()

        assert rec.last["Latency"] == [10, 20, 30]

    def test_単位が既定値なら_Unit_を省略する(self) -> None:
        metrics, rec = make_metrics()
        metrics.add_metric("Plain", 1)
        metrics.flush()

        definition = directive(rec.last)["Metrics"][0]
        assert definition == {"Name": "Plain"}

    def test_単位を指定すると_Unit_が入る(self) -> None:
        metrics, rec = make_metrics()
        metrics.add_metric("Latency", 1, unit="Milliseconds")
        metrics.flush()

        assert directive(rec.last)["Metrics"][0]["Unit"] == "Milliseconds"

    def test_標準解像度なら_StorageResolution_を省略する(self) -> None:
        metrics, rec = make_metrics()
        metrics.add_metric("Latency", 1, unit="Milliseconds")
        metrics.flush()

        assert "StorageResolution" not in directive(rec.last)["Metrics"][0]

    def test_高解像度を指定すると_StorageResolution_が入る(self) -> None:
        metrics, rec = make_metrics()
        metrics.add_metric("Latency", 1, unit="Milliseconds", storage_resolution=1)
        metrics.flush()

        assert directive(rec.last)["Metrics"][0]["StorageResolution"] == 1

    def test_出力は改行を含まない1行である(self) -> None:
        metrics, rec = make_metrics()
        metrics.set_property("note", "複数行に\nならないこと")
        metrics.add_metric("Count1", 1)
        metrics.flush()

        assert "\n" not in rec.lines[0]

    def test_日本語はエスケープせずそのまま出力する(self) -> None:
        metrics, rec = make_metrics()
        metrics.set_property("message", "処理完了")
        metrics.add_metric("Count1", 1)
        metrics.flush()

        assert "処理完了" in rec.lines[0]


# ── プロパティ ─────────────────────────────────────────────


class TestProperties:
    def test_プロパティはルートノードに入るがメトリクス定義には入らない(self) -> None:
        metrics, rec = make_metrics()
        metrics.set_property("request_id", "abc-123")
        metrics.add_metric("Count1", 1)
        metrics.flush()

        doc = rec.last
        assert doc["request_id"] == "abc-123"
        names = [m["Name"] for m in directive(doc)["Metrics"]]
        assert "request_id" not in names

    def test_プロパティはディメンションに含まれない(self) -> None:
        metrics, rec = make_metrics()
        metrics.set_property("request_id", "abc-123")
        metrics.add_metric("Count1", 1)
        metrics.flush()

        assert directive(rec.last)["Dimensions"] == [[]]

    def test_予約キーはプロパティに使えない(self) -> None:
        metrics, _ = make_metrics()
        with pytest.raises(ValueError, match=RESERVED_ROOT_KEY):
            metrics.set_property(RESERVED_ROOT_KEY, "x")

    def test_プロパティは_flush_後にクリアされる(self) -> None:
        metrics, rec = make_metrics()
        metrics.set_property("request_id", "abc-123")
        metrics.add_metric("Count1", 1)
        metrics.flush()

        metrics.add_metric("Count1", 1)
        metrics.flush()

        assert "request_id" not in rec.documents[1]


# ── ディメンション ─────────────────────────────────────────


class TestDimensions:
    def test_既定ディメンションは毎回付与される(self) -> None:
        metrics, rec = make_metrics(Environment="dev")
        metrics.add_metric("Count1", 1)
        metrics.flush()
        metrics.add_metric("Count1", 1)
        metrics.flush()

        for doc in rec.documents:
            assert doc["Environment"] == "dev"

    def test_既定ディメンションと個別指定はマージされる(self) -> None:
        metrics, rec = make_metrics(Environment="dev")
        metrics.set_dimensions(Service="transform")
        metrics.add_metric("Count1", 1)
        metrics.flush()

        assert directive(rec.last)["Dimensions"] == [["Environment", "Service"]]

    def test_set_dimensions_は以前の指定を置き換える(self) -> None:
        metrics, rec = make_metrics()
        metrics.set_dimensions(A="1")
        metrics.set_dimensions(B="2")
        metrics.add_metric("Count1", 1)
        metrics.flush()

        assert directive(rec.last)["Dimensions"] == [["B"]]

    def test_add_dimension_は既存に追加する(self) -> None:
        metrics, rec = make_metrics()
        metrics.set_dimensions(A="1")
        metrics.add_dimension("B", "2")
        metrics.add_metric("Count1", 1)
        metrics.flush()

        assert directive(rec.last)["Dimensions"] == [["A", "B"]]

    def test_ディメンション値は文字列に変換される(self) -> None:
        metrics, rec = make_metrics()
        metrics.add_dimension("Version", 3)
        metrics.add_metric("Count1", 1)
        metrics.flush()

        assert rec.last["Version"] == "3"

    def test_空の値は拒否する(self) -> None:
        metrics, _ = make_metrics()
        with pytest.raises(ValueError, match="空にできません"):
            metrics.add_dimension("Service", "")

    def test_空の名前は拒否する(self) -> None:
        metrics, _ = make_metrics()
        with pytest.raises(ValueError, match="空にできません"):
            metrics.add_dimension("", "x")

    def test_予約キーは名前に使えない(self) -> None:
        metrics, _ = make_metrics()
        with pytest.raises(ValueError, match=RESERVED_ROOT_KEY):
            metrics.add_dimension(RESERVED_ROOT_KEY, "x")

    def test_上限ちょうどは許容する(self) -> None:
        metrics, rec = make_metrics()
        metrics.set_dimensions(**{f"D{i}": str(i) for i in range(MAX_DIMENSION_KEYS)})
        metrics.add_metric("Count1", 1)
        metrics.flush()

        assert len(directive(rec.last)["Dimensions"][0]) == MAX_DIMENSION_KEYS

    def test_上限を超えると拒否する(self) -> None:
        metrics, _ = make_metrics()
        with pytest.raises(ValueError, match=str(MAX_DIMENSION_KEYS)):
            metrics.set_dimensions(
                **{f"D{i}": str(i) for i in range(MAX_DIMENSION_KEYS + 1)}
            )

    def test_既定ディメンションを含めて上限を判定する(self) -> None:
        metrics, _ = make_metrics(**{f"B{i}": str(i) for i in range(5)})
        with pytest.raises(ValueError, match=str(MAX_DIMENSION_KEYS)):
            metrics.set_dimensions(
                **{f"D{i}": str(i) for i in range(MAX_DIMENSION_KEYS - 4)}
            )

    def test_名前が長すぎると拒否する(self) -> None:
        metrics, _ = make_metrics()
        with pytest.raises(ValueError, match="250"):
            metrics.add_dimension("D" * 251, "x")

    def test_値が長すぎると拒否する(self) -> None:
        metrics, _ = make_metrics()
        with pytest.raises(ValueError, match="1024"):
            metrics.add_dimension("D", "v" * 1025)

    def test_メトリクス名と重複すると拒否する(self) -> None:
        metrics, _ = make_metrics()
        metrics.set_dimensions(Latency="x")
        metrics.add_metric("Latency", 1)
        with pytest.raises(ValueError, match="重複"):
            metrics.flush()


# ── 値の検証 ───────────────────────────────────────────────


class TestValueValidation:
    def test_整数と浮動小数は受け付ける(self) -> None:
        metrics, rec = make_metrics()
        metrics.add_metric("I", 1)
        metrics.add_metric("F", 1.5)
        metrics.flush()

        assert rec.last["I"] == 1
        assert rec.last["F"] == 1.5

    def test_Decimal_は_float_に変換する(self) -> None:
        metrics, rec = make_metrics()
        metrics.add_metric("D", Decimal("2.5"))
        metrics.flush()

        assert rec.last["D"] == 2.5

    def test_bool_は拒否する(self) -> None:
        metrics, _ = make_metrics()
        with pytest.raises(ValueError, match="bool"):
            metrics.add_metric("B", True)

    def test_文字列は拒否する(self) -> None:
        metrics, _ = make_metrics()
        with pytest.raises(ValueError, match="数値"):
            metrics.add_metric("S", "1")

    def test_None_は拒否する(self) -> None:
        metrics, _ = make_metrics()
        with pytest.raises(ValueError, match="数値"):
            metrics.add_metric("N", None)

    @pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf])
    def test_NaN_と_Infinity_は拒否する(self, value: float) -> None:
        metrics, _ = make_metrics()
        with pytest.raises(ValueError, match="NaN"):
            metrics.add_metric("X", value)

    def test_名前が空だと拒否する(self) -> None:
        metrics, _ = make_metrics()
        with pytest.raises(ValueError, match="空にできません"):
            metrics.add_metric("", 1)

    def test_予約キーは名前に使えない(self) -> None:
        metrics, _ = make_metrics()
        with pytest.raises(ValueError, match=RESERVED_ROOT_KEY):
            metrics.add_metric(RESERVED_ROOT_KEY, 1)

    def test_名前が長すぎると拒否する(self) -> None:
        metrics, _ = make_metrics()
        with pytest.raises(ValueError, match="1024"):
            metrics.add_metric("M" * 1025, 1)

    def test_同名で単位が違うと拒否する(self) -> None:
        metrics, _ = make_metrics()
        metrics.add_metric("Latency", 1, unit="Milliseconds")
        with pytest.raises(ValueError, match="単位が一致しません"):
            metrics.add_metric("Latency", 2, unit="Seconds")


# ── 検証関数の単体 ─────────────────────────────────────────


class TestValidators:
    def test_名前空間が空だと拒否する(self) -> None:
        with pytest.raises(ValueError, match="空にできません"):
            validate_namespace("")

    def test_名前空間が空白だけでも拒否する(self) -> None:
        with pytest.raises(ValueError, match="空にできません"):
            validate_namespace("   ")

    def test_名前空間が長すぎると拒否する(self) -> None:
        with pytest.raises(ValueError, match="1024"):
            validate_namespace("N" * 1025)

    def test_有効な名前空間はそのまま返す(self) -> None:
        assert validate_namespace("MyApp") == "MyApp"

    @pytest.mark.parametrize("unit", sorted(VALID_UNITS))
    def test_公式の単位はすべて受け付ける(self, unit: str) -> None:
        assert validate_unit(unit) == unit

    def test_単位の_None_は既定値になる(self) -> None:
        assert validate_unit(None) == "None"

    def test_無効な単位は拒否する(self) -> None:
        with pytest.raises(ValueError, match="無効です"):
            validate_unit("Millisecond")

    def test_単位は大文字小文字を区別する(self) -> None:
        with pytest.raises(ValueError, match="無効です"):
            validate_unit("milliseconds")

    @pytest.mark.parametrize("resolution", [1, 60])
    def test_有効な解像度を受け付ける(self, resolution: int) -> None:
        assert validate_storage_resolution(resolution) == resolution

    @pytest.mark.parametrize("resolution", [0, 30, 61, -1])
    def test_無効な解像度は拒否する(self, resolution: int) -> None:
        with pytest.raises(ValueError, match="storage_resolution"):
            validate_storage_resolution(resolution)


# ── 上限到達時の自動 flush ─────────────────────────────────


class TestAutoFlush:
    def test_メトリクス数が上限を超えると自動で_flush_する(self) -> None:
        metrics, rec = make_metrics()
        for i in range(MAX_METRICS_PER_DOCUMENT + 1):
            metrics.add_metric(f"M{i}", 1)

        # 101 個目の追加時点で 1 通目が出力されている
        assert len(rec.lines) == 1
        assert len(directive(rec.last)["Metrics"]) == MAX_METRICS_PER_DOCUMENT

        metrics.flush()
        assert len(rec.lines) == 2
        assert len(directive(rec.last)["Metrics"]) == 1

    def test_上限ちょうどでは_flush_しない(self) -> None:
        metrics, rec = make_metrics()
        for i in range(MAX_METRICS_PER_DOCUMENT):
            metrics.add_metric(f"M{i}", 1)

        assert rec.lines == []

    def test_値配列が上限を超えると自動で_flush_する(self) -> None:
        metrics, rec = make_metrics()
        for _ in range(MAX_VALUES_PER_METRIC + 1):
            metrics.add_metric("Latency", 1, unit="Milliseconds")

        assert len(rec.lines) == 1
        assert len(rec.last["Latency"]) == MAX_VALUES_PER_METRIC

        metrics.flush()
        assert rec.last["Latency"] == 1

    def test_自動_flush_後も既定ディメンションは残る(self) -> None:
        metrics, rec = make_metrics(Environment="dev")
        for _ in range(MAX_VALUES_PER_METRIC + 1):
            metrics.add_metric("Latency", 1, unit="Milliseconds")
        metrics.flush()

        for doc in rec.documents:
            assert doc["Environment"] == "dev"


# ── flush の挙動 ───────────────────────────────────────────


class TestFlush:
    def test_メトリクスが無ければ何も出力しない(self) -> None:
        metrics, rec = make_metrics()
        assert metrics.flush() == []
        assert rec.lines == []

    def test_プロパティだけでも出力しない(self) -> None:
        metrics, rec = make_metrics()
        metrics.set_property("request_id", "abc")
        assert metrics.flush() == []
        assert rec.lines == []

    def test_flush_後はバッファが空になる(self) -> None:
        metrics, rec = make_metrics()
        metrics.add_metric("Count1", 1)
        metrics.flush()
        metrics.flush()

        assert len(rec.lines) == 1

    def test_戻り値は出力した行と一致する(self) -> None:
        metrics, rec = make_metrics()
        metrics.add_metric("Count1", 1)
        lines = metrics.flush()

        assert lines == rec.lines

    def test_無効化するとメトリクスを出力しない(self) -> None:
        metrics, rec = make_metrics(enabled=False)
        metrics.add_metric("Count1", 1)

        assert metrics.flush() == []
        assert rec.lines == []

    def test_無効化してもバッファは溜まり続けない(self) -> None:
        metrics, _ = make_metrics(enabled=False)
        for i in range(MAX_METRICS_PER_DOCUMENT + 10):
            metrics.add_metric(f"M{i}", 1)
        metrics.flush()

        # 内部バッファがクリアされていれば次の追加が 1 件目になる
        metrics.enabled = True
        metrics.add_metric("Only", 1)
        assert len(metrics.flush()) == 1


# ── timer ──────────────────────────────────────────────────


class TestTimer:
    def test_所要時間をミリ秒で記録する(self) -> None:
        metrics, rec = make_metrics()
        ticks = iter([1.0, 1.25])
        with metrics.timer("ProcessingLatency", clock=lambda: next(ticks)):
            pass
        metrics.flush()

        assert rec.last["ProcessingLatency"] == pytest.approx(250.0)
        assert directive(rec.last)["Metrics"][0]["Unit"] == "Milliseconds"

    def test_秒単位も指定できる(self) -> None:
        metrics, rec = make_metrics()
        ticks = iter([0.0, 2.0])
        with metrics.timer("Elapsed", unit="Seconds", clock=lambda: next(ticks)):
            pass
        metrics.flush()

        assert rec.last["Elapsed"] == pytest.approx(2.0)

    def test_例外が起きても計測してから送出する(self) -> None:
        metrics, rec = make_metrics()
        ticks = iter([0.0, 0.5])
        with pytest.raises(RuntimeError):
            with metrics.timer("ProcessingLatency", clock=lambda: next(ticks)):
                raise RuntimeError("失敗")
        metrics.flush()

        assert rec.last["ProcessingLatency"] == pytest.approx(500.0)


# ── コンテキストマネージャ ─────────────────────────────────


class TestContextManager:
    def test_抜けるときに_flush_する(self) -> None:
        recorder = Recorder()
        with create_metrics(
            "TestApp", sink=recorder, now_ms=lambda: FIXED_NOW_MS
        ) as metrics:
            metrics.add_metric("Count1", 1)

        assert len(recorder.lines) == 1

    def test_例外で抜けても_flush_する(self) -> None:
        recorder = Recorder()
        with pytest.raises(RuntimeError):
            with create_metrics(
                "TestApp", sink=recorder, now_ms=lambda: FIXED_NOW_MS
            ) as metrics:
                metrics.add_metric("Count1", 1)
                raise RuntimeError("失敗")

        assert len(recorder.lines) == 1


# ── ファクトリ ─────────────────────────────────────────────


class TestFactories:
    def test_環境変数から名前空間を読む(self) -> None:
        metrics = create_metrics_from_env({"METRICS_NAMESPACE": "FromEnv"})
        assert metrics.namespace == "FromEnv"

    def test_未設定なら既定の名前空間を使う(self) -> None:
        metrics = create_metrics_from_env({})
        assert metrics.namespace == DEFAULT_NAMESPACE

    def test_空文字なら既定の名前空間を使う(self) -> None:
        metrics = create_metrics_from_env({"METRICS_NAMESPACE": ""})
        assert metrics.namespace == DEFAULT_NAMESPACE

    @pytest.mark.parametrize("value", ["false", "FALSE", "0", "no", "off", " Off "])
    def test_明示的な否定語で無効化する(self, value: str) -> None:
        metrics = create_metrics_from_env({"METRICS_ENABLED": value})
        assert metrics.enabled is False

    @pytest.mark.parametrize("value", ["true", "1", "yes", "", "maybe"])
    def test_それ以外は有効のままにする(self, value: str) -> None:
        # 未知の値で黙って無効化されるとメトリクスが消えるため
        metrics = create_metrics_from_env({"METRICS_ENABLED": value})
        assert metrics.enabled is True

    def test_既定ディメンションを渡せる(self) -> None:
        metrics = create_metrics_from_env({}, Environment="dev")
        assert metrics.default_dimensions == {"Environment": "dev"}

    def test_不正な名前空間は生成時に落ちる(self) -> None:
        with pytest.raises(ValueError, match="空にできません"):
            create_metrics("")


# ── リトライとの連携 ───────────────────────────────────────


class TestRetryMetrics:
    def test_リトライ回数をカウントする(self) -> None:
        metrics, rec = make_metrics()
        hook = retry_metrics(metrics, "Bedrock.InvokeModel")

        hook(1, 0.1, ValueError("一時エラー"))
        hook(2, 0.2, ValueError("一時エラー"))
        metrics.flush()

        assert rec.last["RetryAttempts"] == [1, 1]

    def test_待機時間をミリ秒で記録する(self) -> None:
        metrics, rec = make_metrics()
        hook = retry_metrics(metrics, "Bedrock.InvokeModel")

        hook(1, 0.25, ValueError("x"))
        metrics.flush()

        assert rec.last["RetryDelay"] == pytest.approx(250.0)

    def test_操作名と例外型はプロパティに残す(self) -> None:
        metrics, rec = make_metrics()
        hook = retry_metrics(metrics, "Bedrock.InvokeModel")

        hook(1, 0.1, TimeoutError("遅い"))
        metrics.flush()

        doc = rec.last
        assert doc["retry_operation"] == "Bedrock.InvokeModel"
        assert doc["retry_last_error"] == "TimeoutError"
        assert doc["retry_attempt"] == 1

    def test_操作名はディメンションにしない(self) -> None:
        # ディメンションにすると呼び出し箇所の数だけカスタムメトリクスが増える
        metrics, rec = make_metrics()
        hook = retry_metrics(metrics, "Bedrock.InvokeModel")

        hook(1, 0.1, ValueError("x"))
        metrics.flush()

        assert "retry_operation" not in directive(rec.last)["Dimensions"][0]

    def test_メトリクス名を差し替えられる(self) -> None:
        metrics, rec = make_metrics()
        hook = retry_metrics(metrics, "DDB.PutItem", metric_name="DdbRetries")

        hook(1, 0.1, ValueError("x"))
        metrics.flush()

        assert "DdbRetries" in rec.last

    def test_retry_call_の_on_retry_として渡せる(self) -> None:
        # フックのシグネチャが retry.py 側と噛み合っていることを実際に呼んで確かめる
        from botocore.exceptions import ClientError
        from retry import RetryConfig, retry_call

        metrics, rec = make_metrics()
        attempts = {"count": 0}

        def flaky() -> str:
            attempts["count"] += 1
            if attempts["count"] < 3:
                raise ClientError(
                    {"Error": {"Code": "ThrottlingException", "Message": "slow down"}},
                    "TestOperation",
                )
            return "ok"

        result = retry_call(
            flaky,
            config=RetryConfig(max_attempts=3, base_delay=0.001, max_delay=0.001),
            on_retry=retry_metrics(metrics, "Flaky"),
            sleep=lambda _s: None,
        )
        metrics.flush()

        assert result == "ok"
        assert rec.last["RetryAttempts"] == [1, 1]
        assert rec.last["retry_last_error"] == "ClientError"


# ── 低レベル関数 ───────────────────────────────────────────


class TestLowLevel:
    def test_MetricEntry_は単一値をそのまま返す(self) -> None:
        entry = MetricEntry(name="M", values=(1,))
        assert entry.target_value() == 1

    def test_MetricEntry_は複数値を配列で返す(self) -> None:
        entry = MetricEntry(name="M", values=(1, 2))
        assert entry.target_value() == [1, 2]

    def test_build_emf_document_は_Timestamp_を反映する(self) -> None:
        doc = build_emf_document(
            namespace="NS",
            metrics={"M": MetricEntry(name="M", values=(1,))},
            dimensions={},
            properties={},
            timestamp_ms=123,
        )
        assert doc[RESERVED_ROOT_KEY]["Timestamp"] == 123

    def test_build_emf_document_は予約キーのプロパティを拒否する(self) -> None:
        with pytest.raises(ValueError, match=RESERVED_ROOT_KEY):
            build_emf_document(
                namespace="NS",
                metrics={},
                dimensions={},
                properties={RESERVED_ROOT_KEY: 1},
                timestamp_ms=123,
            )

    def test_serialize_document_は区切り文字を詰める(self) -> None:
        line = serialize_document({"a": 1, "b": 2})
        assert line == '{"a":1,"b":2}'

    def test_serialize_document_は未知の型を文字列にする(self) -> None:
        class Custom:
            def __str__(self) -> str:
                return "custom"

        line = serialize_document({"a": Custom()})
        assert json.loads(line) == {"a": "custom"}

    def test_既定の解像度は60である(self) -> None:
        assert DEFAULT_STORAGE_RESOLUTION == 60

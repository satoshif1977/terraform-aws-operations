"""
構造化ロギングユーティリティ

CloudWatch Logs Insights で検索・集計できるよう、ログを 1 行の JSON として出力する。
あわせて、パスワードやトークンなどの機密情報がログに流出しないようマスキングする。

同ディレクトリの retry.py と同じ「AWS 呼び出しの運用品質を揃える」方針のユーティリティで、
retry_logger() を retry_call の on_retry に渡して結線できる。
同リポジトリの TypeScript 版（lambda_ts/streams-alert/logger.ts）および
Go 版（lambda_go/guardduty-notifier/logger.go）と並置する 3 言語目。

設計方針:
  - now / sink を注入可能にして、テストを決定的に保つ（時刻と出力先を固定できる）
  - 機密キーは「キー名の部分一致」で判定する。列挙漏れがあっても
    accessKeyId / x-api-key のような派生名を拾えるようにするため
  - 循環参照・巨大オブジェクトでログ出力自体が落ちないよう、深さと要素数に上限を設ける
    （ログは失敗してはいけない副次処理なので、欠落させてでも本処理を止めない）
  - 例外は型名・メッセージ・トレースバックに展開する。json.dumps がそのままでは
    扱えず、障害調査で最も必要な情報が消えるため

使い方:
    log = create_logger_from_env()
    req_log = log.child(request_id=context.aws_request_id)
    req_log.info("処理を開始しました", item_id=item_id, password="p@ss")
    # → {"request_id":"...","item_id":"...","password":"[REDACTED]", ...}
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field, replace
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any, TextIO

# ── ログレベル ─────────────────────────────────────────────

LOG_LEVELS: tuple[str, ...] = ("debug", "info", "warn", "error", "silent")

#: 出力先を持つ実レベル（silent は出力しないため除く）
EMITTABLE_LEVELS: tuple[str, ...] = ("debug", "info", "warn", "error")

#: レベルの重み。silent は全出力を止める番人として最大値を持つ
_LEVEL_WEIGHT: dict[str, int] = {
    "debug": 10,
    "info": 20,
    "warn": 30,
    "error": 40,
    "silent": 100,
}

DEFAULT_LOG_LEVEL = "info"

#: 別名（Lambda の環境変数では WARNING / FATAL といった表記も使われる）
_LEVEL_ALIASES: dict[str, str] = {
    "warning": "warn",
    "fatal": "error",
    "critical": "error",
    "trace": "debug",
    "verbose": "debug",
    "none": "silent",
    "off": "silent",
}


def parse_log_level(value: str | None, fallback: str = DEFAULT_LOG_LEVEL) -> str:
    """文字列をログレベルに変換する。

    未知の値・未設定は fallback にフォールバックする。
    環境変数の指定ミスでログが全く出なくなる事故を避けるため、例外は送出しない。
    """
    if not isinstance(value, str):
        return fallback
    normalized = value.strip().lower()
    if normalized in _LEVEL_ALIASES:
        return _LEVEL_ALIASES[normalized]
    return normalized if normalized in LOG_LEVELS else fallback


def should_log(current_level: str, entry_level: str) -> bool:
    """entry_level のログを current_level の設定下で出力すべきか判定する。"""
    if current_level == "silent":
        return False
    current = _LEVEL_WEIGHT.get(current_level, _LEVEL_WEIGHT[DEFAULT_LOG_LEVEL])
    entry = _LEVEL_WEIGHT.get(entry_level)
    return entry is not None and entry >= current


# ── 機密情報のマスキング ───────────────────────────────────

#: マスキング対象のキー名（小文字・部分一致で判定する）
#: 例: "secret" は "clientSecret" / "SECRET_KEY" にもマッチする
SENSITIVE_KEY_PATTERNS: tuple[str, ...] = (
    "password",
    "passwd",
    "secret",
    "token",
    "authorization",
    "auth",
    "apikey",
    "api_key",
    "accesskey",
    "access_key",
    "privatekey",
    "private_key",
    "credential",
    "cookie",
    "session",
    "signature",
    "pin",
    "ssn",
    "creditcard",
    "card_number",
)

#: マスク後に表示される文字列
REDACTED = "[REDACTED]"

#: 循環参照を検出した箇所に入る印
CIRCULAR = "[Circular]"

#: 深さ・要素数の上限を超えて切り詰めた箇所に入る印
TRUNCATED = "[Truncated]"

_STRIP_CHARS = str.maketrans("", "", "-_ ")


def _normalize_key(key: str) -> str:
    """記号（- _ 空白）を除いた小文字表現にする。"""
    return key.lower().translate(_STRIP_CHARS)


def is_sensitive_key(key: str, extra_keys: tuple[str, ...] = ()) -> bool:
    """キー名が機密情報にあたるか判定する。

    記号を除いた小文字表現で部分一致を見るため、
    "access-key" / "access_key" / "AccessKey" をまとめて拾える。
    """
    normalized_key = _normalize_key(key)
    if not normalized_key:
        return False
    for pattern in (*SENSITIVE_KEY_PATTERNS, *extra_keys):
        normalized_pattern = _normalize_key(pattern)
        if normalized_pattern and normalized_pattern in normalized_key:
            return True
    return False


@dataclass(frozen=True)
class RedactOptions:
    """マスキング・切り詰めの設定。"""

    #: 追加のマスキング対象キー（部分一致・大文字小文字は無視）
    extra_keys: tuple[str, ...] = ()
    #: ネストをたどる最大深さ
    max_depth: int = 8
    #: シーケンス/マッピングを保持する最大要素数
    max_items: int = 100
    #: 文字列を保持する最大文字数
    max_string_length: int = 2000


DEFAULT_REDACT_OPTIONS = RedactOptions()


def redact(value: Any, options: RedactOptions = DEFAULT_REDACT_OPTIONS) -> Any:
    """ログ出力用に値を安全な形へ変換する。

    - 機密キーの値を [REDACTED] に置換する
    - 循環参照・深すぎるネスト・多すぎる要素・長すぎる文字列を切り詰める
    - 例外 / datetime / Decimal / bytes / set など json が扱えない値を展開する

    入力オブジェクトは変更しない（新しい値を返す）。
    """
    # 「現在たどっている経路」を id で保持する。経路を抜けるときに削除するため、
    # 兄弟位置で同じオブジェクトを参照しても [Circular] にはならない
    # （本物の循環＝自分の祖先を再訪した場合だけを検出する）。
    seen: set[int] = set()

    def walk(node: Any, depth: int, key: str | None = None) -> Any:
        if key is not None and is_sensitive_key(key, options.extra_keys):
            return REDACTED

        if node is None or isinstance(node, bool):
            return node

        if isinstance(node, str):
            if len(node) > options.max_string_length:
                return f"{node[: options.max_string_length]}…{TRUNCATED}"
            return node

        if isinstance(node, int):
            return node

        if isinstance(node, float):
            # NaN / Infinity は JSON として不正なので文字列で残す
            return node if _is_finite(node) else repr(node)

        if isinstance(node, Decimal):
            # DynamoDB は数値を Decimal で返す。集計できるよう数値のまま出す
            return float(node) if node.is_finite() else str(node)

        if isinstance(node, bytes | bytearray):
            # 中身は機密の可能性があるため長さだけ残す
            return f"[bytes: {len(node)}]"

        if isinstance(node, BaseException):
            return _describe_exception(node)

        if isinstance(node, datetime | date):
            return node.isoformat()

        node_id = id(node)
        if node_id in seen:
            return CIRCULAR
        if depth >= options.max_depth:
            return TRUNCATED

        seen.add(node_id)
        try:
            if isinstance(node, Mapping):
                result: dict[str, Any] = {}
                for index, (raw_key, raw_value) in enumerate(node.items()):
                    if index >= options.max_items:
                        result[TRUNCATED] = f"残り {len(node) - options.max_items} 件"
                        break
                    name = str(raw_key)
                    result[name] = walk(raw_value, depth + 1, name)
                return result

            if isinstance(node, list | tuple | set | frozenset):
                items = list(node)
                kept = [walk(item, depth + 1) for item in items[: options.max_items]]
                if len(items) > options.max_items:
                    kept.append(
                        f"{TRUNCATED}（残り {len(items) - options.max_items} 件）"
                    )
                return kept

            # dataclass や独自クラスは __dict__ があれば展開する
            attributes = getattr(node, "__dict__", None)
            if isinstance(attributes, dict) and attributes:
                return {
                    name: walk(item, depth + 1, name)
                    for name, item in attributes.items()
                }

            return repr(node)
        finally:
            seen.discard(node_id)

    return walk(value, 0)


def _is_finite(value: float) -> bool:
    """NaN / Infinity でないことを判定する（math を import せずに済ませる）。"""
    return value == value and value not in (float("inf"), float("-inf"))


def _describe_exception(exc: BaseException) -> dict[str, Any]:
    """例外を型名・メッセージ・トレースバックに展開する。"""
    described: dict[str, Any] = {
        "type": type(exc).__name__,
        "message": str(exc),
    }
    if exc.__traceback__ is not None:
        described["stack"] = "".join(
            traceback.format_exception(type(exc), exc, exc.__traceback__)
        ).strip()
    return described


# ── ログエントリの組み立て ─────────────────────────────────

#: context から上書きできない予約フィールド
#: （検索クエリの前提が崩れると Logs Insights の集計が壊れるため）
RESERVED_FIELDS: tuple[str, ...] = ("timestamp", "level", "message")


def build_log_entry(
    level: str,
    message: str,
    context: Mapping[str, Any] | None = None,
    *,
    base: Mapping[str, Any] | None = None,
    now: Callable[[], datetime] | None = None,
    options: RedactOptions = DEFAULT_REDACT_OPTIONS,
) -> dict[str, Any]:
    """ログエントリを組み立てる。

    timestamp / level / message は予約フィールドで、context 側からは上書きできない。
    """
    merged: dict[str, Any] = {**(base or {}), **(context or {})}
    safe = redact(merged, options)
    if not isinstance(safe, dict):  # pragma: no cover - merged は必ず dict
        safe = {}

    timestamp = (now or _utc_now)()
    # 予約フィールドは最後に置いて必ず勝たせる
    return {
        **safe,
        "timestamp": timestamp.isoformat(),
        "level": level,
        "message": message,
    }


def _utc_now() -> datetime:
    """既定のタイムスタンプ生成（UTC）。"""
    return datetime.now(UTC)


def format_log_entry(entry: Mapping[str, Any]) -> str:
    """ログエントリを 1 行の JSON 文字列にする。

    何らかの理由で JSON 化に失敗しても、ログ処理で本処理を落とさないよう
    最低限の情報を持つフォールバック行を返す。
    """
    try:
        return json.dumps(entry, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return json.dumps(
            {
                "timestamp": str(entry.get("timestamp", "")),
                "level": str(entry.get("level", "error")),
                "message": str(entry.get("message", "")),
                "logError": "ログのシリアライズに失敗しました",
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )


# ── ロガー本体 ─────────────────────────────────────────────

#: 出力先。(1 行の JSON, レベル) を受け取る
LogSink = Callable[[str, str], None]


def stdout_sink(line: str, level: str) -> None:
    """既定の出力先。

    CloudWatch Logs は標準出力をそのまま取り込むため print で十分だが、
    error / warn は標準エラーに分けて、ローカル実行時に見分けられるようにする。
    """
    stream: TextIO = sys.stderr if level in ("warn", "error") else sys.stdout
    print(line, file=stream)


@dataclass(frozen=True)
class StructuredLogger:
    """1 行 JSON を出力する構造化ロガー。

    frozen なので child() は常に新しいインスタンスを返し、親には影響しない。
    """

    level: str = DEFAULT_LOG_LEVEL
    base: Mapping[str, Any] = field(default_factory=dict)
    sink: LogSink = stdout_sink
    now: Callable[[], datetime] | None = None
    options: RedactOptions = DEFAULT_REDACT_OPTIONS

    def log(self, level: str, message: str, **context: Any) -> None:
        """レベルを指定してログを出力する。"""
        if not should_log(self.level, level):
            return
        entry = build_log_entry(
            level,
            message,
            context,
            base=self.base,
            now=self.now,
            options=self.options,
        )
        self.sink(format_log_entry(entry), level)

    def debug(self, message: str, **context: Any) -> None:
        self.log("debug", message, **context)

    def info(self, message: str, **context: Any) -> None:
        self.log("info", message, **context)

    def warn(self, message: str, **context: Any) -> None:
        self.log("warn", message, **context)

    #: stdlib logging と揃えたい場合のための別名
    warning = warn

    def error(self, message: str, **context: Any) -> None:
        self.log("error", message, **context)

    def child(self, **base: Any) -> StructuredLogger:
        """共通フィールドを追加した子ロガーを返す（親は変更しない）。"""
        return replace(self, base={**self.base, **base})


def create_logger(
    *,
    level: str = DEFAULT_LOG_LEVEL,
    base: Mapping[str, Any] | None = None,
    sink: LogSink = stdout_sink,
    now: Callable[[], datetime] | None = None,
    options: RedactOptions = DEFAULT_REDACT_OPTIONS,
) -> StructuredLogger:
    """構造化ロガーを生成する。"""
    return StructuredLogger(
        level=level,
        base=dict(base or {}),
        sink=sink,
        now=now,
        options=options,
    )


def create_logger_from_env(
    env: Mapping[str, str] | None = None,
    **kwargs: Any,
) -> StructuredLogger:
    """環境変数 LOG_LEVEL からロガーを組み立てる。

    未設定なら info で動作する。
    """
    source = os.environ if env is None else env
    fallback = kwargs.pop("level", DEFAULT_LOG_LEVEL)
    return create_logger(
        level=parse_log_level(source.get("LOG_LEVEL"), fallback), **kwargs
    )


# ── リトライとの連携 ───────────────────────────────────────


def retry_logger(
    logger: StructuredLogger,
    operation: str,
) -> Callable[[int, float, BaseException], None]:
    """retry.py の retry_call(on_retry=...) に渡せるコールバックを作る。

    リトライは「起きていること自体は正常だが、頻発したら異常」という事象なので
    warn で構造化して残し、Logs Insights で件数を追えるようにする。
    """

    def on_retry(attempt: int, delay_seconds: float, exc: BaseException) -> None:
        logger.warn(
            "AWS API 呼び出しをリトライします",
            operation=operation,
            attempt=attempt,
            delay_seconds=round(delay_seconds, 3),
            error=exc,
        )

    return on_retry

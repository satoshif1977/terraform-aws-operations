"""
logger.py ユニットテスト

now / sink を注入して、時刻と出力先を固定したうえで決定的に検証する。
"""

from __future__ import annotations

import json
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

import pytest
from logger import (
    CIRCULAR,
    DEFAULT_LOG_LEVEL,
    DEFAULT_REDACT_OPTIONS,
    EMITTABLE_LEVELS,
    LOG_LEVELS,
    REDACTED,
    RESERVED_FIELDS,
    SENSITIVE_KEY_PATTERNS,
    TRUNCATED,
    RedactOptions,
    build_log_entry,
    create_logger,
    create_logger_from_env,
    format_log_entry,
    is_sensitive_key,
    parse_log_level,
    redact,
    retry_logger,
    should_log,
    stdout_sink,
)

# ── テスト用ヘルパー ───────────────────────────────────────

FIXED_ISO = "2026-09-07T00:00:00+00:00"


def fixed_now() -> datetime:
    """固定時刻を返す now。"""
    return datetime(2026, 9, 7, tzinfo=UTC)


class Recorder:
    """出力行を溜め込むシンク。"""

    def __init__(self) -> None:
        self.lines: list[str] = []
        self.levels: list[str] = []

    def __call__(self, line: str, level: str) -> None:
        self.lines.append(line)
        self.levels.append(level)

    @property
    def entries(self) -> list[dict[str, Any]]:
        return [json.loads(line) for line in self.lines]


@pytest.fixture
def recorder() -> Recorder:
    return Recorder()


def make_logger(recorder: Recorder, level: str = "debug", **kwargs: Any):
    """テスト用の決定的なロガーを作る。"""
    return create_logger(level=level, sink=recorder, now=fixed_now, **kwargs)


# ── parse_log_level ────────────────────────────────────────


@pytest.mark.parametrize("level", LOG_LEVELS)
def test_正規のレベルをそのまま解釈する(level: str) -> None:
    assert parse_log_level(level) == level


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("DEBUG", "debug"),
        ("Info", "info"),
        ("  warn  ", "warn"),
        ("ERROR", "error"),
    ],
)
def test_大文字と空白を正規化する(value: str, expected: str) -> None:
    assert parse_log_level(value) == expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("warning", "warn"),
        ("fatal", "error"),
        ("critical", "error"),
        ("trace", "debug"),
        ("verbose", "debug"),
        ("none", "silent"),
        ("off", "silent"),
    ],
)
def test_別名を解釈する(value: str, expected: str) -> None:
    assert parse_log_level(value) == expected


@pytest.mark.parametrize("value", [None, "", "   ", "unknown", "12345", 42, object()])
def test_未知の値は既定値にフォールバックする(value: Any) -> None:
    assert parse_log_level(value) == DEFAULT_LOG_LEVEL


def test_fallback_を明示指定できる() -> None:
    assert parse_log_level("なにこれ", "error") == "error"


# ── should_log ─────────────────────────────────────────────


@pytest.mark.parametrize(
    ("current", "entry", "expected"),
    [
        ("debug", "debug", True),
        ("debug", "error", True),
        ("info", "debug", False),
        ("info", "info", True),
        ("warn", "info", False),
        ("warn", "warn", True),
        ("error", "warn", False),
        ("error", "error", True),
        ("silent", "debug", False),
        ("silent", "error", False),
    ],
)
def test_レベル判定(current: str, entry: str, expected: bool) -> None:
    assert should_log(current, entry) is expected


def test_silent_はすべての出力を止める() -> None:
    assert not any(should_log("silent", level) for level in EMITTABLE_LEVELS)


def test_未知のレベル指定でも例外にならない() -> None:
    assert should_log("でたらめ", "error") is True
    assert should_log("info", "でたらめ") is False


# ── is_sensitive_key ───────────────────────────────────────


@pytest.mark.parametrize("key", SENSITIVE_KEY_PATTERNS)
def test_既定パターンを機密と判定する(key: str) -> None:
    assert is_sensitive_key(key) is True


@pytest.mark.parametrize(
    "key",
    [
        "password",
        "userPassword",
        "PASSWORD",
        "access-key",
        "access_key",
        "AccessKeyId",
        "x-api-key",
        "clientSecret",
        "Authorization",
        "refreshToken",
        "session_id",
        "Set-Cookie",
    ],
)
def test_派生名も部分一致で拾う(key: str) -> None:
    assert is_sensitive_key(key) is True


@pytest.mark.parametrize(
    "key", ["item_id", "name", "count", "created_at", "message", ""]
)
def test_通常のキーは機密ではない(key: str) -> None:
    assert is_sensitive_key(key) is False


def test_追加キーを指定できる() -> None:
    assert is_sensitive_key("myCompanyId") is False
    assert is_sensitive_key("myCompanyId", ("companyId",)) is True


def test_空文字の追加キーは全件マッチを起こさない() -> None:
    assert is_sensitive_key("item_id", ("",)) is False


# ── redact ─────────────────────────────────────────────────


def test_機密キーの値をマスクする() -> None:
    assert redact({"user_id": "u1", "password": "p@ss"}) == {
        "user_id": "u1",
        "password": REDACTED,
    }


def test_ネストした機密キーもマスクする() -> None:
    result = redact(
        {"request": {"headers": {"authorization": "Bearer x"}, "path": "/items"}}
    )
    assert result["request"]["headers"]["authorization"] == REDACTED
    assert result["request"]["path"] == "/items"


def test_リストの中の機密キーもマスクする() -> None:
    result = redact({"users": [{"name": "a", "token": "t1"}]})
    assert result["users"][0] == {"name": "a", "token": REDACTED}


def test_入力オブジェクトを変更しない() -> None:
    source = {"password": "secret", "nested": {"token": "t"}}
    snapshot = json.dumps(source, sort_keys=True)
    redact(source)
    assert json.dumps(source, sort_keys=True) == snapshot


def test_循環参照を検出する() -> None:
    node: dict[str, Any] = {"name": "root"}
    node["self"] = node
    result = redact(node)
    assert result["name"] == "root"
    assert result["self"] == CIRCULAR


def test_兄弟位置での同一オブジェクト参照は循環扱いしない() -> None:
    shared = {"id": 1}
    result = redact({"a": shared, "b": shared})
    assert result["a"] == {"id": 1}
    assert result["b"] == {"id": 1}


def test_深さ上限で切り詰める() -> None:
    deep = {"l1": {"l2": {"l3": {"l4": "値"}}}}
    result = redact(deep, RedactOptions(max_depth=2))
    assert result["l1"]["l2"] == TRUNCATED


def test_リストの要素数上限で切り詰める() -> None:
    result = redact({"items": [1, 2, 3, 4, 5]}, RedactOptions(max_items=2))
    assert result["items"][:2] == [1, 2]
    assert "残り 3 件" in result["items"][2]


def test_辞書の要素数上限で切り詰める() -> None:
    source = {f"k{i}": i for i in range(5)}
    result = redact(source, RedactOptions(max_items=2))
    assert len(result) == 3
    assert "残り 3 件" in result[TRUNCATED]


def test_文字列の長さ上限で切り詰める() -> None:
    result = redact({"body": "あ" * 50}, RedactOptions(max_string_length=10))
    assert result["body"].startswith("あ" * 10)
    assert TRUNCATED in result["body"]


def test_例外を型名とメッセージに展開する() -> None:
    try:
        raise ValueError("失敗しました")
    except ValueError as exc:
        result = redact({"error": exc})
    assert result["error"]["type"] == "ValueError"
    assert result["error"]["message"] == "失敗しました"
    assert "ValueError" in result["error"]["stack"]


def test_送出されていない例外はスタックを持たない() -> None:
    result = redact({"error": RuntimeError("未送出")})
    assert result["error"] == {"type": "RuntimeError", "message": "未送出"}


def test_datetime_を_ISO_文字列にする() -> None:
    assert redact({"at": fixed_now()}) == {"at": FIXED_ISO}


def test_date_を_ISO_文字列にする() -> None:
    assert redact({"on": date(2026, 9, 7)}) == {"on": "2026-09-07"}


def test_Decimal_を数値にする() -> None:
    assert redact({"amount": Decimal("1.5")}) == {"amount": 1.5}


def test_非有限の_Decimal_を文字列にする() -> None:
    assert redact({"amount": Decimal("NaN")}) == {"amount": "NaN"}


@pytest.mark.parametrize("value", [b"binary", bytearray(b"binary")])
def test_バイト列は長さだけ残す(value: bytes | bytearray) -> None:
    assert redact({"blob": value}) == {"blob": "[bytes: 6]"}


def test_集合をリストにする() -> None:
    assert sorted(redact({"tags": {"a", "b"}})["tags"]) == ["a", "b"]


def test_タプルをリストにする() -> None:
    assert redact({"pair": (1, 2)}) == {"pair": [1, 2]}


@pytest.mark.parametrize(
    ("value", "expected"),
    [(None, None), (True, True), (False, False), (0, 0), ("文字列", "文字列")],
)
def test_プリミティブはそのまま返す(value: Any, expected: Any) -> None:
    assert redact(value) == expected


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_JSON化できない浮動小数を文字列にする(value: float) -> None:
    assert isinstance(redact({"v": value})["v"], str)


def test_独自クラスを属性辞書に展開しつつマスクする() -> None:
    class Credential:
        def __init__(self) -> None:
            self.user = "u1"
            self.secret = "s1"

    assert redact({"cred": Credential()}) == {
        "cred": {"user": "u1", "secret": REDACTED}
    }


def test_属性を持たないオブジェクトは_repr_にする() -> None:
    assert redact({"v": object()})["v"].startswith("<object object")


def test_既定の上限値が公開されている() -> None:
    assert DEFAULT_REDACT_OPTIONS.max_depth > 0
    assert DEFAULT_REDACT_OPTIONS.max_items > 0
    assert DEFAULT_REDACT_OPTIONS.max_string_length > 0


# ── build_log_entry ────────────────────────────────────────


def test_予約フィールドを必ず持つ() -> None:
    entry = build_log_entry("info", "テスト", now=fixed_now)
    assert entry["timestamp"] == FIXED_ISO
    assert entry["level"] == "info"
    assert entry["message"] == "テスト"


def test_base_と_context_をマージし_context_を優先する() -> None:
    entry = build_log_entry(
        "info",
        "m",
        {"request_id": "後勝ち"},
        base={"request_id": "先", "function_name": "fn"},
        now=fixed_now,
    )
    assert entry["request_id"] == "後勝ち"
    assert entry["function_name"] == "fn"


@pytest.mark.parametrize("field_name", RESERVED_FIELDS)
def test_予約フィールドは_context_から上書きできない(field_name: str) -> None:
    entry = build_log_entry("warn", "本文", {field_name: "乗っ取り"}, now=fixed_now)
    assert entry[field_name] != "乗っ取り"


def test_context_の機密情報をマスクする() -> None:
    assert (
        build_log_entry("info", "m", {"password": "p"}, now=fixed_now)["password"]
        == REDACTED
    )


def test_extra_keys_がマスキングに反映される() -> None:
    entry = build_log_entry(
        "info",
        "m",
        {"company_id": "c1"},
        now=fixed_now,
        options=RedactOptions(extra_keys=("company_id",)),
    )
    assert entry["company_id"] == REDACTED


def test_context_を省略できる() -> None:
    assert build_log_entry("debug", "m")["message"] == "m"


# ── format_log_entry ───────────────────────────────────────


def test_改行を含まない1行のJSONを返す() -> None:
    line = format_log_entry(build_log_entry("info", "複数\n行", now=fixed_now))
    assert "\n" not in line
    assert json.loads(line)["message"] == "複数\n行"


def test_日本語をエスケープせずに出力する() -> None:
    line = format_log_entry(build_log_entry("info", "日本語", now=fixed_now))
    assert "日本語" in line


def test_シリアライズ失敗時にフォールバック行を返す() -> None:
    line = format_log_entry(
        {
            "timestamp": FIXED_ISO,
            "level": "error",
            "message": "壊れた値",
            "bad": object(),
        }
    )
    parsed = json.loads(line)
    assert parsed["message"] == "壊れた値"
    assert parsed["level"] == "error"
    assert "シリアライズ" in parsed["logError"]


# ── StructuredLogger ───────────────────────────────────────


@pytest.mark.parametrize("level", EMITTABLE_LEVELS)
def test_各レベルが_level_フィールドに入る(recorder: Recorder, level: str) -> None:
    getattr(make_logger(recorder), level)("m")
    assert recorder.entries[0]["level"] == level


def test_設定レベル未満のログを出力しない(recorder: Recorder) -> None:
    log = make_logger(recorder, level="warn")
    log.debug("出ない")
    log.info("出ない")
    log.warn("出る")
    log.error("出る")
    assert len(recorder.lines) == 2


def test_silent_では一切出力しない(recorder: Recorder) -> None:
    make_logger(recorder, level="silent").error("出ない")
    assert recorder.lines == []


def test_既定レベルは_info(recorder: Recorder) -> None:
    log = create_logger(sink=recorder, now=fixed_now)
    assert log.level == DEFAULT_LOG_LEVEL
    log.debug("出ない")
    assert recorder.lines == []


def test_sink_にレベルを渡す(recorder: Recorder) -> None:
    log = make_logger(recorder)
    log.warn("w")
    log.error("e")
    assert recorder.levels == ["warn", "error"]


def test_warning_は_warn_の別名(recorder: Recorder) -> None:
    make_logger(recorder).warning("m")
    assert recorder.entries[0]["level"] == "warn"


def test_base_フィールドを全ログに付与する(recorder: Recorder) -> None:
    log = make_logger(recorder, base={"app": "sfn"})
    log.info("a")
    log.error("b")
    assert all(entry["app"] == "sfn" for entry in recorder.entries)


def test_child_が共通フィールドを追加する(recorder: Recorder) -> None:
    make_logger(recorder, base={"app": "sfn"}).child(request_id="r1").info("m")
    entry = recorder.entries[0]
    assert entry["app"] == "sfn"
    assert entry["request_id"] == "r1"


def test_child_が親を変更しない(recorder: Recorder) -> None:
    log = make_logger(recorder)
    log.child(request_id="r1").info("子")
    log.info("親")
    assert recorder.entries[0]["request_id"] == "r1"
    assert "request_id" not in recorder.entries[1]


def test_child_を入れ子にでき後勝ちになる(recorder: Recorder) -> None:
    make_logger(recorder).child(a=1, b=1).child(b=2).info("m")
    entry = recorder.entries[0]
    assert entry["a"] == 1
    assert entry["b"] == 2


def test_child_がレベル設定を引き継ぐ(recorder: Recorder) -> None:
    child = make_logger(recorder, level="error").child(request_id="r1")
    assert child.level == "error"
    child.info("出ない")
    assert recorder.lines == []


def test_stdout_sink_が例外を投げない(capsys: pytest.CaptureFixture[str]) -> None:
    stdout_sink("out", "info")
    stdout_sink("err", "error")
    captured = capsys.readouterr()
    assert "out" in captured.out
    assert "err" in captured.err


# ── create_logger_from_env ─────────────────────────────────


def test_LOG_LEVEL_を読み取る() -> None:
    assert create_logger_from_env({"LOG_LEVEL": "error"}).level == "error"


def test_LOG_LEVEL_未設定なら既定値になる() -> None:
    assert create_logger_from_env({}).level == DEFAULT_LOG_LEVEL


def test_不正な_LOG_LEVEL_でも例外を投げない() -> None:
    assert create_logger_from_env({"LOG_LEVEL": "でたらめ"}).level == DEFAULT_LOG_LEVEL


def test_環境変数から読みつつ_sink_を差し替えられる(recorder: Recorder) -> None:
    log = create_logger_from_env({"LOG_LEVEL": "debug"}, sink=recorder, now=fixed_now)
    log.debug("m")
    assert recorder.entries[0]["message"] == "m"


# ── retry_logger ───────────────────────────────────────────


def test_リトライを_warn_で構造化して記録する(recorder: Recorder) -> None:
    log = make_logger(recorder)
    try:
        raise RuntimeError("スロットリング")
    except RuntimeError as exc:
        retry_logger(log, "InvokeModel")(2, 0.5127, exc)

    entry = recorder.entries[0]
    assert entry["level"] == "warn"
    assert entry["operation"] == "InvokeModel"
    assert entry["attempt"] == 2
    assert entry["delay_seconds"] == 0.513
    assert entry["error"]["type"] == "RuntimeError"


def test_silent_なロガーではリトライを記録しない(recorder: Recorder) -> None:
    retry_logger(make_logger(recorder, level="silent"), "InvokeModel")(
        1, 0.1, RuntimeError("x")
    )
    assert recorder.lines == []

"""
index.py と retry.py の結線を検証するテスト（AWS 接続なし）

retry.py 単体の振る舞いは test_retry.py が網羅している。
ここで見るのは「ハンドラーが SNS Publish をリトライ層に通しているか」だけ。

実待機を避けるため SNS_RETRY_CONFIG を差し替えている。
base_delay = max_delay かつ jitter 無効にすると待機時間が一定になり、
テストが決定的になる。
"""

import json
import os
import sys
from unittest.mock import MagicMock, patch

from botocore.exceptions import ClientError

os.environ.setdefault("AWS_REGION", "ap-northeast-1")
os.environ.setdefault(
    "SNS_TOPIC_ARN", "arn:aws:sns:ap-northeast-1:123456789012:test-alert"
)
sys.path.insert(0, os.path.dirname(__file__))

from index import _SNS_CONFIG, SNS_RETRY_CONFIG, handler
from logger import create_logger
from metrics import create_metrics
from retry import RetryConfig


def _collecting_logger(lines: list[dict]):
    """出力された 1 行 JSON をそのまま集めるロガー。"""
    return create_logger(
        level="debug",
        sink=lambda line, level: lines.append(json.loads(line)),
    )


def _silent_metrics():
    """EMF をテスト出力に混ぜないための捨て先。"""
    return create_metrics("Test", sink=lambda line: None, Handler="streams-alert")


# 実待機ゼロ・待機時間一定の設定（試行回数だけ本番と揃える）
_FAST = RetryConfig(
    max_attempts=SNS_RETRY_CONFIG.max_attempts,
    base_delay=0.001,
    max_delay=0.001,
    jitter=False,
)


# ── ヘルパー ──────────────────────────────────────────────────────────


def _make_record(incident_id: str = "inc-001", event_name: str = "INSERT") -> dict:
    return {
        "eventName": event_name,
        "dynamodb": {
            "NewImage": {
                "incident_id": {"S": incident_id},
                "severity": {"S": "CRITICAL"},
                "status": {"S": "OPEN"},
                "message": {"S": "EC2 CPU 90%超過"},
                "resource": {"S": "i-1234567890abcdef0"},
                "timestamp": {"S": "2026-06-04T10:00:00Z"},
            }
        },
    }


def _throttling() -> ClientError:
    """SNS がスロットリング時に返す形の ClientError"""
    return ClientError(
        {"Error": {"Code": "ThrottlingException", "Message": "Rate exceeded"}},
        "Publish",
    )


def _service_unavailable() -> ClientError:
    """HTTP ステータスだけで判定させる ClientError（503）"""
    return ClientError(
        {
            "Error": {"Code": "SomethingUnknown", "Message": "unavailable"},
            "ResponseMetadata": {"HTTPStatusCode": 503},
        },
        "Publish",
    )


# ── リトライ設定 ──────────────────────────────────────────────────────


class TestSNSRetryConfig:
    def test_GoとTypeScriptの既定値と揃っている(self):
        assert SNS_RETRY_CONFIG.max_attempts == 4
        assert SNS_RETRY_CONFIG.base_delay == 0.1
        assert SNS_RETRY_CONFIG.max_delay == 5.0
        assert SNS_RETRY_CONFIG.jitter is True

    def test_共通モジュールの既定値より短い(self):
        # Streams は 1 起動で複数レコードを直列処理するため待機を短くしてある
        assert SNS_RETRY_CONFIG.base_delay < 0.5
        assert SNS_RETRY_CONFIG.max_delay < 8.0

    def test_botocoreの内蔵リトライが無効化されている(self):
        # retry.py 側と二重に再試行すると試行回数が掛け算になるため。
        # botocore はクライアント生成時に retries を正規化するので、
        # 正規化後の total_max_attempts（初回を含む総試行回数）で検証する。
        # ★ max_attempts=1 と書くと total_max_attempts=2 に正規化され、
        #   リトライが 1 回残ってしまう。この回帰を防ぐためのテスト。
        assert _SNS_CONFIG.retries["total_max_attempts"] == 1
        assert _SNS_CONFIG.retries["mode"] == "standard"


# ── リトライされるケース ──────────────────────────────────────────────


class TestPublishRetry:
    @patch("index.SNS_RETRY_CONFIG", _FAST)
    @patch("index.sns")
    def test_ThrottlingExceptionは再試行され成功すればprocessedに入る(self, mock_sns):
        mock_sns.publish.side_effect = [_throttling(), {"MessageId": "msg-001"}]

        result = handler([_make_record()], MagicMock())

        assert mock_sns.publish.call_count == 2
        assert result["processed"][0]["status"] == "success"
        assert result["processed"][0]["message_id"] == "msg-001"
        assert result["errors"] == []

    @patch("index.SNS_RETRY_CONFIG", _FAST)
    @patch("index.sns")
    def test_HTTP503もステータスコードだけで再試行される(self, mock_sns):
        mock_sns.publish.side_effect = [
            _service_unavailable(),
            {"MessageId": "msg-002"},
        ]

        result = handler([_make_record()], MagicMock())

        assert mock_sns.publish.call_count == 2
        assert len(result["processed"]) == 1

    @patch("index.SNS_RETRY_CONFIG", _FAST)
    @patch("index.sns")
    def test_試行回数を使い切ったらerrorsに記録する(self, mock_sns):
        mock_sns.publish.side_effect = _throttling()

        result = handler([_make_record()], MagicMock())

        assert mock_sns.publish.call_count == SNS_RETRY_CONFIG.max_attempts
        assert result["processed"] == []
        assert "Rate exceeded" in result["errors"][0]["reason"]

    @patch("index.SNS_RETRY_CONFIG", _FAST)
    @patch("index.sns")
    def test_errorsにincident_idとseverityが載る(self, mock_sns):
        mock_sns.publish.side_effect = _throttling()

        result = handler([_make_record(incident_id="inc-999")], MagicMock())

        assert result["errors"][0]["incident_id"] == "inc-999"
        assert result["errors"][0]["severity"] == "CRITICAL"


# ── リトライされないケース（既存挙動が壊れていないこと） ──────────────


class TestNonRetryable:
    @patch("index.SNS_RETRY_CONFIG", _FAST)
    @patch("index.sns")
    def test_通常のExceptionは再試行せず1回でerrorsに入る(self, mock_sns):
        mock_sns.publish.side_effect = Exception("SNS unavailable")

        result = handler([_make_record()], MagicMock())

        # ここが 1 であることが「既存テストが実待機で遅くならない」根拠でもある
        assert mock_sns.publish.call_count == 1
        assert "SNS unavailable" in result["errors"][0]["reason"]

    @patch("index.SNS_RETRY_CONFIG", _FAST)
    @patch("index.sns")
    def test_成功するレコードは1回のPublishで完了する(self, mock_sns):
        mock_sns.publish.return_value = {"MessageId": "msg-003"}

        handler([_make_record()], MagicMock())

        assert mock_sns.publish.call_count == 1


# ── on_retry の結線 ───────────────────────────────────────────────────


class TestOnRetry:
    @patch("index.SNS_RETRY_CONFIG", _FAST)
    @patch("index.sns")
    def test_リトライのたびにwarningログが出る(self, mock_sns):
        mock_sns.publish.side_effect = [_throttling(), {"MessageId": "msg-004"}]
        lines: list[dict] = []

        handler(
            [_make_record(incident_id="inc-777")],
            MagicMock(),
            logger=_collecting_logger(lines),
            metrics=_silent_metrics(),
        )

        warnings = [e for e in lines if e["level"] == "warn"]
        assert len(warnings) == 1
        # 操作名とインシデント ID が構造化フィールドとして載る
        # （文字列に埋め込まないので Logs Insights でそのまま集計できる）
        assert warnings[0]["operation"] == "sns:Publish"
        assert warnings[0]["incident_id"] == "inc-777"
        assert warnings[0]["attempt"] == 1

    @patch("index.SNS_RETRY_CONFIG", _FAST)
    @patch("index.sns")
    def test_リトライ対象外ならwarningは出ない(self, mock_sns):
        mock_sns.publish.side_effect = Exception("plain")
        lines: list[dict] = []

        handler(
            [_make_record()],
            MagicMock(),
            logger=_collecting_logger(lines),
            metrics=_silent_metrics(),
        )

        assert not [e for e in lines if e["level"] == "warn"]
        # リトライしないだけで、失敗そのものは error として残る
        assert [e for e in lines if e["level"] == "error"]


# ── 複数レコード ──────────────────────────────────────────────────────


class TestMultipleRecords:
    @patch("index.SNS_RETRY_CONFIG", _FAST)
    @patch("index.sns")
    def test_1件目がリトライしても2件目は独立して処理される(self, mock_sns):
        mock_sns.publish.side_effect = [
            _throttling(),
            {"MessageId": "msg-005"},
            {"MessageId": "msg-006"},
        ]

        result = handler(
            [_make_record("inc-001"), _make_record("inc-002")], MagicMock()
        )

        # 1 件目: 失敗 + 成功 = 2 回、2 件目: 成功 = 1 回
        assert mock_sns.publish.call_count == 3
        assert len(result["processed"]) == 2
        assert result["errors"] == []

    @patch("index.SNS_RETRY_CONFIG", _FAST)
    @patch("index.sns")
    def test_1件目がリトライ上限に達しても2件目は処理される(self, mock_sns):
        n = SNS_RETRY_CONFIG.max_attempts
        mock_sns.publish.side_effect = [_throttling()] * n + [{"MessageId": "msg-007"}]

        result = handler(
            [_make_record("inc-001"), _make_record("inc-002")], MagicMock()
        )

        assert result["errors"][0]["incident_id"] == "inc-001"
        assert result["processed"][0]["incident_id"] == "inc-002"

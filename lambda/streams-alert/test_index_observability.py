"""
index.py と logger.py / metrics.py の結線を検証するテスト（AWS 接続なし）

logger.py / metrics.py 単体の振る舞いは test_logger.py / test_metrics.py が
網羅している。ここで見るのは「ハンドラーが両者に繋がっているか」だけ。

TypeScript 版（lambda_ts/streams-alert/index.observability.test.ts）と
同じ観点で並べてある。
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

from index import DEFAULT_METRICS_NAMESPACE, SNS_RETRY_CONFIG, handler
from logger import create_logger
from metrics import create_metrics
from retry import RetryConfig

# 実待機を避けるための設定（test_index_retry.py と同じ考え方）
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


def _error_with_secrets() -> ClientError:
    """
    署名ヘッダーを抱えた ClientError。

    botocore の例外は response に HTTP のやり取りを丸ごと持つことがあり、
    そのままログへ流すと Authorization ヘッダーが残る。
    """
    error = ClientError(
        {
            "Error": {"Code": "InvalidSignatureException", "Message": "署名エラー"},
            "ResponseMetadata": {
                "HTTPHeaders": {
                    "authorization": "AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20260918",
                    "x-amz-security-token": "FwoGZXIvYXdzEBEXAMPLETOKEN",
                }
            },
        },
        "Publish",
    )
    return error


class _Collected:
    """ログ行と EMF 行を集めて、注入用の logger / metrics を返す。"""

    def __init__(self, namespace: str = "Test/Namespace") -> None:
        self.logs: list[dict] = []
        self.emf: list[dict] = []
        self.logger = create_logger(
            level="debug",
            sink=lambda line, level: self.logs.append(json.loads(line)),
        )
        self.metrics = create_metrics(
            namespace,
            sink=lambda line: self.emf.append(json.loads(line)),
            Handler="streams-alert",
        )

    def find_log(self, message: str) -> dict | None:
        for entry in self.logs:
            if entry.get("message") == message:
                return entry
        return None

    @property
    def document(self) -> dict:
        assert len(self.emf) == 1, f"EMF ドキュメントは 1 件のはず: {len(self.emf)}"
        return self.emf[0]

    def metric_names(self) -> list[str]:
        cw = self.document["_aws"]["CloudWatchMetrics"][0]
        return [m["Name"] for m in cw["Metrics"]]


# ── 構造化ログへの結線 ────────────────────────────────────────────────


class TestStructuredLogging:
    @patch("index.sns")
    def test_起動ログにレコード件数が構造化フィールドで載る(self, mock_sns):
        mock_sns.publish.return_value = {"MessageId": "msg-001"}
        c = _Collected()

        handler([_make_record()], MagicMock(), logger=c.logger, metrics=c.metrics)

        entry = c.find_log("streams-alert handler 起動")
        assert entry is not None
        assert entry["record_count"] == 1

    @patch("index.sns")
    def test_成功ログにincident_idとseverityが引き継がれる(self, mock_sns):
        mock_sns.publish.return_value = {"MessageId": "msg-002"}
        c = _Collected()

        handler(
            [_make_record(incident_id="inc-123")],
            MagicMock(),
            logger=c.logger,
            metrics=c.metrics,
        )

        entry = c.find_log("SNS 通知成功")
        assert entry is not None
        # child ロガー由来のフィールド
        assert entry["incident_id"] == "inc-123"
        assert entry["severity"] == "CRITICAL"
        assert entry["message_id"] == "msg-002"

    @patch("index.sns")
    def test_完了ログに件数の内訳が載る(self, mock_sns):
        mock_sns.publish.return_value = {"MessageId": "msg-003"}
        c = _Collected()

        handler(
            [_make_record(), _make_record(event_name="REMOVE")],
            MagicMock(),
            logger=c.logger,
            metrics=c.metrics,
        )

        entry = c.find_log("処理完了")
        assert entry is not None
        assert entry["processed"] == 1
        assert entry["skipped"] == 1
        assert entry["errors"] == 0

    @patch("index.sns")
    def test_NewImageが空ならwarnで残る(self, mock_sns):
        c = _Collected()

        handler(
            [{"eventName": "INSERT", "dynamodb": {}}],
            MagicMock(),
            logger=c.logger,
            metrics=c.metrics,
        )

        entry = c.find_log("NewImage が空のレコードをスキップ")
        assert entry is not None
        assert entry["level"] == "warn"
        assert entry["reason"] == "empty NewImage"

    @patch("index.sns")
    def test_通知本文はログに出さない(self, mock_sns):
        """SNS へ送る本文はインシデントの中身そのものなので、ログには載せない。"""
        mock_sns.publish.return_value = {"MessageId": "msg-004"}
        c = _Collected()

        handler([_make_record()], MagicMock(), logger=c.logger, metrics=c.metrics)

        raw = json.dumps(c.logs, ensure_ascii=False)
        assert "EC2 CPU 90%超過" not in raw
        assert "i-1234567890abcdef0" not in raw


# ── エラーの出力範囲 ──────────────────────────────────────────────────


class TestErrorLogging:
    @patch("index.SNS_RETRY_CONFIG", _FAST)
    @patch("index.sns")
    def test_例外の付帯プロパティはログに出力されない(self, mock_sns):
        mock_sns.publish.side_effect = _error_with_secrets()
        c = _Collected()

        handler([_make_record()], MagicMock(), logger=c.logger, metrics=c.metrics)

        raw = json.dumps(c.logs, ensure_ascii=False)
        assert "AWS4-HMAC-SHA256" not in raw
        assert "x-amz-security-token" not in raw

    @patch("index.SNS_RETRY_CONFIG", _FAST)
    @patch("index.sns")
    def test_展開されるキーはtype_message_stackだけ(self, mock_sns):
        mock_sns.publish.side_effect = _error_with_secrets()
        c = _Collected()

        handler([_make_record()], MagicMock(), logger=c.logger, metrics=c.metrics)

        entry = c.find_log("SNS 通知エラー")
        assert entry is not None
        assert sorted(entry["error"].keys()) == ["message", "stack", "type"]

    @patch("index.SNS_RETRY_CONFIG", _FAST)
    @patch("index.sns")
    def test_調査に必要な情報は残る(self, mock_sns):
        mock_sns.publish.side_effect = _error_with_secrets()
        c = _Collected()

        handler(
            [_make_record(incident_id="inc-555")],
            MagicMock(),
            logger=c.logger,
            metrics=c.metrics,
        )

        entry = c.find_log("SNS 通知エラー")
        assert entry is not None
        assert entry["error"]["type"] == "ClientError"
        assert "署名エラー" in entry["error"]["message"]
        # 旧実装の str(e) では失われていた情報
        assert isinstance(entry["error"]["stack"], str)
        assert entry["incident_id"] == "inc-555"


# ── EMF メトリクスへの結線 ────────────────────────────────────────────


class TestMetricsWiring:
    @patch("index.sns")
    def test_flushされてEMFドキュメントが1行出力される(self, mock_sns):
        mock_sns.publish.return_value = {"MessageId": "msg-005"}
        c = _Collected()

        handler([_make_record()], MagicMock(), logger=c.logger, metrics=c.metrics)

        doc = c.document
        cw = doc["_aws"]["CloudWatchMetrics"][0]
        assert cw["Namespace"] == "Test/Namespace"
        assert cw["Dimensions"] == [["Handler"]]
        assert doc["Handler"] == "streams-alert"

    @patch("index.sns")
    def test_成功時のメトリクス(self, mock_sns):
        mock_sns.publish.return_value = {"MessageId": "msg-006"}
        c = _Collected()

        handler([_make_record()], MagicMock(), logger=c.logger, metrics=c.metrics)

        names = c.metric_names()
        assert "RecordsReceived" in names
        assert "NotificationSuccess" in names
        assert "PublishLatency" in names
        assert c.document["RecordsReceived"] == 1
        assert c.document["NotificationSuccess"] == 1

    @patch("index.sns")
    def test_スキップはRecordSkippedで数える(self, mock_sns):
        c = _Collected()

        handler(
            [_make_record(event_name="REMOVE"), {"eventName": "INSERT"}],
            MagicMock(),
            logger=c.logger,
            metrics=c.metrics,
        )

        # 同名メトリクスを 2 回足すと値が配列で蓄積される
        assert c.document["RecordSkipped"] == [1, 1]
        assert "NotificationSuccess" not in c.metric_names()

    @patch("index.SNS_RETRY_CONFIG", _FAST)
    @patch("index.sns")
    def test_失敗時はNotificationErrorが立つ(self, mock_sns):
        mock_sns.publish.side_effect = Exception("boom")
        c = _Collected()

        handler([_make_record()], MagicMock(), logger=c.logger, metrics=c.metrics)

        assert c.document["NotificationError"] == 1
        # 失敗時のレイテンシも見たいので計測は残る
        assert "PublishLatency" in c.metric_names()


# ── on_retry が logger と metrics の両方に繋がっている ────────────────


class TestRetryHookWiring:
    @patch("index.SNS_RETRY_CONFIG", _FAST)
    @patch("index.sns")
    def test_リトライがログとメトリクスの両方に流れる(self, mock_sns):
        mock_sns.publish.side_effect = [_throttling(), {"MessageId": "msg-007"}]
        c = _Collected()

        handler(
            [_make_record(incident_id="inc-777")],
            MagicMock(),
            logger=c.logger,
            metrics=c.metrics,
        )

        # ログ側
        warnings = [e for e in c.logs if e["level"] == "warn"]
        assert len(warnings) == 1
        assert warnings[0]["operation"] == "sns:Publish"
        assert warnings[0]["incident_id"] == "inc-777"

        # メトリクス側
        assert c.document["RetryAttempts"] == 1
        assert "RetryDelay" in c.metric_names()
        assert c.document["retry_operation"] == "sns:Publish"
        assert c.document["retry_last_error"] == "ClientError"

    @patch("index.SNS_RETRY_CONFIG", _FAST)
    @patch("index.sns")
    def test_リトライしなければRetryAttemptsは出ない(self, mock_sns):
        mock_sns.publish.return_value = {"MessageId": "msg-008"}
        c = _Collected()

        handler([_make_record()], MagicMock(), logger=c.logger, metrics=c.metrics)

        assert "RetryAttempts" not in c.metric_names()
        assert not [e for e in c.logs if e["level"] == "warn"]


# ── 依存を省略したときの既定 ──────────────────────────────────────────


class TestDefaults:
    @patch("index.sns")
    def test_名前空間が未設定ならハンドラー既定を使う(
        self, mock_sns, monkeypatch, capsys
    ):
        mock_sns.publish.return_value = {"MessageId": "msg-009"}
        monkeypatch.delenv("METRICS_NAMESPACE", raising=False)

        handler([_make_record()], MagicMock())

        emf = [
            json.loads(line)
            for line in capsys.readouterr().out.splitlines()
            if '"_aws"' in line
        ]
        assert len(emf) == 1
        assert (
            emf[0]["_aws"]["CloudWatchMetrics"][0]["Namespace"]
            == DEFAULT_METRICS_NAMESPACE
        )

    @patch("index.sns")
    def test_環境変数の名前空間が優先される(self, mock_sns, monkeypatch, capsys):
        mock_sns.publish.return_value = {"MessageId": "msg-010"}
        monkeypatch.setenv("METRICS_NAMESPACE", "Custom/Namespace")

        handler([_make_record()], MagicMock())

        emf = [
            json.loads(line)
            for line in capsys.readouterr().out.splitlines()
            if '"_aws"' in line
        ]
        assert emf[0]["_aws"]["CloudWatchMetrics"][0]["Namespace"] == "Custom/Namespace"

    @patch("index.sns")
    def test_メトリクスを無効化できる(self, mock_sns, monkeypatch, capsys):
        mock_sns.publish.return_value = {"MessageId": "msg-011"}
        monkeypatch.setenv("METRICS_ENABLED", "false")

        handler([_make_record()], MagicMock())

        assert '"_aws"' not in capsys.readouterr().out

    @patch("index.sns")
    def test_省略時もログは標準出力に出る(self, mock_sns, capsys):
        mock_sns.publish.return_value = {"MessageId": "msg-012"}

        handler([_make_record()], MagicMock())

        out = capsys.readouterr().out
        assert '"message":"streams-alert handler 起動"' in out

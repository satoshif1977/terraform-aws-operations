"""
index.py と logger.py / metrics.py / retry.py の結線を検証するテスト（AWS 接続なし）

各モジュール単体の振る舞いは test_logger.py / test_metrics.py / test_retry.py が
網羅している。ここで見るのは「ハンドラーが 3 つに繋がっているか」だけ。

同リポジトリの streams-alert（test_index_observability.py）と同じ観点で並べてある。
"""

import json
import os
import sys
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

os.environ.setdefault("AWS_REGION", "ap-northeast-1")
os.environ.setdefault(
    "SNS_TOPIC_ARN", "arn:aws:sns:ap-northeast-1:123456789012:test-alert"
)
sys.path.insert(0, os.path.dirname(__file__))

from index import (  # noqa: E402
    DEFAULT_METRICS_NAMESPACE,
    RETRY_OPERATION,
    SNS_RETRY_CONFIG,
    lambda_handler,
)
from logger import create_logger  # noqa: E402
from metrics import create_metrics  # noqa: E402
from retry import RetryConfig  # noqa: E402

# 実待機を避けるための設定。base_delay = max_delay かつ jitter 無効にすると
# 待機時間が一定になり、テストが決定的になる。
_FAST = RetryConfig(
    max_attempts=SNS_RETRY_CONFIG.max_attempts,
    base_delay=0.001,
    max_delay=0.001,
    jitter=False,
)


# ── ヘルパー ─────────────────────────────────────────────────


def _make_event(severity: float = 8.5, finding_id: str = "finding-001") -> dict:
    return {
        "source": "aws.guardduty",
        "detail": {
            "id": finding_id,
            "severity": severity,
            "type": "UnauthorizedAccess:EC2/SSHBruteForce",
            "title": "SSH ブルートフォース攻撃を検知",
            "description": "EC2 インスタンスへの総当たり攻撃を検出しました",
            "region": "ap-northeast-1",
            "accountId": "123456789012",
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
    return ClientError(
        {
            "Error": {"Code": "InvalidSignatureException", "Message": "署名エラー"},
            "ResponseMetadata": {
                "HTTPHeaders": {
                    "authorization": "AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20260924",
                    "x-amz-security-token": "FwoGZXIvYXdzEBEXAMPLETOKEN",
                }
            },
        },
        "Publish",
    )


class _Collected:
    """ログ行と EMF 行を集めて、注入用の logger / metrics を返す。"""

    def __init__(self, namespace: str = DEFAULT_METRICS_NAMESPACE) -> None:
        self.logs: list[dict] = []
        self.emf: list[dict] = []
        self.logger = create_logger(
            level="debug",
            sink=lambda line, level: self.logs.append(json.loads(line)),
        )
        self.metrics = create_metrics(
            namespace,
            sink=lambda line: self.emf.append(json.loads(line)),
            Handler="guardduty-notifier",
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


# ── 構造化ログへの結線 ───────────────────────────────────────


class TestStructuredLogging:
    @patch("index.sns")
    def test_受信ログにfinding_idとseverityが構造化フィールドで載る(self, mock_sns):
        mock_sns.publish.return_value = {"MessageId": "msg-001"}
        c = _Collected()

        lambda_handler(
            _make_event(finding_id="finding-123"),
            MagicMock(),
            logger=c.logger,
            metrics=c.metrics,
        )

        entry = c.find_log("GuardDuty Finding を受信")
        assert entry is not None
        assert entry["finding_id"] == "finding-123"
        assert entry["severity"] == 8.5
        assert entry["severity_label"] == "[HIGH]"

    @patch("index.sns")
    def test_成功ログにmessage_idが載る(self, mock_sns):
        mock_sns.publish.return_value = {"MessageId": "msg-002"}
        c = _Collected()

        lambda_handler(_make_event(), MagicMock(), logger=c.logger, metrics=c.metrics)

        entry = c.find_log("SNS 通知成功")
        assert entry is not None
        assert entry["message_id"] == "msg-002"
        # 子ロガーの文脈が成功ログにも引き継がれている
        assert entry["finding_id"] == "finding-001"

    @patch("index.sns")
    def test_detailが空のときwarnログが出る(self, mock_sns):
        c = _Collected()

        result = lambda_handler({}, MagicMock(), logger=c.logger, metrics=c.metrics)

        assert result["statusCode"] == 400
        entry = c.find_log("detail が空のイベントをスキップ")
        assert entry is not None
        assert entry["level"] == "warn"
        assert entry["reason"] == "empty detail"

    @patch("index.sns")
    def test_エラーログに署名ヘッダーが出ない(self, mock_sns):
        """例外は type / message / stack にだけ展開される。"""
        mock_sns.publish.side_effect = _error_with_secrets()
        c = _Collected()

        with pytest.raises(ClientError):
            lambda_handler(
                _make_event(), MagicMock(), logger=c.logger, metrics=c.metrics
            )

        dumped = json.dumps(c.logs, ensure_ascii=False)
        assert "AWS4-HMAC-SHA256" not in dumped
        assert "FwoGZXIvYXdzEBEXAMPLETOKEN" not in dumped
        # エラー自体は記録されている
        assert c.find_log("SNS 通知エラー") is not None


# ── EMF メトリクスへの結線 ───────────────────────────────────


class TestMetrics:
    @patch("index.sns")
    def test_成功時のメトリクスが揃う(self, mock_sns):
        mock_sns.publish.return_value = {"MessageId": "msg-003"}
        c = _Collected()

        lambda_handler(_make_event(), MagicMock(), logger=c.logger, metrics=c.metrics)

        names = c.metric_names()
        assert "FindingsReceived" in names
        assert "FindingSeverity" in names
        assert "NotificationSuccess" in names
        assert "PublishLatency" in names
        assert c.document["FindingsReceived"] == 1
        assert c.document["NotificationSuccess"] == 1

    @patch("index.sns")
    def test_severityがメトリクス値として載る(self, mock_sns):
        mock_sns.publish.return_value = {"MessageId": "msg-004"}
        c = _Collected()

        lambda_handler(
            _make_event(severity=9.3), MagicMock(), logger=c.logger, metrics=c.metrics
        )

        assert c.document["FindingSeverity"] == 9.3

    @patch("index.sns")
    def test_名前空間がハンドラー固有の値になる(self, mock_sns):
        mock_sns.publish.return_value = {"MessageId": "msg-005"}
        c = _Collected()

        lambda_handler(_make_event(), MagicMock(), logger=c.logger, metrics=c.metrics)

        cw = c.document["_aws"]["CloudWatchMetrics"][0]
        assert cw["Namespace"] == DEFAULT_METRICS_NAMESPACE
        assert DEFAULT_METRICS_NAMESPACE == "TerraformAwsOperations/GuarddutyNotifier"

    @patch("index.sns")
    def test_detailが空のときスキップを数える(self, mock_sns):
        c = _Collected()

        lambda_handler({}, MagicMock(), logger=c.logger, metrics=c.metrics)

        assert "FindingSkipped" in c.metric_names()
        assert c.document["FindingSkipped"] == 1
        # 通知していないので成功メトリクスは立たない
        assert "NotificationSuccess" not in c.metric_names()

    @patch("index.sns")
    def test_失敗時も送出前にflushされる(self, mock_sns):
        """例外で終わるときにメトリクスが失われると、不達に気づけない。"""
        mock_sns.publish.side_effect = _error_with_secrets()
        c = _Collected()

        with pytest.raises(ClientError):
            lambda_handler(
                _make_event(), MagicMock(), logger=c.logger, metrics=c.metrics
            )

        assert "NotificationError" in c.metric_names()
        assert c.document["NotificationError"] == 1


# ── リトライへの結線 ─────────────────────────────────────────


class TestRetryWiring:
    @patch("index.SNS_RETRY_CONFIG", _FAST)
    @patch("index.sns")
    def test_スロットリングを再試行して最終的に成功する(self, mock_sns):
        mock_sns.publish.side_effect = [_throttling(), {"MessageId": "msg-006"}]
        c = _Collected()

        result = lambda_handler(
            _make_event(), MagicMock(), logger=c.logger, metrics=c.metrics
        )

        assert result["statusCode"] == 200
        assert mock_sns.publish.call_count == 2

    @patch("index.SNS_RETRY_CONFIG", _FAST)
    @patch("index.sns")
    def test_リトライがログとメトリクスの両方に記録される(self, mock_sns):
        mock_sns.publish.side_effect = [_throttling(), {"MessageId": "msg-007"}]
        c = _Collected()

        lambda_handler(_make_event(), MagicMock(), logger=c.logger, metrics=c.metrics)

        entry = c.find_log("AWS API 呼び出しをリトライします")
        assert entry is not None
        assert entry["operation"] == RETRY_OPERATION
        assert entry["attempt"] == 1

        assert "RetryAttempts" in c.metric_names()
        assert c.document["retry_operation"] == RETRY_OPERATION
        assert c.document["retry_last_error"] == "ClientError"

    @patch("index.SNS_RETRY_CONFIG", _FAST)
    @patch("index.sns")
    def test_リトライ不能な例外は即座に送出される(self, mock_sns):
        """署名エラーは時間をおいても成功しないので再試行しない。"""
        mock_sns.publish.side_effect = _error_with_secrets()
        c = _Collected()

        with pytest.raises(ClientError):
            lambda_handler(
                _make_event(), MagicMock(), logger=c.logger, metrics=c.metrics
            )

        assert mock_sns.publish.call_count == 1
        assert c.find_log("AWS API 呼び出しをリトライします") is None

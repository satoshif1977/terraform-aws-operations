"""
GuardDuty Notifier ユニットテスト（AWS 接続なし）
"""

import os
import sys
from unittest.mock import MagicMock, patch

os.environ.setdefault(
    "SNS_TOPIC_ARN", "arn:aws:sns:ap-northeast-1:123456789012:test-topic"
)
os.environ.setdefault("AWS_DEFAULT_REGION", "ap-northeast-1")
sys.path.insert(0, os.path.dirname(__file__))

from index import build_message, get_severity_label, lambda_handler  # noqa: E402

# ── get_severity_label のテスト ───────────────────────────────


class TestGetSeverityLabel:
    def test_CRITICAL_9以上(self):
        assert get_severity_label(9.0) == "[CRITICAL]"

    def test_CRITICAL_最大値(self):
        assert get_severity_label(10.0) == "[CRITICAL]"

    def test_HIGH_7以上9未満(self):
        assert get_severity_label(7.0) == "[HIGH]"
        assert get_severity_label(8.9) == "[HIGH]"

    def test_MEDIUM_4以上7未満(self):
        assert get_severity_label(4.0) == "[MEDIUM]"
        assert get_severity_label(6.9) == "[MEDIUM]"

    def test_LOW_4未満(self):
        assert get_severity_label(0.0) == "[LOW]"
        assert get_severity_label(3.9) == "[LOW]"

    def test_境界値_7ちょうど(self):
        assert get_severity_label(7.0) == "[HIGH]"

    def test_境界値_4ちょうど(self):
        assert get_severity_label(4.0) == "[MEDIUM]"


# ── build_message のテスト ────────────────────────────────────


def _make_detail(
    severity: float = 7.5,
    title: str = "テスト Finding",
    description: str = "テスト説明",
    finding_type: str = "UnauthorizedAccess:EC2/SSHBruteForce",
    region: str = "ap-northeast-1",
    account_id: str = "123456789012",
    finding_id: str = "abc123",
) -> dict:
    return {
        "severity": severity,
        "title": title,
        "description": description,
        "type": finding_type,
        "region": region,
        "accountId": account_id,
        "id": finding_id,
    }


class TestBuildMessage:
    def test_件名にGuardDutyが含まれる(self):
        subject, _ = build_message(_make_detail())
        assert "[GuardDuty]" in subject

    def test_件名にHIGHラベルが含まれる(self):
        subject, _ = build_message(_make_detail(severity=7.5))
        assert "[HIGH]" in subject

    def test_件名にCRITICALラベルが含まれる(self):
        subject, _ = build_message(_make_detail(severity=9.5))
        assert "[CRITICAL]" in subject

    def test_件名にMEDIUMラベルが含まれる(self):
        subject, _ = build_message(_make_detail(severity=5.0))
        assert "[MEDIUM]" in subject

    def test_本文にリージョンが含まれる(self):
        _, message = build_message(_make_detail(region="ap-northeast-1"))
        assert "ap-northeast-1" in message

    def test_本文にアカウントIDが含まれる(self):
        _, message = build_message(_make_detail(account_id="123456789012"))
        assert "123456789012" in message

    def test_本文にFindingIDが含まれる(self):
        _, message = build_message(_make_detail(finding_id="abc123"))
        assert "abc123" in message

    def test_本文にコンソールURLが含まれる(self):
        _, message = build_message(_make_detail())
        assert "console.aws.amazon.com/guardduty" in message

    def test_本文にタイプが含まれる(self):
        _, message = build_message(
            _make_detail(finding_type="UnauthorizedAccess:EC2/SSHBruteForce")
        )
        assert "UnauthorizedAccess:EC2/SSHBruteForce" in message

    def test_本文に説明が含まれる(self):
        _, message = build_message(_make_detail(description="不審なSSHアクセス"))
        assert "不審なSSHアクセス" in message

    def test_件名が100文字以内(self):
        long_title = "A" * 200
        subject, _ = build_message(_make_detail(title=long_title))
        assert len(subject) <= 100

    def test_空のdetailでも例外が出ない(self):
        subject, message = build_message({})
        assert isinstance(subject, str)
        assert isinstance(message, str)


# ── lambda_handler のテスト ───────────────────────────────────


class TestLambdaHandler:
    @patch("index.sns")
    def test_正常なイベントで200を返す(self, mock_sns):
        mock_sns.publish.return_value = {"MessageId": "msg-001"}

        event = {"detail": _make_detail()}
        result = lambda_handler(event, MagicMock())

        mock_sns.publish.assert_called_once()
        assert result["statusCode"] == 200
        assert result["body"] == "Notification sent"

    @patch("index.sns")
    def test_SNS件名が100文字制限を守る(self, mock_sns):
        mock_sns.publish.return_value = {"MessageId": "msg-002"}

        event = {"detail": _make_detail(title="A" * 200)}
        lambda_handler(event, MagicMock())

        call_kwargs = mock_sns.publish.call_args[1]
        assert len(call_kwargs["Subject"]) <= 100

    @patch("index.sns")
    def test_detailが空のとき400を返す(self, mock_sns):
        event = {"detail": {}}
        result = lambda_handler(event, MagicMock())

        mock_sns.publish.assert_not_called()
        assert result["statusCode"] == 400

    @patch("index.sns")
    def test_detailキーがないとき400を返す(self, mock_sns):
        event = {}
        result = lambda_handler(event, MagicMock())

        mock_sns.publish.assert_not_called()
        assert result["statusCode"] == 400

    @patch("index.sns")
    def test_SNSにTopicArnが渡される(self, mock_sns):
        mock_sns.publish.return_value = {"MessageId": "msg-003"}

        event = {"detail": _make_detail()}
        lambda_handler(event, MagicMock())

        call_kwargs = mock_sns.publish.call_args[1]
        assert "TopicArn" in call_kwargs
        assert call_kwargs["TopicArn"] == os.environ["SNS_TOPIC_ARN"]

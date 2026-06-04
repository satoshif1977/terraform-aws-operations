"""
streams-alert ユニットテスト（AWS 接続なし）
"""

import os
import sys
from unittest.mock import MagicMock, patch

os.environ.setdefault("AWS_REGION", "ap-northeast-1")
os.environ.setdefault("SNS_TOPIC_ARN", "arn:aws:sns:ap-northeast-1:123456789012:test-alert")
sys.path.insert(0, os.path.dirname(__file__))

from index import _build_message, _extract_dynamo_value, handler  # noqa: E402


# ── ヘルパー ──────────────────────────────────────────────────────────

def _make_dynamo_record(
    event_name: str = "INSERT",
    incident_id: str = "inc-001",
    severity: str = "CRITICAL",
    status: str = "OPEN",
    message: str = "EC2 CPU 90%超過",
    resource: str = "i-1234567890abcdef0",
    timestamp: str = "2026-06-04T10:00:00Z",
    include_new_image: bool = True,
) -> dict:
    """DynamoDB Streams レコードを生成するヘルパー"""
    record: dict = {
        "eventID": "evt-test-001",
        "eventName": event_name,
        "eventVersion": "1.1",
        "eventSource": "aws:dynamodb",
        "awsRegion": "ap-northeast-1",
        "dynamodb": {},
    }
    if include_new_image:
        record["dynamodb"]["NewImage"] = {
            "incident_id": {"S": incident_id},
            "severity":    {"S": severity},
            "status":      {"S": status},
            "message":     {"S": message},
            "resource":    {"S": resource},
            "timestamp":   {"S": timestamp},
        }
    return record


# ── _extract_dynamo_value のテスト ────────────────────────────────────

class TestExtractDynamoValue:
    def test_文字列型を返す(self):
        assert _extract_dynamo_value({"S": "CRITICAL"}) == "CRITICAL"

    def test_数値型を返す(self):
        assert _extract_dynamo_value({"N": "42"}) == "42"

    def test_真偽値型を返す(self):
        assert _extract_dynamo_value({"BOOL": True}) == "True"


# ── _build_message のテスト ───────────────────────────────────────────

class TestBuildMessage:
    def test_CRITICAL件名にCRITICALラベルが含まれる(self):
        new_image = {
            "incident_id": {"S": "inc-001"},
            "severity":    {"S": "CRITICAL"},
            "status":      {"S": "OPEN"},
            "message":     {"S": "テスト"},
            "resource":    {"S": "i-abc"},
            "timestamp":   {"S": "2026-06-04T10:00:00Z"},
        }
        subject, body = _build_message(new_image)

        assert "[CRITICAL]" in subject
        assert "inc-001" in subject
        assert "CRITICAL" in body
        assert "テスト" in body

    def test_HIGH件名にHIGHラベルが含まれる(self):
        new_image = {
            "incident_id": {"S": "inc-002"},
            "severity":    {"S": "HIGH"},
            "status":      {"S": "OPEN"},
        }
        subject, _ = _build_message(new_image)

        assert "[HIGH]" in subject


# ── handler のテスト ─────────────────────────────────────────────────

class TestHandler:
    @patch("index.sns")
    def test_CRITICAL_INSERTが成功する(self, mock_sns):
        mock_sns.publish.return_value = {"MessageId": "msg-001"}

        result = handler([_make_dynamo_record(severity="CRITICAL")], MagicMock())

        mock_sns.publish.assert_called_once()
        assert len(result["processed"]) == 1
        assert result["processed"][0]["status"] == "success"
        assert result["processed"][0]["severity"] == "CRITICAL"
        assert result["processed"][0]["incident_id"] == "inc-001"
        assert result["errors"] == []

    @patch("index.sns")
    def test_HIGH_MODIFYが成功する(self, mock_sns):
        mock_sns.publish.return_value = {"MessageId": "msg-002"}

        result = handler(
            [_make_dynamo_record(event_name="MODIFY", severity="HIGH")],
            MagicMock(),
        )

        assert result["processed"][0]["severity"] == "HIGH"
        assert result["processed"][0]["status"] == "success"

    @patch("index.sns")
    def test_REMOVEイベントはスキップされる(self, mock_sns):
        result = handler(
            [_make_dynamo_record(event_name="REMOVE")],
            MagicMock(),
        )

        mock_sns.publish.assert_not_called()
        assert result["skipped"][0]["status"] == "skipped"
        assert result["skipped"][0]["eventName"] == "REMOVE"
        assert result["processed"] == []

    @patch("index.sns")
    def test_NewImageが空のレコードはスキップされる(self, mock_sns):
        result = handler(
            [_make_dynamo_record(include_new_image=False)],
            MagicMock(),
        )

        mock_sns.publish.assert_not_called()
        assert result["skipped"][0]["reason"] == "empty NewImage"

    @patch("index.sns")
    def test_SNSエラーはerrors配列に格納される(self, mock_sns):
        mock_sns.publish.side_effect = Exception("SNS unavailable")

        result = handler([_make_dynamo_record()], MagicMock())

        assert result["errors"][0]["status"] == "error"
        assert "SNS unavailable" in result["errors"][0]["reason"]
        assert result["processed"] == []

    @patch("index.sns")
    def test_dict形式のイベントでも動作する(self, mock_sns):
        """Pipes ではなく直接 Lambda を invoke した場合（dict 形式）でも動作すること"""
        mock_sns.publish.return_value = {"MessageId": "msg-direct"}
        event = _make_dynamo_record(incident_id="inc-direct")

        result = handler(event, MagicMock())

        assert result["processed"][0]["incident_id"] == "inc-direct"
        assert result["processed"][0]["status"] == "success"

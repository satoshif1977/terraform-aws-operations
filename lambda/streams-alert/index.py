"""
DynamoDB Streams → EventBridge Pipes 経由で呼び出されるインシデントアラートハンドラー

フロー:
  DynamoDB Streams（incidents テーブルの INSERT/MODIFY）
    → EventBridge Pipes（severity=HIGH/CRITICAL かつ status=OPEN のみ通過）
      → このハンドラー
        → SNS でメール通知

EventBridge Pipes + Lambda の event 形式:
  Pipes は DynamoDB Streams レコードをリスト形式で渡す（batch_size=1 なら 1 要素）
  [{
    "eventName": "INSERT",
    "dynamodb": {
      "NewImage": {
        "incident_id": {"S": "inc-001"},
        "severity":    {"S": "CRITICAL"},
        "status":      {"S": "OPEN"},
        "message":     {"S": "EC2 CPU 90%超過"},
        "resource":    {"S": "i-1234567890abcdef0"},
        "timestamp":   {"S": "2026-06-04T10:00:00Z"},
      }
    }
  }]
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

import boto3

# ── ロガー設定 ─────────────────────────────────────────────────────────
logger = logging.getLogger()
logger.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

# ── クライアント初期化（コンテナ再利用で再生成しない） ────────────────
sns = boto3.client("sns", region_name=os.environ.get("AWS_REGION", "ap-northeast-1"))
SNS_TOPIC_ARN: str = os.environ["SNS_TOPIC_ARN"]

# ── 重大度ラベル ──────────────────────────────────────────────────────
SEVERITY_LABEL: dict[str, str] = {
    "CRITICAL": "[CRITICAL]",
    "HIGH":     "[HIGH]",
    "MEDIUM":   "[MEDIUM]",
    "LOW":      "[LOW]",
}

# ── 処理対象イベント ──────────────────────────────────────────────────
PROCESSABLE_EVENTS = frozenset({"INSERT", "MODIFY"})


# ── ヘルパー ──────────────────────────────────────────────────────────

def _extract_dynamo_value(attr: dict[str, Any]) -> str:
    """DynamoDB AttributeValue（{"S": "..."} 形式）から文字列値を取り出す。"""
    for type_key in ("S", "N", "BOOL"):
        if type_key in attr:
            return str(attr[type_key])
    return str(attr)


def _build_message(new_image: dict[str, Any]) -> tuple[str, str]:
    """
    DynamoDB NewImage から SNS 件名と本文を生成する。

    Args:
        new_image: DynamoDB Streams レコードの NewImage フィールド

    Returns:
        (subject, message) のタプル
    """
    incident_id = _extract_dynamo_value(new_image.get("incident_id", {"S": "UNKNOWN"}))
    timestamp   = _extract_dynamo_value(new_image.get("timestamp",   {"S": "UNKNOWN"}))
    severity    = _extract_dynamo_value(new_image.get("severity",    {"S": "UNKNOWN"}))
    status      = _extract_dynamo_value(new_image.get("status",      {"S": "UNKNOWN"}))
    message     = _extract_dynamo_value(new_image.get("message",     {"S": "（詳細なし）"}))
    resource    = _extract_dynamo_value(new_image.get("resource",    {"S": "（不明）"}))

    label = SEVERITY_LABEL.get(severity, f"[{severity}]")
    subject = f"[インシデント] {label} {incident_id[:50]}"

    body = "\n".join([
        "インシデントアラート",
        "=" * 50,
        "",
        f"インシデントID: {incident_id}",
        f"重大度        : {severity} {label}",
        f"ステータス    : {status}",
        f"発生時刻      : {timestamp}",
        "",
        "対象リソース:",
        f"  {resource}",
        "",
        "詳細:",
        f"  {message}",
        "",
        "─" * 50,
        "-- 自動通知: terraform-aws-operations / streams-alert",
    ])

    return subject, body


# ── ハンドラー ────────────────────────────────────────────────────────

def handler(
    event: list[dict[str, Any]] | dict[str, Any],
    context: Any,
) -> dict[str, Any]:
    """
    EventBridge Pipes から DynamoDB Streams レコードを受け取り SNS へ通知する。
    batch_size=1 のため通常は 1 要素のリストを受け取るが、複数要素にも対応する。
    直接 Lambda を invoke した場合（dict 形式）にも対応する。

    Args:
        event: Pipes から渡される DynamoDB Streams レコードのリスト（または単一 dict）
        context: Lambda コンテキスト

    Returns:
        processed / skipped / errors を含む辞書
    """
    records = event if isinstance(event, list) else [event]
    logger.info("streams-alert handler 起動: %d レコード", len(records))

    processed: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []

    for record in records:
        event_name: str = record.get("eventName", "")
        dynamo: dict = record.get("dynamodb", {})
        new_image: dict = dynamo.get("NewImage", {})

        # INSERT / MODIFY のみ処理（REMOVE はスキップ）
        if event_name not in PROCESSABLE_EVENTS:
            logger.info("eventName=%s をスキップ（対象外）", event_name)
            skipped.append({"eventName": event_name, "status": "skipped", "reason": "non-target event"})
            continue

        if not new_image:
            logger.warning("NewImage が空のレコードをスキップ: eventName=%s", event_name)
            skipped.append({"eventName": event_name, "status": "skipped", "reason": "empty NewImage"})
            continue

        try:
            subject, body = _build_message(new_image)
            response = sns.publish(
                TopicArn=SNS_TOPIC_ARN,
                Subject=subject[:100],  # SNS 件名は 100 文字制限
                Message=body,
            )
            incident_id = _extract_dynamo_value(new_image.get("incident_id", {"S": "UNKNOWN"}))
            severity    = _extract_dynamo_value(new_image.get("severity",    {"S": "UNKNOWN"}))
            logger.info(
                "SNS 通知成功: incident_id=%s severity=%s MessageId=%s",
                incident_id, severity, response.get("MessageId"),
            )
            processed.append({
                "incident_id": incident_id,
                "severity": severity,
                "status": "success",
                "message_id": response.get("MessageId"),
            })

        except Exception as e:
            logger.error("SNS 通知エラー: record=%s error=%s", json.dumps(record, default=str), e)
            errors.append({"status": "error", "reason": str(e)})

    logger.info(
        "処理完了: 成功=%d / スキップ=%d / エラー=%d",
        len(processed), len(skipped), len(errors),
    )
    return {"processed": processed, "skipped": skipped, "errors": errors}

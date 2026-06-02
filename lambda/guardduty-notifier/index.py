"""
GuardDuty Finding Notifier
EventBridge 経由で受け取った GuardDuty Finding を整形して SNS へ通知する。

アーキテクチャ:
  GuardDuty → EventBridge Rule (severity >= 4.0) → Lambda → SNS → Email
"""

from __future__ import annotations

import json
import logging
import os

import boto3

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

sns = boto3.client("sns")
SNS_TOPIC_ARN: str = os.environ["SNS_TOPIC_ARN"]


# ── 重大度ラベル ─────────────────────────────────────────────

def get_severity_label(severity: float) -> str:
    """GuardDuty の数値重大度を日本語ラベルに変換する。"""
    if severity >= 9.0:
        return "[CRITICAL]"
    elif severity >= 7.0:
        return "[HIGH]"
    elif severity >= 4.0:
        return "[MEDIUM]"
    else:
        return "[LOW]"


# ── メッセージ整形 ───────────────────────────────────────────

def build_message(detail: dict) -> tuple[str, str]:
    """
    GuardDuty Finding detail から SNS の件名と本文を生成する。

    Args:
        detail: EventBridge イベントの detail フィールド

    Returns:
        (subject, message) のタプル
    """
    severity: float = detail.get("severity", 0.0)
    title: str = detail.get("title", "Unknown")
    description: str = detail.get("description", "")
    finding_type: str = detail.get("type", "")
    region: str = detail.get("region", "")
    account_id: str = detail.get("accountId", "")
    finding_id: str = detail.get("id", "")

    severity_label = get_severity_label(severity)
    subject = f"[GuardDuty] {severity_label} {title[:60]}"

    console_url = (
        f"https://{region}.console.aws.amazon.com/guardduty/home"
        f"?region={region}#/findings?macros=current&fId={finding_id}"
    )

    message = "\n".join([
        f"GuardDuty セキュリティアラート",
        f"{'=' * 50}",
        f"",
        f"重大度  : {severity} {severity_label}",
        f"タイプ  : {finding_type}",
        f"タイトル: {title}",
        f"",
        f"説明:",
        f"  {description}",
        f"",
        f"{'─' * 50}",
        f"リージョン  : {region}",
        f"アカウント  : {account_id}",
        f"Finding ID  : {finding_id}",
        f"",
        f"コンソールで確認:",
        f"  {console_url}",
        f"",
        f"-- 自動通知: terraform-aws-operations / guardduty-notifier",
    ])

    return subject, message


# ── ハンドラー ───────────────────────────────────────────────

def lambda_handler(event: dict, context: object) -> dict:
    """
    EventBridge から GuardDuty Finding を受け取り SNS へ通知する。

    Args:
        event: EventBridge イベント（source: aws.guardduty）
        context: Lambda コンテキスト

    Returns:
        statusCode と body を含む辞書
    """
    logger.info("Received event: %s", json.dumps(event))

    detail: dict = event.get("detail", {})
    if not detail:
        logger.warning("Empty detail in event. Skipping.")
        return {"statusCode": 400, "body": "Empty detail"}

    subject, message = build_message(detail)

    response = sns.publish(
        TopicArn=SNS_TOPIC_ARN,
        Subject=subject[:100],  # SNS 件名は 100 文字制限
        Message=message,
    )

    logger.info(
        "SNS publish succeeded. MessageId=%s severity=%.1f title=%s",
        response.get("MessageId"),
        detail.get("severity", 0.0),
        detail.get("title", ""),
    )

    return {"statusCode": 200, "body": "Notification sent"}

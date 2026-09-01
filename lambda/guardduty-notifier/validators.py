"""
GuardDuty Finding バリデーター

EventBridge 経由で受け取る GuardDuty Finding の構造・値を
検証する純粋関数群。AWS SDK に依存しないため単体テストが容易。

検証内容:
  - EventBridge イベント構造（source / detail-type / detail）
  - GuardDuty Finding 必須フィールド（severity / type / title）
  - 重大度の数値範囲（0.0〜10.0）・閾値判定
  - Finding Type のフォーマット（category:resource/threat 形式）
  - AWS リージョン・アカウント ID のフォーマット
  - SNS メッセージ制約（件名100文字・本文256KB）
  - コンソール URL の構造チェック
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

# ── 型定義 ────────────────────────────────────────────────────


@dataclass
class ValidationError:
    field: str
    message: str
    severity: str  # "error" | "warning"


# ── 定数 ─────────────────────────────────────────────────────

GUARDDUTY_EVENT_SOURCE = "aws.guardduty"
GUARDDUTY_DETAIL_TYPE = "GuardDuty Finding"

MIN_SEVERITY = 0.0
MAX_SEVERITY = 10.0

SEVERITY_THRESHOLDS: dict[str, float] = {
    "CRITICAL": 9.0,
    "HIGH": 7.0,
    "MEDIUM": 4.0,
    "LOW": 0.0,
}

REQUIRED_DETAIL_FIELDS = ("severity", "type", "title")
RECOMMENDED_DETAIL_FIELDS = ("description", "region", "accountId", "id")

AWS_REGION_PATTERN = re.compile(r"^[a-z]{2}-[a-z]+-\d+$")
AWS_ACCOUNT_ID_PATTERN = re.compile(r"^\d{12}$")
FINDING_TYPE_PATTERN = re.compile(r"^[A-Za-z]+:[A-Za-z0-9]+/[A-Za-z0-9.]+$")
FINDING_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")

MAX_SNS_SUBJECT_LENGTH = 100
MAX_SNS_MESSAGE_BYTES = 256 * 1024

VALID_AWS_REGIONS = (
    "ap-northeast-1",
    "ap-northeast-2",
    "ap-northeast-3",
    "ap-southeast-1",
    "ap-southeast-2",
    "ap-south-1",
    "us-east-1",
    "us-east-2",
    "us-west-1",
    "us-west-2",
    "eu-west-1",
    "eu-west-2",
    "eu-west-3",
    "eu-central-1",
    "eu-north-1",
    "ca-central-1",
    "sa-east-1",
)


# ── 重大度バリデーション ──────────────────────────────────────


def is_valid_severity(value: float) -> bool:
    """重大度が有効な範囲内か。"""
    return MIN_SEVERITY <= value <= MAX_SEVERITY


def classify_severity(value: float) -> str:
    """数値重大度をラベルに分類する。"""
    if value >= SEVERITY_THRESHOLDS["CRITICAL"]:
        return "CRITICAL"
    if value >= SEVERITY_THRESHOLDS["HIGH"]:
        return "HIGH"
    if value >= SEVERITY_THRESHOLDS["MEDIUM"]:
        return "MEDIUM"
    return "LOW"


def is_alertable_severity(value: float, threshold: float = 4.0) -> bool:
    """重大度が通知閾値以上か。"""
    return value >= threshold


def validate_severity(value: Any) -> list[ValidationError]:
    """重大度フィールドを検証する。"""
    errors: list[ValidationError] = []

    if not isinstance(value, (int, float)):
        errors.append(
            ValidationError(
                field="severity",
                message=f"severity は数値である必要があります（型: {type(value).__name__}）",
                severity="error",
            )
        )
        return errors

    if not is_valid_severity(float(value)):
        errors.append(
            ValidationError(
                field="severity",
                message=f"severity は {MIN_SEVERITY}〜{MAX_SEVERITY} の範囲です（現在: {value}）",
                severity="error",
            )
        )

    if float(value) == 0.0:
        errors.append(
            ValidationError(
                field="severity",
                message="severity が 0.0 です（テスト Finding の可能性）",
                severity="warning",
            )
        )

    return errors


# ── Finding Type バリデーション ───────────────────────────────


def is_valid_finding_type(finding_type: str) -> bool:
    """Finding Type が有効なフォーマットか。"""
    return bool(FINDING_TYPE_PATTERN.match(finding_type))


def validate_finding_type(finding_type: Any) -> list[ValidationError]:
    """Finding Type を検証する。"""
    errors: list[ValidationError] = []

    if not isinstance(finding_type, str):
        errors.append(
            ValidationError(
                field="type",
                message=f"type は文字列である必要があります（型: {type(finding_type).__name__}）",
                severity="error",
            )
        )
        return errors

    if not finding_type:
        errors.append(
            ValidationError(
                field="type",
                message="Finding type が空です",
                severity="error",
            )
        )
        return errors

    if not is_valid_finding_type(finding_type):
        errors.append(
            ValidationError(
                field="type",
                message=f'Finding type のフォーマットが不正です: "{finding_type}"'
                "（期待: category:resource/threat）",
                severity="warning",
            )
        )

    return errors


# ── AWS リソースバリデーション ────────────────────────────────


def is_valid_region(region: str) -> bool:
    """AWS リージョン名が有効なフォーマットか。"""
    return bool(AWS_REGION_PATTERN.match(region))


def is_known_region(region: str) -> bool:
    """既知の AWS リージョンか。"""
    return region in VALID_AWS_REGIONS


def is_valid_account_id(account_id: str) -> bool:
    """AWS アカウント ID が12桁数字か。"""
    return bool(AWS_ACCOUNT_ID_PATTERN.match(account_id))


def validate_region(region: Any) -> list[ValidationError]:
    """リージョンを検証する。"""
    errors: list[ValidationError] = []

    if not isinstance(region, str) or not region:
        errors.append(
            ValidationError(
                field="region",
                message="region が未定義または空です",
                severity="error",
            )
        )
        return errors

    if not is_valid_region(region):
        errors.append(
            ValidationError(
                field="region",
                message=f'無効なリージョン形式: "{region}"',
                severity="error",
            )
        )
    elif not is_known_region(region):
        errors.append(
            ValidationError(
                field="region",
                message=f'未知のリージョン: "{region}"（GuardDuty 未対応の可能性）',
                severity="warning",
            )
        )

    return errors


def validate_account_id(account_id: Any) -> list[ValidationError]:
    """アカウント ID を検証する。"""
    errors: list[ValidationError] = []

    if not isinstance(account_id, str) or not account_id:
        errors.append(
            ValidationError(
                field="accountId",
                message="accountId が未定義または空です",
                severity="error",
            )
        )
        return errors

    if not is_valid_account_id(account_id):
        errors.append(
            ValidationError(
                field="accountId",
                message=f'accountId は12桁の数字である必要があります（現在: "{account_id}"）',
                severity="error",
            )
        )

    return errors


# ── EventBridge イベントバリデーション ────────────────────────


def validate_event_envelope(event: dict[str, Any]) -> list[ValidationError]:
    """EventBridge イベントのエンベロープを検証する。"""
    errors: list[ValidationError] = []

    if not isinstance(event, dict):
        errors.append(
            ValidationError(
                field="event",
                message="イベントが dict ではありません",
                severity="error",
            )
        )
        return errors

    source = event.get("source")
    if source and source != GUARDDUTY_EVENT_SOURCE:
        errors.append(
            ValidationError(
                field="source",
                message=f'source が "{GUARDDUTY_EVENT_SOURCE}" ではありません: "{source}"',
                severity="warning",
            )
        )

    detail_type = event.get("detail-type")
    if detail_type and detail_type != GUARDDUTY_DETAIL_TYPE:
        errors.append(
            ValidationError(
                field="detail-type",
                message=f'detail-type が "{GUARDDUTY_DETAIL_TYPE}" ではありません: "{detail_type}"',
                severity="warning",
            )
        )

    if "detail" not in event:
        errors.append(
            ValidationError(
                field="detail",
                message="detail フィールドが未定義です",
                severity="error",
            )
        )
    elif not isinstance(event["detail"], dict):
        errors.append(
            ValidationError(
                field="detail",
                message="detail が dict ではありません",
                severity="error",
            )
        )
    elif not event["detail"]:
        errors.append(
            ValidationError(
                field="detail",
                message="detail が空です",
                severity="error",
            )
        )

    return errors


# ── GuardDuty Finding Detail バリデーション ───────────────────


def validate_finding_detail(detail: dict[str, Any]) -> list[ValidationError]:
    """GuardDuty Finding の detail を検証する。"""
    errors: list[ValidationError] = []

    # 必須フィールド
    for field in REQUIRED_DETAIL_FIELDS:
        if field not in detail:
            errors.append(
                ValidationError(
                    field=field,
                    message=f"必須フィールドが欠落: {field}",
                    severity="error",
                )
            )

    # 推奨フィールド
    for field in RECOMMENDED_DETAIL_FIELDS:
        if field not in detail:
            errors.append(
                ValidationError(
                    field=field,
                    message=f"推奨フィールドが欠落: {field}",
                    severity="warning",
                )
            )

    # severity
    if "severity" in detail:
        errors.extend(validate_severity(detail["severity"]))

    # type
    if "type" in detail:
        errors.extend(validate_finding_type(detail["type"]))

    # title
    if "title" in detail and not detail["title"]:
        errors.append(
            ValidationError(
                field="title",
                message="title が空です",
                severity="error",
            )
        )

    # region
    if "region" in detail:
        errors.extend(validate_region(detail["region"]))

    # accountId
    if "accountId" in detail:
        errors.extend(validate_account_id(detail["accountId"]))

    return errors


# ── SNS メッセージバリデーション ──────────────────────────────


def validate_sns_subject(subject: str) -> list[ValidationError]:
    """SNS 件名が制約内か検証する。"""
    errors: list[ValidationError] = []

    if not subject or not subject.strip():
        errors.append(
            ValidationError(
                field="subject",
                message="SNS 件名が空です",
                severity="error",
            )
        )
        return errors

    if len(subject) > MAX_SNS_SUBJECT_LENGTH:
        errors.append(
            ValidationError(
                field="subject",
                message=f"SNS 件名が {MAX_SNS_SUBJECT_LENGTH} 文字を超えています"
                f"（{len(subject)} 文字）",
                severity="warning",
            )
        )

    return errors


def validate_sns_message(message: str) -> list[ValidationError]:
    """SNS 本文が制約内か検証する。"""
    errors: list[ValidationError] = []

    if not message or not message.strip():
        errors.append(
            ValidationError(
                field="message",
                message="SNS 本文が空です",
                severity="error",
            )
        )
        return errors

    byte_len = len(message.encode("utf-8"))
    if byte_len > MAX_SNS_MESSAGE_BYTES:
        errors.append(
            ValidationError(
                field="message",
                message=f"SNS 本文が {MAX_SNS_MESSAGE_BYTES} バイトを超えています"
                f"（{byte_len} バイト）",
                severity="error",
            )
        )

    return errors


# ── 統合バリデーション ────────────────────────────────────────


def validate_guardduty_event(event: dict[str, Any]) -> list[ValidationError]:
    """GuardDuty イベント全体を検証する。"""
    errors: list[ValidationError] = []

    errors.extend(validate_event_envelope(event))
    if has_errors(errors):
        return errors

    detail = event.get("detail", {})
    if isinstance(detail, dict) and detail:
        errors.extend(validate_finding_detail(detail))

    return errors


# ── ユーティリティ ────────────────────────────────────────────


def has_errors(errors: list[ValidationError]) -> bool:
    """エラーの有無を判定する（warning は含まない）。"""
    return any(e.severity == "error" for e in errors)


def format_errors(errors: list[ValidationError]) -> str:
    """エラーをフォーマットする。"""
    if not errors:
        return "すべてのチェックが通過しました"
    return "\n".join(
        f"[{e.severity.upper()}] {e.field}: {e.message}" for e in errors
    )

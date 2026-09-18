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

ログとメトリクスは同ディレクトリの logger.py / metrics.py に寄せてある。
標準 logging を直接呼ばないのは、インシデントの本文がそのまま CloudWatch Logs に
流れるため、logger.py のマスキング（is_sensitive_key）を必ず通したいから。
同リポジトリの TypeScript 版（lambda_ts/streams-alert/index.ts）および
Go 版（lambda_go/guardduty-notifier）と同じ結線で 3 言語を揃えてある。
"""

from __future__ import annotations

import os
from typing import Any

import boto3
from botocore.config import Config
from logger import StructuredLogger, create_logger_from_env, retry_logger
from metrics import MetricsCollector, create_metrics_from_env, retry_metrics
from retry import RetryConfig, retry_call

# ── メトリクス設定 ────────────────────────────────────────────────────
# 名前空間は TypeScript 版（index.ts の DEFAULT_METRICS_NAMESPACE）と同じ値。
# 3 言語のハンドラーを CloudWatch の同じダッシュボードで並べて見られるようにする。
DEFAULT_METRICS_NAMESPACE = "TerraformAwsOperations/StreamsAlert"

#: リトライのメトリクス・ログに載せる操作名（TypeScript 版と同じ値）
RETRY_OPERATION = "sns:Publish"

# ── リトライ設定 ──────────────────────────────────────────────────────
# 同リポジトリの Go 版（lambda_go/guardduty-notifier/retry.go）および
# TypeScript 版（lambda_ts/streams-alert/index.ts）の既定値と揃えてある。
# 共通モジュール retry.py の既定値（0.5 秒 / 8 秒 / 3 回）より短いのは、
# Streams のハンドラーが 1 回の起動で複数レコードを直列に処理するため、
# 1 レコードあたりの待機がバッチ全体のタイムアウトに直接効いてくるから。
SNS_RETRY_CONFIG = RetryConfig(
    max_attempts=4,
    base_delay=0.1,
    max_delay=5.0,
    jitter=True,
)

# ── クライアント初期化（コンテナ再利用で再生成しない） ────────────────
# botocore の内蔵リトライは切っている。retry.py 側で再試行するため、
# 両方を有効にすると試行回数が掛け算になり、待機時間が読めなくなる。
# 併せて、リトライの発生を on_retry で記録できるようにする狙いもある
# （botocore の内蔵リトライは発生を呼び出し側から観測できない）。
#
# ★ retries に max_attempts を使わないこと。botocore はこれを「リトライ回数」として
#   解釈するため、max_attempts=1 は total_max_attempts=2（＝1 回リトライする）に
#   正規化されてしまう。total_max_attempts で「初回を含む総試行回数」を明示する。
_SNS_CONFIG = Config(retries={"total_max_attempts": 1, "mode": "standard"})
sns = boto3.client(
    "sns",
    region_name=os.environ.get("AWS_REGION", "ap-northeast-1"),
    config=_SNS_CONFIG,
)
SNS_TOPIC_ARN: str = os.environ["SNS_TOPIC_ARN"]

# ── 重大度ラベル ──────────────────────────────────────────────────────
SEVERITY_LABEL: dict[str, str] = {
    "CRITICAL": "[CRITICAL]",
    "HIGH": "[HIGH]",
    "MEDIUM": "[MEDIUM]",
    "LOW": "[LOW]",
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
    timestamp = _extract_dynamo_value(new_image.get("timestamp", {"S": "UNKNOWN"}))
    severity = _extract_dynamo_value(new_image.get("severity", {"S": "UNKNOWN"}))
    status = _extract_dynamo_value(new_image.get("status", {"S": "UNKNOWN"}))
    message = _extract_dynamo_value(new_image.get("message", {"S": "（詳細なし）"}))
    resource = _extract_dynamo_value(new_image.get("resource", {"S": "（不明）"}))

    label = SEVERITY_LABEL.get(severity, f"[{severity}]")
    subject = f"[インシデント] {label} {incident_id[:50]}"

    body = "\n".join(
        [
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
        ]
    )

    return subject, body


def _build_metrics() -> MetricsCollector:
    """
    このハンドラー用の MetricsCollector を組み立てる。

    METRICS_NAMESPACE が未設定のときだけ、共通モジュールの既定値（Application）
    ではなくこのハンドラーの名前空間を使う。METRICS_ENABLED の解釈は
    共通モジュール側に任せて、無効化の条件を 1 か所に保つ。
    """
    env = dict(os.environ)
    env["METRICS_NAMESPACE"] = env.get("METRICS_NAMESPACE") or DEFAULT_METRICS_NAMESPACE
    return create_metrics_from_env(env, Handler="streams-alert")


def _make_retry_hook(
    log: StructuredLogger,
    metrics: MetricsCollector,
) -> Any:
    """
    retry_call の on_retry に渡すコールバックを作る。

    ログとメトリクスの両方へ流す。リトライは「起きていること自体は正常だが、
    頻発したら異常」という事象なので、warn でも残しつつ回数を数えられるようにする。
    """
    log_retry = retry_logger(log, RETRY_OPERATION)
    count_retry = retry_metrics(metrics, RETRY_OPERATION)

    def on_retry(attempt: int, delay: float, exc: BaseException) -> None:
        log_retry(attempt, delay, exc)
        count_retry(attempt, delay, exc)

    return on_retry


# ── ハンドラー ────────────────────────────────────────────────────────


def handler(
    event: list[dict[str, Any]] | dict[str, Any],
    context: Any,
    *,
    logger: StructuredLogger | None = None,
    metrics: MetricsCollector | None = None,
) -> dict[str, Any]:
    """
    EventBridge Pipes から DynamoDB Streams レコードを受け取り SNS へ通知する。
    batch_size=1 のため通常は 1 要素のリストを受け取るが、複数要素にも対応する。
    直接 Lambda を invoke した場合（dict 形式）にも対応する。

    Args:
        event: Pipes から渡される DynamoDB Streams レコードのリスト（または単一 dict）
        context: Lambda コンテキスト
        logger: 差し替え用のロガー（省略時は環境変数から組み立てる）
        metrics: 差し替え用のメトリクス（省略時はこのハンドラーの名前空間で組み立てる）

    Returns:
        processed / skipped / errors を含む辞書
    """
    log = logger or create_logger_from_env()
    # メトリクスは 1 回の起動で 1 ドキュメントにまとめるため、呼び出しごとに作る
    mx = metrics or _build_metrics()

    records = event if isinstance(event, list) else [event]
    log.info("streams-alert handler 起動", record_count=len(records))
    mx.add_metric("RecordsReceived", len(records), unit="Count")

    processed: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []

    for record in records:
        event_name: str = record.get("eventName", "")
        dynamo: dict = record.get("dynamodb", {})
        new_image: dict = dynamo.get("NewImage", {})

        # INSERT / MODIFY のみ処理（REMOVE はスキップ）
        if event_name not in PROCESSABLE_EVENTS:
            log.info(
                "対象外イベントをスキップ",
                event_name=event_name,
                reason="non-target event",
            )
            mx.add_metric("RecordSkipped", 1, unit="Count")
            skipped.append(
                {
                    "eventName": event_name,
                    "status": "skipped",
                    "reason": "non-target event",
                }
            )
            continue

        if not new_image:
            log.warn(
                "NewImage が空のレコードをスキップ",
                event_name=event_name,
                reason="empty NewImage",
            )
            mx.add_metric("RecordSkipped", 1, unit="Count")
            skipped.append(
                {
                    "eventName": event_name,
                    "status": "skipped",
                    "reason": "empty NewImage",
                }
            )
            continue

        incident_id = _extract_dynamo_value(
            new_image.get("incident_id", {"S": "UNKNOWN"})
        )
        severity = _extract_dynamo_value(new_image.get("severity", {"S": "UNKNOWN"}))
        # incident_id / severity を子ロガーに持たせて、以降のログすべてに載せる
        record_log = log.child(incident_id=incident_id, severity=severity)

        try:
            subject, body = _build_message(new_image)
            # スロットリングや一時的な 5xx は指数バックオフで再試行する。
            # 通知が 1 回の失敗で落ちると、検知が誰にも届かないまま終わる。
            with mx.timer("PublishLatency"):
                response = retry_call(
                    sns.publish,
                    TopicArn=SNS_TOPIC_ARN,
                    Subject=subject[:100],  # SNS 件名は 100 文字制限
                    Message=body,
                    config=SNS_RETRY_CONFIG,
                    on_retry=_make_retry_hook(record_log, mx),
                )
            record_log.info("SNS 通知成功", message_id=response.get("MessageId"))
            mx.add_metric("NotificationSuccess", 1, unit="Count")
            processed.append(
                {
                    "incident_id": incident_id,
                    "severity": severity,
                    "status": "success",
                    "message_id": response.get("MessageId"),
                }
            )

        except Exception as e:  # noqa: BLE001
            # 例外はそのまま渡す。logger 側が type / message / stack にだけ展開するため、
            # AWS SDK の例外が抱えている署名ヘッダーなどの付帯情報はログに出ない。
            # レコード全体を出さないのも同じ理由（本文は SNS へ送る中身そのもの）。
            record_log.error("SNS 通知エラー", error=e)
            mx.add_metric("NotificationError", 1, unit="Count")
            errors.append(
                {
                    "incident_id": incident_id,
                    "severity": severity,
                    "status": "error",
                    "reason": str(e),
                }
            )

    log.info(
        "処理完了",
        processed=len(processed),
        skipped=len(skipped),
        errors=len(errors),
    )
    # EMF は 1 行の JSON を標準出力に書くだけなので、ここでの失敗は本処理に影響しない
    mx.flush()

    return {"processed": processed, "skipped": skipped, "errors": errors}

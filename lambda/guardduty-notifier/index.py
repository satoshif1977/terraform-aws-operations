"""
GuardDuty Finding Notifier
EventBridge 経由で受け取った GuardDuty Finding を整形して SNS へ通知する。

アーキテクチャ:
  GuardDuty → EventBridge Rule (severity >= 4.0) → Lambda → SNS → Email

ログとメトリクスは同ディレクトリの logger.py / metrics.py に寄せてある。
標準 logging を直接呼ばないのは、Finding の description に調査対象のホスト名や
IP がそのまま入るため、logger.py のマスキング（is_sensitive_key）を必ず
通したいから。同リポジトリの streams-alert（lambda/streams-alert/index.py）
および Go 版（lambda_go/guardduty-notifier）と同じ結線で揃えてある。
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
# 名前空間は streams-alert（TerraformAwsOperations/StreamsAlert）と同じ形に揃える。
# ハンドラーごとに分けておくと、CloudWatch のダッシュボードで並べたときに
# どの通知経路が詰まっているかを切り分けられる。
DEFAULT_METRICS_NAMESPACE = "TerraformAwsOperations/GuarddutyNotifier"

#: リトライのメトリクス・ログに載せる操作名（streams-alert と同じ値）
RETRY_OPERATION = "sns:Publish"

# ── リトライ設定 ──────────────────────────────────────────────────────
# 同リポジトリの streams-alert（lambda/streams-alert/index.py）および
# Go 版（lambda_go/guardduty-notifier/retry.go）の既定値と揃えてある。
# 共通モジュール retry.py の既定値（0.5 秒 / 8 秒 / 3 回）より短いのは、
# EventBridge のイベント配信にも再試行があり、Lambda 側で粘りすぎると
# 同じ Finding の通知が二重に飛びやすくなるため。
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

    message = "\n".join(
        [
            "GuardDuty セキュリティアラート",
            f"{'=' * 50}",
            "",
            f"重大度  : {severity} {severity_label}",
            f"タイプ  : {finding_type}",
            f"タイトル: {title}",
            "",
            "説明:",
            f"  {description}",
            "",
            f"{'─' * 50}",
            f"リージョン  : {region}",
            f"アカウント  : {account_id}",
            f"Finding ID  : {finding_id}",
            "",
            "コンソールで確認:",
            f"  {console_url}",
            "",
            "-- 自動通知: terraform-aws-operations / guardduty-notifier",
        ]
    )

    return subject, message


# ── 観測ヘルパー ─────────────────────────────────────────────


def _build_metrics() -> MetricsCollector:
    """
    このハンドラー用の MetricsCollector を組み立てる。

    METRICS_NAMESPACE が未設定のときだけ、共通モジュールの既定値（Application）
    ではなくこのハンドラーの名前空間を使う。METRICS_ENABLED の解釈は
    共通モジュール側に任せて、無効化の条件を 1 か所に保つ。
    """
    env = dict(os.environ)
    env["METRICS_NAMESPACE"] = env.get("METRICS_NAMESPACE") or DEFAULT_METRICS_NAMESPACE
    return create_metrics_from_env(env, Handler="guardduty-notifier")


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


# ── ハンドラー ───────────────────────────────────────────────


def lambda_handler(
    event: dict,
    context: Any,
    *,
    logger: StructuredLogger | None = None,
    metrics: MetricsCollector | None = None,
) -> dict:
    """
    EventBridge から GuardDuty Finding を受け取り SNS へ通知する。

    Args:
        event: EventBridge イベント（source: aws.guardduty）
        context: Lambda コンテキスト
        logger: 差し替え用のロガー（省略時は環境変数から組み立てる）
        metrics: 差し替え用のメトリクス（省略時はこのハンドラーの名前空間で組み立てる）

    Returns:
        statusCode と body を含む辞書
    """
    log = logger or create_logger_from_env()
    # メトリクスは 1 回の起動で 1 ドキュメントにまとめるため、呼び出しごとに作る
    mx = metrics or _build_metrics()

    detail: dict = event.get("detail", {})
    if not detail:
        # イベント全文は出さない。detail が空でも EventBridge のラッパーには
        # アカウント ID やリソース ARN が載るため、理由だけを残す。
        log.warn("detail が空のイベントをスキップ", reason="empty detail")
        mx.add_metric("FindingSkipped", 1, unit="Count")
        mx.flush()
        return {"statusCode": 400, "body": "Empty detail"}

    severity: float = detail.get("severity", 0.0)
    severity_label = get_severity_label(severity)
    # finding_id / severity を子ロガーに持たせて、以降のログすべてに載せる
    finding_log = log.child(
        finding_id=detail.get("id", ""),
        severity=severity,
        severity_label=severity_label,
    )

    finding_log.info("GuardDuty Finding を受信", finding_type=detail.get("type", ""))
    mx.add_metric("FindingsReceived", 1, unit="Count")
    mx.add_metric("FindingSeverity", severity, unit="None")

    subject, message = build_message(detail)

    try:
        # スロットリングや一時的な 5xx は指数バックオフで再試行する。
        # 通知が 1 回の失敗で落ちると、検知が誰にも届かないまま終わる。
        with mx.timer("PublishLatency"):
            response = retry_call(
                sns.publish,
                TopicArn=SNS_TOPIC_ARN,
                Subject=subject[:100],  # SNS 件名は 100 文字制限
                Message=message,
                config=SNS_RETRY_CONFIG,
                on_retry=_make_retry_hook(finding_log, mx),
            )
    except Exception as e:  # noqa: BLE001
        # 例外はそのまま渡す。logger 側が type / message / stack にだけ展開するため、
        # AWS SDK の例外が抱えている署名ヘッダーなどの付帯情報はログに出ない。
        finding_log.error("SNS 通知エラー", error=e)
        mx.add_metric("NotificationError", 1, unit="Count")
        # 送出前に流しておく。ここで落ちるとメトリクスごと失われ、
        # 「通知が届かない」ことにしばらく誰も気づけなくなる。
        mx.flush()
        # 再送出して Lambda を失敗させる。EventBridge 側の再試行に委ねたほうが、
        # ここで握りつぶして 200 を返すより検知の取りこぼしが少ない。
        raise

    finding_log.info("SNS 通知成功", message_id=response.get("MessageId"))
    mx.add_metric("NotificationSuccess", 1, unit="Count")
    # EMF は 1 行の JSON を標準出力に書くだけなので、ここでの失敗は本処理に影響しない
    mx.flush()

    return {"statusCode": 200, "body": "Notification sent"}

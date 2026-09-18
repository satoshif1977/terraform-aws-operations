"""
AWS API 呼び出し向け リトライユーティリティ

SNS の Publish がスロットリング（ThrottlingException）や一時的な 5xx で
失敗したときに、AWS 公式推奨の「指数バックオフ + フルジッター」方式で
自動リトライする。インシデントのアラート通知を送る経路なので、1 回の失敗で
通知が落ちると、検知そのものが誰にも気づかれないまま終わってしまう。

同リポジトリの TypeScript 版（lambda_ts/streams-alert/retry.ts）および
Go 版（lambda_go/guardduty-notifier/retry.go）と同じ設計思想の並置実装。

設計方針:
  - sleep / rand を注入可能にして、テストを決定的かつ実待機ゼロに保つ
  - リトライ不能な例外（ValidationException / AccessDeniedException 等）は即座に再送出する
  - 最終試行でも失敗した場合は元の例外をそのまま再送出する
    （呼び出し側の `except ClientError` を壊さないため、独自例外でラップしない）

使い方:
    response = retry_call(sns.publish, TopicArn=..., Subject=..., Message=...)
"""

from __future__ import annotations

import logging
import random
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, TypeVar

from botocore.exceptions import (
    ClientError,
    ConnectTimeoutError,
    EndpointConnectionError,
    ReadTimeoutError,
)

logger = logging.getLogger(__name__)

T = TypeVar("T")

# ── リトライ対象の判定基準 ─────────────────────────────────
# AWS が「時間をおけば成功しうる」と定義しているエラーコード群
RETRYABLE_ERROR_CODES: frozenset[str] = frozenset(
    {
        # スロットリング系
        "ThrottlingException",
        "Throttling",
        "ThrottledException",
        "TooManyRequestsException",
        "RequestLimitExceeded",
        "ProvisionedThroughputExceededException",
        "SlowDown",
        # サーバ側の一時障害
        "InternalServerException",
        "InternalServerError",
        "InternalFailure",
        "ServiceUnavailable",
        "ServiceUnavailableException",
        # タイムアウト系
        "RequestTimeout",
        "RequestTimeoutException",
        "ModelTimeoutException",
        # Bedrock: モデルのウォームアップ待ち
        "ModelNotReadyException",
    }
)

# ステータスコードだけで判定できる一時エラー（429 / 5xx）
RETRYABLE_STATUS_CODES: frozenset[int] = frozenset({429, 500, 502, 503, 504})

# ネットワーク層の一時障害（botocore が送出する例外）
RETRYABLE_EXCEPTIONS: tuple[type[BaseException], ...] = (
    ConnectTimeoutError,
    ReadTimeoutError,
    EndpointConnectionError,
)


# ── 設定 ───────────────────────────────────────────────────
@dataclass(frozen=True)
class RetryConfig:
    """
    リトライ挙動の設定。

    max_attempts: 最大試行回数（初回を含む）。1 ならリトライしない
    base_delay  : 1 回目のリトライ前の基準待機秒数
    max_delay   : 指数バックオフの上限秒数（これ以上は待たない）
    jitter      : True でフルジッター（0〜上限のランダム待機）を有効化
    """

    max_attempts: int = 3
    base_delay: float = 0.5
    max_delay: float = 8.0
    jitter: bool = True

    def __post_init__(self) -> None:
        if self.max_attempts < 1:
            raise ValueError("max_attempts は 1 以上で指定してください")
        if self.base_delay <= 0:
            raise ValueError("base_delay は 0 より大きい値で指定してください")
        if self.max_delay < self.base_delay:
            raise ValueError("max_delay は base_delay 以上で指定してください")


DEFAULT_CONFIG = RetryConfig()


# ── 判定ヘルパー ───────────────────────────────────────────
def extract_error_code(exc: BaseException) -> str:
    """ClientError から AWS エラーコードを取り出す（取得できなければ空文字）"""
    if not isinstance(exc, ClientError):
        return ""
    response = getattr(exc, "response", None)
    if not isinstance(response, dict):
        return ""
    error = response.get("Error")
    if not isinstance(error, dict):
        return ""
    code = error.get("Code", "")
    return code if isinstance(code, str) else ""


def extract_status_code(exc: BaseException) -> int | None:
    """ClientError から HTTP ステータスコードを取り出す（取得できなければ None）"""
    if not isinstance(exc, ClientError):
        return None
    response = getattr(exc, "response", None)
    if not isinstance(response, dict):
        return None
    metadata = response.get("ResponseMetadata")
    if not isinstance(metadata, dict):
        return None
    status = metadata.get("HTTPStatusCode")
    return status if isinstance(status, int) else None


def is_retryable(exc: BaseException) -> bool:
    """例外がリトライ対象かどうかを判定する"""
    if isinstance(exc, RETRYABLE_EXCEPTIONS):
        return True
    if not isinstance(exc, ClientError):
        return False
    if extract_error_code(exc) in RETRYABLE_ERROR_CODES:
        return True
    return extract_status_code(exc) in RETRYABLE_STATUS_CODES


def compute_delay(
    attempt: int,
    config: RetryConfig = DEFAULT_CONFIG,
    rand: Callable[[], float] = random.random,
) -> float:
    """
    指定回目のリトライ前に待つ秒数を計算する。

    attempt は 1 始まり（1 回目のリトライ = 1）。
    指数バックオフ（base_delay * 2^(attempt-1)）を max_delay で頭打ちにし、
    jitter が有効なら 0〜その値のランダム秒に散らす（フルジッター）。
    同時に失敗した複数クライアントがリトライで再衝突するのを防ぐ。
    """
    if attempt < 1:
        raise ValueError("attempt は 1 以上で指定してください")

    # 2^(attempt-1) は attempt が大きいと巨大になるため min() で先に頭打ちにする
    exponent = min(attempt - 1, 32)
    capped = min(config.base_delay * (2**exponent), config.max_delay)
    return capped * rand() if config.jitter else capped


# ── メイン処理 ─────────────────────────────────────────────
def retry_call(
    func: Callable[..., T],
    *args: Any,
    config: RetryConfig = DEFAULT_CONFIG,
    sleep: Callable[[float], None] = time.sleep,
    rand: Callable[[], float] = random.random,
    on_retry: Callable[[int, float, BaseException], None] | None = None,
    **kwargs: Any,
) -> T:
    """
    func を実行し、リトライ可能な例外が出たら指数バックオフで再試行する。

    リトライ不能な例外・最終試行での失敗は、元の例外をそのまま再送出する。
    on_retry には (試行回数, 待機秒数, 例外) が渡される（ログ出力などに使う）。
    """
    last_exc: BaseException | None = None

    for attempt in range(1, config.max_attempts + 1):
        try:
            return func(*args, **kwargs)
        except Exception as exc:
            last_exc = exc

            # リトライ不能、または試行回数を使い切った場合は諦めて送出する
            if not is_retryable(exc) or attempt >= config.max_attempts:
                raise

            delay = compute_delay(attempt, config, rand)
            logger.warning(
                "リトライします（%d/%d 回目・%.2f 秒待機）: %s",
                attempt,
                config.max_attempts - 1,
                delay,
                extract_error_code(exc) or type(exc).__name__,
            )
            if on_retry is not None:
                on_retry(attempt, delay, exc)
            sleep(delay)

    # max_attempts >= 1 のため理論上は到達しないが、型と防御のために残す
    raise last_exc if last_exc is not None else RuntimeError("リトライに失敗しました")


def with_retry(
    config: RetryConfig = DEFAULT_CONFIG,
    sleep: Callable[[float], None] = time.sleep,
    rand: Callable[[], float] = random.random,
) -> Callable[[Callable[..., T]], Callable[..., T]]:
    """retry_call をデコレータとして適用するためのファクトリ"""

    def decorator(func: Callable[..., T]) -> Callable[..., T]:
        def wrapper(*args: Any, **kwargs: Any) -> T:
            return retry_call(
                func, *args, config=config, sleep=sleep, rand=rand, **kwargs
            )

        wrapper.__name__ = getattr(func, "__name__", "wrapper")
        wrapper.__doc__ = func.__doc__
        wrapper.__wrapped__ = func  # type: ignore[attr-defined]
        return wrapper

    return decorator

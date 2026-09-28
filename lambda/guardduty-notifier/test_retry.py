"""
retry.py ユニットテスト

sleep / rand を注入して、実待機ゼロかつ決定的に検証する。
"""

import pytest
from botocore.exceptions import (
    ClientError,
    ConnectTimeoutError,
    EndpointConnectionError,
    ReadTimeoutError,
)
from retry import (
    DEFAULT_CONFIG,
    RetryConfig,
    compute_delay,
    extract_error_code,
    extract_status_code,
    is_retryable,
    retry_call,
    with_retry,
)


# ── テスト用ヘルパー ──────────────────────────────────────
def make_client_error(
    code: str = "ThrottlingException", status: int | None = None
) -> ClientError:
    """指定のエラーコード / ステータスコードを持つ ClientError を組み立てる。"""
    response: dict = {"Error": {"Code": code, "Message": "テスト用"}}
    if status is not None:
        response["ResponseMetadata"] = {"HTTPStatusCode": status}
    return ClientError(response, "TestOperation")


class RecordingSleep:
    """呼ばれた待機秒数を記録するだけの sleep 代替。"""

    def __init__(self) -> None:
        self.calls: list[float] = []

    def __call__(self, seconds: float) -> None:
        self.calls.append(seconds)


# ── RetryConfig ───────────────────────────────────────────
class TestRetryConfig:
    def test_既定値(self):
        assert DEFAULT_CONFIG.max_attempts == 3
        assert DEFAULT_CONFIG.base_delay == 0.5
        assert DEFAULT_CONFIG.max_delay == 8.0
        assert DEFAULT_CONFIG.jitter is True

    def test_max_attemptsが0以下なら例外(self):
        with pytest.raises(ValueError, match="max_attempts"):
            RetryConfig(max_attempts=0)

    def test_base_delayが0以下なら例外(self):
        with pytest.raises(ValueError, match="base_delay"):
            RetryConfig(base_delay=0)

    def test_max_delayがbase_delay未満なら例外(self):
        with pytest.raises(ValueError, match="max_delay"):
            RetryConfig(base_delay=2.0, max_delay=1.0)

    def test_max_attempts1は許容される(self):
        assert RetryConfig(max_attempts=1).max_attempts == 1


# ── エラー情報の取り出し ──────────────────────────────────
class TestExtractErrorCode:
    def test_ClientErrorからコードを取得できる(self):
        error = make_client_error("ThrottlingException")
        assert extract_error_code(error) == "ThrottlingException"

    def test_ClientError以外は空文字(self):
        assert extract_error_code(ValueError("boom")) == ""

    def test_responseが辞書でない場合は空文字(self):
        exc = make_client_error()
        exc.response = "not-a-dict"
        assert extract_error_code(exc) == ""

    def test_Errorキーが辞書でない場合は空文字(self):
        exc = make_client_error()
        exc.response = {"Error": "not-a-dict"}
        assert extract_error_code(exc) == ""

    def test_Codeが文字列でない場合は空文字(self):
        exc = make_client_error()
        exc.response = {"Error": {"Code": 500}}
        assert extract_error_code(exc) == ""


class TestExtractStatusCode:
    def test_ステータスコードを取得できる(self):
        assert extract_status_code(make_client_error("X", status=503)) == 503

    def test_ClientError以外はNone(self):
        assert extract_status_code(ValueError("boom")) is None

    def test_ResponseMetadataが無ければNone(self):
        assert extract_status_code(make_client_error("X")) is None

    def test_HTTPStatusCodeが整数でなければNone(self):
        exc = make_client_error()
        exc.response = {"ResponseMetadata": {"HTTPStatusCode": "503"}}
        assert extract_status_code(exc) is None


# ── リトライ可否の判定 ────────────────────────────────────
class TestIsRetryable:
    @pytest.mark.parametrize(
        "code",
        [
            "ThrottlingException",
            "Throttling",
            "ThrottledException",
            "TooManyRequestsException",
            "RequestLimitExceeded",
            "ProvisionedThroughputExceededException",
            "SlowDown",
            "InternalServerException",
            "ServiceUnavailable",
            "RequestTimeout",
            "ModelTimeoutException",
            "ModelNotReadyException",
        ],
    )
    def test_一時エラーはリトライ対象(self, code):
        assert is_retryable(make_client_error(code)) is True

    @pytest.mark.parametrize(
        "code",
        [
            "ValidationException",
            "AccessDeniedException",
            "ResourceNotFoundException",
            "ConditionalCheckFailedException",
        ],
    )
    def test_恒久エラーはリトライ対象外(self, code):
        assert is_retryable(make_client_error(code)) is False

    @pytest.mark.parametrize("status", [429, 500, 502, 503, 504])
    def test_一時的なステータスコードはリトライ対象(self, status):
        assert is_retryable(make_client_error("UnknownCode", status=status)) is True

    @pytest.mark.parametrize("status", [400, 403, 404, 409])
    def test_クライアント起因のステータスコードはリトライ対象外(self, status):
        assert is_retryable(make_client_error("UnknownCode", status=status)) is False

    def test_ネットワーク層の例外はリトライ対象(self):
        url = "https://example.com"
        assert is_retryable(ConnectTimeoutError(endpoint_url=url)) is True
        assert is_retryable(ReadTimeoutError(endpoint_url=url)) is True
        assert is_retryable(EndpointConnectionError(endpoint_url=url)) is True

    def test_ClientError以外の一般例外はリトライ対象外(self):
        assert is_retryable(ValueError("boom")) is False
        assert is_retryable(KeyError("boom")) is False


# ── 待機秒数の計算 ────────────────────────────────────────
class TestComputeDelay:
    def test_ジッター無効なら指数バックオフそのまま(self):
        config = RetryConfig(base_delay=1.0, max_delay=100.0, jitter=False)
        assert compute_delay(1, config) == 1.0
        assert compute_delay(2, config) == 2.0
        assert compute_delay(3, config) == 4.0
        assert compute_delay(4, config) == 8.0

    def test_max_delayで頭打ちになる(self):
        config = RetryConfig(base_delay=1.0, max_delay=5.0, jitter=False)
        assert compute_delay(10, config) == 5.0

    def test_フルジッターは0から上限の範囲に収まる(self):
        config = RetryConfig(base_delay=1.0, max_delay=8.0, jitter=True)
        assert compute_delay(3, config, rand=lambda: 0.0) == 0.0
        assert compute_delay(3, config, rand=lambda: 1.0) == 4.0
        assert compute_delay(3, config, rand=lambda: 0.5) == 2.0

    def test_attemptが0以下なら例外(self):
        with pytest.raises(ValueError, match="attempt"):
            compute_delay(0)

    def test_巨大なattemptでもオーバーフローしない(self):
        config = RetryConfig(base_delay=1.0, max_delay=8.0, jitter=False)
        assert compute_delay(10_000, config) == 8.0


# ── retry_call ────────────────────────────────────────────
class TestRetryCall:
    def test_初回で成功すればリトライしない(self):
        calls = []
        sleep = RecordingSleep()

        def func():
            calls.append(1)
            return "ok"

        assert retry_call(func, sleep=sleep) == "ok"
        assert len(calls) == 1
        assert sleep.calls == []

    def test_リトライ後に成功する(self):
        attempts = {"n": 0}
        sleep = RecordingSleep()

        def func():
            attempts["n"] += 1
            if attempts["n"] < 3:
                raise make_client_error("ThrottlingException")
            return "ok"

        result = retry_call(func, sleep=sleep, rand=lambda: 1.0)
        assert result == "ok"
        assert attempts["n"] == 3
        assert len(sleep.calls) == 2

    def test_試行回数を使い切ると元の例外を送出する(self):
        error = make_client_error("ThrottlingException")
        sleep = RecordingSleep()

        def func():
            raise error

        with pytest.raises(ClientError) as exc_info:
            retry_call(func, sleep=sleep, rand=lambda: 1.0)
        # 独自例外でラップせず、元の例外をそのまま送出する
        assert exc_info.value is error
        assert len(sleep.calls) == DEFAULT_CONFIG.max_attempts - 1

    def test_リトライ不能な例外は即座に送出する(self):
        sleep = RecordingSleep()

        def func():
            raise make_client_error("ValidationException")

        with pytest.raises(ClientError):
            retry_call(func, sleep=sleep)
        assert sleep.calls == []

    def test_max_attempts1ならリトライしない(self):
        attempts = {"n": 0}

        def func():
            attempts["n"] += 1
            raise make_client_error("ThrottlingException")

        with pytest.raises(ClientError):
            retry_call(func, config=RetryConfig(max_attempts=1), sleep=RecordingSleep())
        assert attempts["n"] == 1

    def test_引数がそのまま渡る(self):
        def func(a, b, *, c):
            return (a, b, c)

        assert retry_call(func, 1, 2, c=3) == (1, 2, 3)

    def test_on_retryコールバックが呼ばれる(self):
        events = []
        attempts = {"n": 0}

        def func():
            attempts["n"] += 1
            if attempts["n"] < 2:
                raise make_client_error("ThrottlingException")
            return "ok"

        def on_retry(attempt, delay, exc):
            events.append((attempt, delay, type(exc)))

        retry_call(func, sleep=RecordingSleep(), rand=lambda: 1.0, on_retry=on_retry)
        assert len(events) == 1
        assert events[0][0] == 1
        assert events[0][2] is ClientError

    def test_待機秒数が指数的に増える(self):
        sleep = RecordingSleep()
        config = RetryConfig(
            max_attempts=4, base_delay=1.0, max_delay=100.0, jitter=False
        )

        def func():
            raise make_client_error("ThrottlingException")

        with pytest.raises(ClientError):
            retry_call(func, config=config, sleep=sleep)
        assert sleep.calls == [1.0, 2.0, 4.0]

    def test_ネットワーク例外もリトライされる(self):
        attempts = {"n": 0}

        def func():
            attempts["n"] += 1
            if attempts["n"] < 2:
                raise ReadTimeoutError(endpoint_url="https://example.com")
            return "ok"

        assert retry_call(func, sleep=RecordingSleep()) == "ok"
        assert attempts["n"] == 2


# ── with_retry デコレータ ─────────────────────────────────
class TestWithRetry:
    def test_デコレータ経由でリトライされる(self):
        attempts = {"n": 0}

        @with_retry(sleep=RecordingSleep(), rand=lambda: 1.0)
        def func():
            attempts["n"] += 1
            if attempts["n"] < 2:
                raise make_client_error("ThrottlingException")
            return "ok"

        assert func() == "ok"
        assert attempts["n"] == 2

    def test_メタ情報が保持される(self):
        @with_retry()
        def sample_function():
            """説明文"""
            return 1

        assert sample_function.__name__ == "sample_function"
        assert sample_function.__doc__ == "説明文"
        assert hasattr(sample_function, "__wrapped__")

    def test_引数がそのまま渡る(self):
        @with_retry()
        def func(a, *, b):
            return a + b

        assert func(1, b=2) == 3

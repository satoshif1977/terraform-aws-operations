// retry_test.go: retry.go のユニットテスト
//
// Sleep / Rand を差し替えることで、実待機ゼロかつ決定的に検証する。
package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	awshttp "github.com/aws/aws-sdk-go-v2/aws/transport/http"
	"github.com/aws/smithy-go"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

// ── テスト用ヘルパー ──────────────────────────────────────────

// retryTestAPIError は指定コード・Fault を持つ AWS API エラーを組み立てる。
func retryTestAPIError(code string, fault smithy.ErrorFault) error {
	return &smithy.GenericAPIError{
		Code:    code,
		Message: code + " が発生しました",
		Fault:   fault,
	}
}

// retryTestHTTPError は指定 HTTP ステータスを持つレスポンスエラーを組み立てる。
func retryTestHTTPError(status int) error {
	return &awshttp.ResponseError{
		ResponseError: &smithyhttp.ResponseError{
			Response: &smithyhttp.Response{
				Response: &http.Response{StatusCode: status},
			},
			Err: errors.New("HTTP エラー"),
		},
		RequestID: "req-test",
	}
}

// retryTestTimeoutError は net.Error のタイムアウトを模したエラー。
type retryTestTimeoutError struct{}

func (retryTestTimeoutError) Error() string   { return "i/o timeout" }
func (retryTestTimeoutError) Timeout() bool   { return true }
func (retryTestTimeoutError) Temporary() bool { return true }

// retryTestNonTimeoutNetError は net.Error だがタイムアウトではないエラー。
type retryTestNonTimeoutNetError struct{}

func (retryTestNonTimeoutNetError) Error() string   { return "connection refused" }
func (retryTestNonTimeoutNetError) Timeout() bool   { return false }
func (retryTestNonTimeoutNetError) Temporary() bool { return false }

// retryTestSleeper は待機時間を記録するスタブ。
type retryTestSleeper struct {
	calls    []time.Duration
	failAt   int   // 何回目の呼び出しでエラーを返すか（0 なら常に成功）
	failWith error // failAt 回目に返すエラー（nil なら context.Canceled）
}

func (s *retryTestSleeper) Sleep(_ context.Context, d time.Duration) error {
	s.calls = append(s.calls, d)
	if s.failAt > 0 && len(s.calls) == s.failAt {
		if s.failWith != nil {
			return s.failWith
		}
		return context.Canceled
	}
	return nil
}

func (s *retryTestSleeper) count() int { return len(s.calls) }

// retryTestNoJitter はジッター無効の決定的な設定。
func retryTestNoJitter(maxAttempts int) RetryConfig {
	return RetryConfig{
		MaxAttempts: maxAttempts,
		BaseDelay:   100 * time.Millisecond,
		MaxDelay:    10 * time.Second,
		Jitter:      false,
	}
}

// retryTestFlaky は指定回数だけ失敗し、その後成功する関数を返す。
func retryTestFlaky(failTimes int, err error, calls *int) func(context.Context) error {
	return func(context.Context) error {
		*calls++
		if *calls <= failTimes {
			return err
		}
		return nil
	}
}

var retryTestThrottling = retryTestAPIError("ThrottlingException", smithy.FaultClient)

// ── RetryConfig ───────────────────────────────────────────────

func TestRetryConfig_Default(t *testing.T) {
	cfg := DefaultRetryConfig()
	if cfg.MaxAttempts != 4 {
		t.Errorf("MaxAttempts = %d, want 4", cfg.MaxAttempts)
	}
	if cfg.BaseDelay != 100*time.Millisecond {
		t.Errorf("BaseDelay = %v, want 100ms", cfg.BaseDelay)
	}
	if cfg.MaxDelay != 5*time.Second {
		t.Errorf("MaxDelay = %v, want 5s", cfg.MaxDelay)
	}
	if !cfg.Jitter {
		t.Error("Jitter = false, want true")
	}
}

func TestRetryConfig_DefaultIsValid(t *testing.T) {
	if err := DefaultRetryConfig().Validate(); err != nil {
		t.Errorf("既定設定が不正: %v", err)
	}
}

func TestRetryConfig_Validate_Table(t *testing.T) {
	tests := []struct {
		name    string
		cfg     RetryConfig
		wantErr error
	}{
		{
			name: "正常系_既定相当",
			cfg:  RetryConfig{MaxAttempts: 3, BaseDelay: time.Second, MaxDelay: 10 * time.Second},
		},
		{
			name: "正常系_MaxAttempts1",
			cfg:  RetryConfig{MaxAttempts: 1, BaseDelay: time.Second, MaxDelay: time.Second},
		},
		{
			name: "正常系_MaxDelayとBaseDelayが同値",
			cfg:  RetryConfig{MaxAttempts: 2, BaseDelay: 2 * time.Second, MaxDelay: 2 * time.Second},
		},
		{
			name:    "異常系_MaxAttempts0",
			cfg:     RetryConfig{MaxAttempts: 0, BaseDelay: time.Second, MaxDelay: time.Second},
			wantErr: ErrInvalidMaxAttempts,
		},
		{
			name:    "異常系_MaxAttempts負数",
			cfg:     RetryConfig{MaxAttempts: -1, BaseDelay: time.Second, MaxDelay: time.Second},
			wantErr: ErrInvalidMaxAttempts,
		},
		{
			name:    "異常系_BaseDelay0",
			cfg:     RetryConfig{MaxAttempts: 3, BaseDelay: 0, MaxDelay: time.Second},
			wantErr: ErrInvalidBaseDelay,
		},
		{
			name:    "異常系_BaseDelay負数",
			cfg:     RetryConfig{MaxAttempts: 3, BaseDelay: -time.Second, MaxDelay: time.Second},
			wantErr: ErrInvalidBaseDelay,
		},
		{
			name:    "異常系_MaxDelayがBaseDelay未満",
			cfg:     RetryConfig{MaxAttempts: 3, BaseDelay: 5 * time.Second, MaxDelay: time.Second},
			wantErr: ErrInvalidMaxDelay,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.cfg.Validate()
			if tt.wantErr == nil {
				if err != nil {
					t.Fatalf("Validate() = %v, want nil", err)
				}
				return
			}
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("Validate() = %v, want errors.Is(..., %v)", err, tt.wantErr)
			}
		})
	}
}

func TestRetryConfig_ValidateErrorIncludesValue(t *testing.T) {
	err := RetryConfig{MaxAttempts: -7, BaseDelay: time.Second, MaxDelay: time.Second}.Validate()
	if err == nil || !strings.Contains(err.Error(), "-7") {
		t.Errorf("エラーメッセージに値が含まれていない: %v", err)
	}
}

// ── IsRetryable ───────────────────────────────────────────────

func TestIsRetryable_ErrorCodes_Table(t *testing.T) {
	retryableCodes := []string{
		"ThrottlingException",
		"Throttling",
		"ThrottledException",
		"TooManyRequestsException",
		"RequestLimitExceeded",
		"ProvisionedThroughputExceededException",
		"SlowDown",
		"InternalServerException",
		"InternalServerError",
		"InternalFailure",
		"ServiceUnavailable",
		"ServiceUnavailableException",
		"RequestTimeout",
		"RequestTimeoutException",
		"TransactionConflictException",
		"KMSThrottlingException",
	}

	for _, code := range retryableCodes {
		t.Run("リトライ対象_"+code, func(t *testing.T) {
			// Fault はクライアント側にして、コード単体で判定されることを確認する
			if !IsRetryable(retryTestAPIError(code, smithy.FaultClient)) {
				t.Errorf("IsRetryable(%s) = false, want true", code)
			}
		})
	}

	nonRetryableCodes := []string{
		"ValidationException",
		"AccessDeniedException",
		"ResourceNotFoundException",
		"ConditionalCheckFailedException",
		"IncompleteSignature",
	}

	for _, code := range nonRetryableCodes {
		t.Run("リトライ不能_"+code, func(t *testing.T) {
			if IsRetryable(retryTestAPIError(code, smithy.FaultClient)) {
				t.Errorf("IsRetryable(%s) = true, want false", code)
			}
		})
	}
}

func TestIsRetryable_ServerFaultIsRetryable(t *testing.T) {
	// コードが未知でもサーバ起因ならリトライする
	if !IsRetryable(retryTestAPIError("SomeUnknownError", smithy.FaultServer)) {
		t.Error("サーバ起因エラーがリトライ対象になっていない")
	}
}

func TestIsRetryable_ClientFaultUnknownCodeIsNotRetryable(t *testing.T) {
	if IsRetryable(retryTestAPIError("SomeUnknownError", smithy.FaultClient)) {
		t.Error("クライアント起因の未知エラーがリトライ対象になっている")
	}
}

func TestIsRetryable_StatusCodes_Table(t *testing.T) {
	tests := []struct {
		status int
		want   bool
	}{
		{429, true},
		{500, true},
		{502, true},
		{503, true},
		{504, true},
		{400, false},
		{401, false},
		{403, false},
		{404, false},
		{409, false},
		{200, false},
	}

	for _, tt := range tests {
		t.Run(fmt.Sprintf("HTTP_%d", tt.status), func(t *testing.T) {
			if got := IsRetryable(retryTestHTTPError(tt.status)); got != tt.want {
				t.Errorf("IsRetryable(HTTP %d) = %v, want %v", tt.status, got, tt.want)
			}
		})
	}
}

func TestIsRetryable_Misc_Table(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"一般エラー", errors.New("boom"), false},
		{"contextキャンセル", context.Canceled, false},
		{"context期限切れ", context.DeadlineExceeded, false},
		{"ネットワークタイムアウト", retryTestTimeoutError{}, true},
		{"ネットワーク非タイムアウト", retryTestNonTimeoutNetError{}, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsRetryable(tt.err); got != tt.want {
				t.Errorf("IsRetryable(%v) = %v, want %v", tt.err, got, tt.want)
			}
		})
	}
}

func TestIsRetryable_WrappedError(t *testing.T) {
	wrapped := fmt.Errorf("DynamoDB 呼び出し失敗: %w", retryTestThrottling)
	if !IsRetryable(wrapped) {
		t.Error("ラップされたエラーが判定できていない")
	}
}

func TestIsRetryable_DoubleWrappedError(t *testing.T) {
	wrapped := fmt.Errorf("外側: %w", fmt.Errorf("内側: %w", retryTestThrottling))
	if !IsRetryable(wrapped) {
		t.Error("二重にラップされたエラーが判定できていない")
	}
}

func TestIsRetryable_WrappedContextCancelIsNotRetryable(t *testing.T) {
	wrapped := fmt.Errorf("処理中断: %w", context.Canceled)
	if IsRetryable(wrapped) {
		t.Error("context キャンセルがリトライ対象になっている")
	}
}

// ── ComputeDelay ──────────────────────────────────────────────

func TestComputeDelay_ExponentialBackoff_Table(t *testing.T) {
	cfg := RetryConfig{MaxAttempts: 10, BaseDelay: time.Second, MaxDelay: time.Hour, Jitter: false}

	tests := []struct {
		attempt int
		want    time.Duration
	}{
		{1, 1 * time.Second},
		{2, 2 * time.Second},
		{3, 4 * time.Second},
		{4, 8 * time.Second},
		{5, 16 * time.Second},
	}

	for _, tt := range tests {
		t.Run(fmt.Sprintf("attempt_%d", tt.attempt), func(t *testing.T) {
			if got := ComputeDelay(tt.attempt, cfg, nil); got != tt.want {
				t.Errorf("ComputeDelay(%d) = %v, want %v", tt.attempt, got, tt.want)
			}
		})
	}
}

func TestComputeDelay_CappedByMaxDelay(t *testing.T) {
	cfg := RetryConfig{MaxAttempts: 10, BaseDelay: time.Second, MaxDelay: 5 * time.Second, Jitter: false}

	if got := ComputeDelay(3, cfg, nil); got != 4*time.Second {
		t.Errorf("attempt=3: got %v, want 4s", got)
	}
	if got := ComputeDelay(4, cfg, nil); got != 5*time.Second {
		t.Errorf("attempt=4: got %v, want 5s（上限）", got)
	}
	if got := ComputeDelay(9, cfg, nil); got != 5*time.Second {
		t.Errorf("attempt=9: got %v, want 5s（上限）", got)
	}
}

func TestComputeDelay_HugeAttemptDoesNotOverflow(t *testing.T) {
	cfg := RetryConfig{MaxAttempts: 1000, BaseDelay: time.Second, MaxDelay: 30 * time.Second, Jitter: false}
	for _, attempt := range []int{100, 1000, 1 << 20} {
		if got := ComputeDelay(attempt, cfg, nil); got != 30*time.Second {
			t.Errorf("attempt=%d: got %v, want 30s", attempt, got)
		}
	}
}

func TestComputeDelay_AttemptBelowOneTreatedAsOne(t *testing.T) {
	cfg := retryTestNoJitter(3)
	want := ComputeDelay(1, cfg, nil)
	for _, attempt := range []int{0, -1, -100} {
		if got := ComputeDelay(attempt, cfg, nil); got != want {
			t.Errorf("attempt=%d: got %v, want %v", attempt, got, want)
		}
	}
}

func TestComputeDelay_FullJitter_Table(t *testing.T) {
	cfg := RetryConfig{MaxAttempts: 5, BaseDelay: time.Second, MaxDelay: time.Hour, Jitter: true}

	tests := []struct {
		name string
		rnd  float64
		want time.Duration
	}{
		{"最小値", 0.0, 0},
		{"4分の1", 0.25, time.Second},
		{"半分", 0.5, 2 * time.Second},
		{"最大値", 1.0, 4 * time.Second},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ComputeDelay(3, cfg, func() float64 { return tt.rnd })
			if got != tt.want {
				t.Errorf("ComputeDelay(3, rnd=%v) = %v, want %v", tt.rnd, got, tt.want)
			}
		})
	}
}

func TestComputeDelay_JitterNeverExceedsMaxDelay(t *testing.T) {
	cfg := RetryConfig{MaxAttempts: 20, BaseDelay: 50 * time.Millisecond, MaxDelay: 3 * time.Second, Jitter: true}
	for attempt := 1; attempt <= 20; attempt++ {
		for _, r := range []float64{0, 0.33, 0.5, 0.99, 1.0} {
			got := ComputeDelay(attempt, cfg, func() float64 { return r })
			if got < 0 || got > cfg.MaxDelay {
				t.Fatalf("attempt=%d rnd=%v: %v が [0, %v] の範囲外", attempt, r, got, cfg.MaxDelay)
			}
		}
	}
}

func TestComputeDelay_NilRandUsesDefault(t *testing.T) {
	cfg := RetryConfig{MaxAttempts: 5, BaseDelay: time.Second, MaxDelay: time.Hour, Jitter: true}
	// rnd=nil でもパニックせず、上限以下の値が返る
	for i := 0; i < 50; i++ {
		if got := ComputeDelay(2, cfg, nil); got < 0 || got > 2*time.Second {
			t.Fatalf("got %v, want [0, 2s]", got)
		}
	}
}

// ── ContextSleep ──────────────────────────────────────────────

func TestContextSleep_CompletesNormally(t *testing.T) {
	if err := ContextSleep(context.Background(), time.Millisecond); err != nil {
		t.Errorf("ContextSleep() = %v, want nil", err)
	}
}

func TestContextSleep_ReturnsOnCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := ContextSleep(ctx, time.Hour); !errors.Is(err, context.Canceled) {
		t.Errorf("ContextSleep() = %v, want context.Canceled", err)
	}
}

func TestContextSleep_ReturnsOnDeadline(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Millisecond)
	defer cancel()
	if err := ContextSleep(ctx, time.Hour); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("ContextSleep() = %v, want context.DeadlineExceeded", err)
	}
}

func TestContextSleep_ZeroDuration(t *testing.T) {
	if err := ContextSleep(context.Background(), 0); err != nil {
		t.Errorf("ContextSleep(0) = %v, want nil", err)
	}
}

// ── Retrier.Do ────────────────────────────────────────────────

func TestRetrier_Do_SucceedsFirstTry(t *testing.T) {
	sleeper := &retryTestSleeper{}
	calls := 0
	r := Retrier{Config: retryTestNoJitter(4), Sleep: sleeper.Sleep}

	if err := r.Do(context.Background(), "Test", retryTestFlaky(0, retryTestThrottling, &calls)); err != nil {
		t.Fatalf("Do() = %v, want nil", err)
	}
	if calls != 1 {
		t.Errorf("呼び出し回数 = %d, want 1", calls)
	}
	if sleeper.count() != 0 {
		t.Errorf("待機回数 = %d, want 0", sleeper.count())
	}
}

func TestRetrier_Do_RetriesThenSucceeds(t *testing.T) {
	sleeper := &retryTestSleeper{}
	calls := 0
	r := Retrier{Config: retryTestNoJitter(4), Sleep: sleeper.Sleep}

	if err := r.Do(context.Background(), "Test", retryTestFlaky(2, retryTestThrottling, &calls)); err != nil {
		t.Fatalf("Do() = %v, want nil", err)
	}
	if calls != 3 {
		t.Errorf("呼び出し回数 = %d, want 3", calls)
	}
	want := []time.Duration{100 * time.Millisecond, 200 * time.Millisecond}
	if len(sleeper.calls) != len(want) {
		t.Fatalf("待機回数 = %d, want %d", len(sleeper.calls), len(want))
	}
	for i, w := range want {
		if sleeper.calls[i] != w {
			t.Errorf("待機[%d] = %v, want %v", i, sleeper.calls[i], w)
		}
	}
}

func TestRetrier_Do_ExhaustsAttemptsAndReturnsOriginalError(t *testing.T) {
	sleeper := &retryTestSleeper{}
	calls := 0
	r := Retrier{Config: retryTestNoJitter(3), Sleep: sleeper.Sleep}

	err := r.Do(context.Background(), "Test", retryTestFlaky(99, retryTestThrottling, &calls))
	if err == nil {
		t.Fatal("Do() = nil, want error")
	}
	// 元のエラーがそのまま返るため errors.As で API エラーを取り出せる
	var apiErr smithy.APIError
	if !errors.As(err, &apiErr) || apiErr.ErrorCode() != "ThrottlingException" {
		t.Errorf("元のエラーが失われている: %v", err)
	}
	if calls != 3 {
		t.Errorf("呼び出し回数 = %d, want 3", calls)
	}
	if sleeper.count() != 2 {
		t.Errorf("待機回数 = %d, want 2", sleeper.count())
	}
}

func TestRetrier_Do_NonRetryableReturnsImmediately(t *testing.T) {
	sleeper := &retryTestSleeper{}
	calls := 0
	nonRetryable := retryTestAPIError("ValidationException", smithy.FaultClient)
	r := Retrier{Config: retryTestNoJitter(4), Sleep: sleeper.Sleep}

	err := r.Do(context.Background(), "Test", retryTestFlaky(99, nonRetryable, &calls))
	if err == nil {
		t.Fatal("Do() = nil, want error")
	}
	if calls != 1 {
		t.Errorf("呼び出し回数 = %d, want 1", calls)
	}
	if sleeper.count() != 0 {
		t.Errorf("待機回数 = %d, want 0", sleeper.count())
	}
}

func TestRetrier_Do_MaxAttemptsOneNeverRetries(t *testing.T) {
	sleeper := &retryTestSleeper{}
	calls := 0
	r := Retrier{Config: retryTestNoJitter(1), Sleep: sleeper.Sleep}

	if err := r.Do(context.Background(), "Test", retryTestFlaky(99, retryTestThrottling, &calls)); err == nil {
		t.Fatal("Do() = nil, want error")
	}
	if calls != 1 {
		t.Errorf("呼び出し回数 = %d, want 1", calls)
	}
	if sleeper.count() != 0 {
		t.Errorf("待機回数 = %d, want 0", sleeper.count())
	}
}

func TestRetrier_Do_InvalidConfigReturnsError(t *testing.T) {
	calls := 0
	r := Retrier{Config: RetryConfig{MaxAttempts: 0, BaseDelay: time.Second, MaxDelay: time.Second}}

	err := r.Do(context.Background(), "Test", retryTestFlaky(0, nil, &calls))
	if !errors.Is(err, ErrInvalidMaxAttempts) {
		t.Errorf("Do() = %v, want ErrInvalidMaxAttempts", err)
	}
	if calls != 0 {
		t.Errorf("設定不正でも関数が呼ばれた: %d 回", calls)
	}
}

func TestRetrier_Do_CancelDuringSleepWrapsOriginalError(t *testing.T) {
	sleeper := &retryTestSleeper{failAt: 1}
	calls := 0
	r := Retrier{Config: retryTestNoJitter(4), Sleep: sleeper.Sleep}

	err := r.Do(context.Background(), "Test", retryTestFlaky(99, retryTestThrottling, &calls))
	if err == nil {
		t.Fatal("Do() = nil, want error")
	}
	// 待機中に中断されても、元のエラーは errors.As で取り出せる
	var apiErr smithy.APIError
	if !errors.As(err, &apiErr) {
		t.Errorf("元のエラーが失われている: %v", err)
	}
	if !strings.Contains(err.Error(), "中断") {
		t.Errorf("中断理由がメッセージに含まれていない: %v", err)
	}
	if calls != 1 {
		t.Errorf("呼び出し回数 = %d, want 1", calls)
	}
}

func TestRetrier_Do_DelaysAreMonotonic(t *testing.T) {
	sleeper := &retryTestSleeper{}
	calls := 0
	r := Retrier{Config: retryTestNoJitter(5), Sleep: sleeper.Sleep}

	_ = r.Do(context.Background(), "Test", retryTestFlaky(99, retryTestThrottling, &calls))

	if len(sleeper.calls) != 4 {
		t.Fatalf("待機回数 = %d, want 4", len(sleeper.calls))
	}
	for i := 1; i < len(sleeper.calls); i++ {
		if sleeper.calls[i] <= sleeper.calls[i-1] {
			t.Errorf("待機時間が増加していない: %v -> %v", sleeper.calls[i-1], sleeper.calls[i])
		}
	}
}

func TestRetrier_Do_NilSleepUsesContextSleep(t *testing.T) {
	calls := 0
	// BaseDelay を極小にして実待機を無視できる長さにする
	cfg := RetryConfig{MaxAttempts: 2, BaseDelay: time.Nanosecond, MaxDelay: time.Millisecond, Jitter: false}
	r := Retrier{Config: cfg} // Sleep は nil

	if err := r.Do(context.Background(), "Test", retryTestFlaky(1, retryTestThrottling, &calls)); err != nil {
		t.Fatalf("Do() = %v, want nil", err)
	}
	if calls != 2 {
		t.Errorf("呼び出し回数 = %d, want 2", calls)
	}
}

func TestRetrier_Do_PassesContextToFn(t *testing.T) {
	type ctxKey string
	key := ctxKey("k")
	ctx := context.WithValue(context.Background(), key, "v")

	var got any
	r := Retrier{Config: retryTestNoJitter(2)}
	_ = r.Do(ctx, "Test", func(c context.Context) error {
		got = c.Value(key)
		return nil
	})

	if got != "v" {
		t.Errorf("context が伝播していない: got %v", got)
	}
}

func TestRetrier_Do_RetriesOnHTTP503(t *testing.T) {
	sleeper := &retryTestSleeper{}
	calls := 0
	r := Retrier{Config: retryTestNoJitter(3), Sleep: sleeper.Sleep}

	if err := r.Do(context.Background(), "Test", retryTestFlaky(1, retryTestHTTPError(503), &calls)); err != nil {
		t.Fatalf("Do() = %v, want nil", err)
	}
	if calls != 2 {
		t.Errorf("呼び出し回数 = %d, want 2", calls)
	}
}

func TestNewRetrier_UsesDefaults(t *testing.T) {
	r := NewRetrier()
	if r.Config != DefaultRetryConfig() {
		t.Errorf("Config = %+v, want %+v", r.Config, DefaultRetryConfig())
	}
	if r.Sleep != nil || r.Rand != nil {
		t.Error("Sleep / Rand は既定で nil であるべき")
	}
}

// ── RetryValue ────────────────────────────────────────────────

func TestRetryValue_ReturnsValue(t *testing.T) {
	r := Retrier{Config: retryTestNoJitter(3), Sleep: (&retryTestSleeper{}).Sleep}

	got, err := RetryValue(context.Background(), r, "Test", func(context.Context) (string, error) {
		return "ok", nil
	})
	if err != nil {
		t.Fatalf("RetryValue() error = %v", err)
	}
	if got != "ok" {
		t.Errorf("RetryValue() = %q, want \"ok\"", got)
	}
}

func TestRetryValue_RetriesThenReturnsValue(t *testing.T) {
	sleeper := &retryTestSleeper{}
	r := Retrier{Config: retryTestNoJitter(4), Sleep: sleeper.Sleep}
	calls := 0

	got, err := RetryValue(context.Background(), r, "Test", func(context.Context) (int, error) {
		calls++
		if calls < 3 {
			return 0, retryTestThrottling
		}
		return 42, nil
	})
	if err != nil {
		t.Fatalf("RetryValue() error = %v", err)
	}
	if got != 42 {
		t.Errorf("RetryValue() = %d, want 42", got)
	}
	if sleeper.count() != 2 {
		t.Errorf("待機回数 = %d, want 2", sleeper.count())
	}
}

func TestRetryValue_ReturnsZeroValueOnError(t *testing.T) {
	r := Retrier{Config: retryTestNoJitter(2), Sleep: (&retryTestSleeper{}).Sleep}

	got, err := RetryValue(context.Background(), r, "Test", func(context.Context) (*string, error) {
		return nil, retryTestAPIError("ValidationException", smithy.FaultClient)
	})
	if err == nil {
		t.Fatal("RetryValue() error = nil, want error")
	}
	if got != nil {
		t.Errorf("RetryValue() = %v, want nil（ゼロ値）", got)
	}
}

func TestRetryValue_StructType(t *testing.T) {
	type payload struct {
		Name  string
		Count int
	}
	r := Retrier{Config: retryTestNoJitter(2), Sleep: (&retryTestSleeper{}).Sleep}

	got, err := RetryValue(context.Background(), r, "Test", func(context.Context) (payload, error) {
		return payload{Name: "item", Count: 3}, nil
	})
	if err != nil {
		t.Fatalf("RetryValue() error = %v", err)
	}
	if got.Name != "item" || got.Count != 3 {
		t.Errorf("RetryValue() = %+v", got)
	}
}

func TestRetryValue_ZeroValueForStructOnError(t *testing.T) {
	type payload struct{ Name string }
	r := Retrier{Config: retryTestNoJitter(1), Sleep: (&retryTestSleeper{}).Sleep}

	got, _ := RetryValue(context.Background(), r, "Test", func(context.Context) (payload, error) {
		return payload{Name: "破棄される"}, retryTestThrottling
	})
	// 最終試行の戻り値がそのまま入る（Go の慣習どおり値とエラーの両方を返す）
	if got.Name != "破棄される" {
		t.Errorf("最終試行の値が保持されていない: %+v", got)
	}
}

// ── ベンチマーク ──────────────────────────────────────────────

func BenchmarkIsRetryable_Throttling(b *testing.B) {
	for i := 0; i < b.N; i++ {
		_ = IsRetryable(retryTestThrottling)
	}
}

func BenchmarkIsRetryable_WrappedError(b *testing.B) {
	wrapped := fmt.Errorf("外側: %w", retryTestThrottling)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = IsRetryable(wrapped)
	}
}

func BenchmarkComputeDelay(b *testing.B) {
	cfg := DefaultRetryConfig()
	for i := 0; i < b.N; i++ {
		_ = ComputeDelay(3, cfg, nil)
	}
}

func BenchmarkRetrier_Do_Success(b *testing.B) {
	r := Retrier{Config: retryTestNoJitter(3), Sleep: (&retryTestSleeper{}).Sleep}
	ctx := context.Background()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = r.Do(ctx, "Bench", func(context.Context) error { return nil })
	}
}

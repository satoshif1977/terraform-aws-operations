// retry.go: AWS API 呼び出し向けリトライユーティリティ
//
// SNS の ThrottledException や一時的なサーバエラーに対して、
// AWS 公式推奨の「指数バックオフ + フルジッター」方式で自動リトライする。
//
// 設計方針:
//   - Sleep / Rand を差し替え可能にして、テストを決定的かつ実待機ゼロに保つ
//   - リトライ不能なエラー（ValidationException 等）は即座に返す
//   - 最終試行でも失敗した場合は元のエラーをそのまま返す（errors.As / errors.Is を壊さない）
//   - 待機中も context のキャンセルを尊重する（Lambda のタイムアウト対策）
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math"
	"math/rand"
	"net"
	"time"

	awshttp "github.com/aws/aws-sdk-go-v2/aws/transport/http"
	"github.com/aws/smithy-go"
)

// ── 設定エラー ────────────────────────────────────────────────
var (
	ErrInvalidMaxAttempts = errors.New("retry: MaxAttempts は 1 以上で指定してください")
	ErrInvalidBaseDelay   = errors.New("retry: BaseDelay は 0 より大きい値で指定してください")
	ErrInvalidMaxDelay    = errors.New("retry: MaxDelay は BaseDelay 以上で指定してください")
)

// ── リトライ対象の判定基準 ────────────────────────────────────

// retryableErrorCodes は AWS が「時間をおけば成功しうる」と定義するエラーコード群。
var retryableErrorCodes = map[string]bool{
	// スロットリング系
	"ThrottlingException":                    true,
	"Throttling":                             true,
	"ThrottledException":                     true,
	"TooManyRequestsException":               true,
	"RequestLimitExceeded":                   true,
	"ProvisionedThroughputExceededException": true,
	"SlowDown":                               true,
	// サーバ側の一時障害
	"InternalServerException":     true,
	"InternalServerError":         true,
	"InternalFailure":             true,
	"ServiceUnavailable":          true,
	"ServiceUnavailableException": true,
	// タイムアウト系
	"RequestTimeout":          true,
	"RequestTimeoutException": true,
	// SNS / DynamoDB: 一時的な内部競合
	"TransactionConflictException": true,
	"KMSThrottlingException":       true,
}

// retryableStatusCodes はステータスコードだけで判定できる一時エラー（429 / 5xx）。
var retryableStatusCodes = map[int]bool{
	429: true,
	500: true,
	502: true,
	503: true,
	504: true,
}

// ── 設定 ──────────────────────────────────────────────────────

// RetryConfig はリトライ挙動の設定。
type RetryConfig struct {
	// MaxAttempts は最大試行回数（初回を含む）。1 ならリトライしない。
	MaxAttempts int
	// BaseDelay は 1 回目のリトライ前の基準待機時間。
	BaseDelay time.Duration
	// MaxDelay は指数バックオフの上限（これ以上は待たない）。
	MaxDelay time.Duration
	// Jitter が true ならフルジッター（0〜上限のランダム待機）を有効化する。
	Jitter bool
}

// DefaultRetryConfig は本番想定の既定値を返す。
func DefaultRetryConfig() RetryConfig {
	return RetryConfig{
		MaxAttempts: 4,
		BaseDelay:   100 * time.Millisecond,
		MaxDelay:    5 * time.Second,
		Jitter:      true,
	}
}

// Validate は設定値の整合性を確認する。
func (c RetryConfig) Validate() error {
	if c.MaxAttempts < 1 {
		return fmt.Errorf("%w (MaxAttempts=%d)", ErrInvalidMaxAttempts, c.MaxAttempts)
	}
	if c.BaseDelay <= 0 {
		return fmt.Errorf("%w (BaseDelay=%v)", ErrInvalidBaseDelay, c.BaseDelay)
	}
	if c.MaxDelay < c.BaseDelay {
		return fmt.Errorf("%w (MaxDelay=%v, BaseDelay=%v)", ErrInvalidMaxDelay, c.MaxDelay, c.BaseDelay)
	}
	return nil
}

// ── 判定ヘルパー ──────────────────────────────────────────────

// IsRetryable はエラーがリトライ対象かどうかを判定する。
//
// context のキャンセル・期限切れはリトライしても回復しないため false を返す。
func IsRetryable(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}

	// AWS SDK が返す API エラー（エラーコード・サーバ起因かで判定）
	var apiErr smithy.APIError
	if errors.As(err, &apiErr) {
		if retryableErrorCodes[apiErr.ErrorCode()] {
			return true
		}
		if apiErr.ErrorFault() == smithy.FaultServer {
			return true
		}
	}

	// HTTP ステータスコードによる判定（429 / 5xx）
	var respErr *awshttp.ResponseError
	if errors.As(err, &respErr) && retryableStatusCodes[respErr.HTTPStatusCode()] {
		return true
	}

	// ネットワーク層の一時障害
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true
	}

	return false
}

// ComputeDelay は指定回目のリトライ前に待つ時間を計算する。
//
// attempt は 1 始まり（1 回目のリトライ = 1）。1 未満は 1 として扱う。
// 指数バックオフ（BaseDelay * 2^(attempt-1)）を MaxDelay で頭打ちにし、
// Jitter が有効なら 0〜その値のランダム時間に散らす（フルジッター）。
// 同時に失敗した複数クライアントがリトライで再衝突するのを防ぐ。
func ComputeDelay(attempt int, cfg RetryConfig, rnd func() float64) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	if rnd == nil {
		rnd = rand.Float64
	}

	// 2^(attempt-1) は attempt が大きいとオーバーフローするため先に頭打ちにする
	exponent := attempt - 1
	if exponent > 62 {
		exponent = 62
	}
	scaled := float64(cfg.BaseDelay) * math.Pow(2, float64(exponent))
	capped := math.Min(scaled, float64(cfg.MaxDelay))

	if cfg.Jitter {
		capped *= rnd()
	}
	return time.Duration(capped)
}

// ── 待機 ──────────────────────────────────────────────────────

// SleepFunc は待機処理。context がキャンセルされたらその error を返す。
type SleepFunc func(ctx context.Context, d time.Duration) error

// ContextSleep は context のキャンセルを尊重する既定の待機処理。
func ContextSleep(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// ── メイン処理 ────────────────────────────────────────────────

// Retrier はリトライ実行器。Sleep / Rand は nil なら既定実装を使う。
type Retrier struct {
	Config RetryConfig
	Sleep  SleepFunc
	Rand   func() float64
}

// NewRetrier は既定の設定を持つ Retrier を返す。
func NewRetrier() Retrier {
	return Retrier{Config: DefaultRetryConfig()}
}

// Do は fn を実行し、リトライ可能なエラーが出たら指数バックオフで再試行する。
//
// リトライ不能なエラー・最終試行での失敗は、元のエラーをそのまま返す。
// op はログ出力用の操作名（"Publish" 等）。
func (r Retrier) Do(ctx context.Context, op string, fn func(context.Context) error) error {
	cfg := r.Config
	if err := cfg.Validate(); err != nil {
		return err
	}

	sleep := r.Sleep
	if sleep == nil {
		sleep = ContextSleep
	}

	var lastErr error
	for attempt := 1; attempt <= cfg.MaxAttempts; attempt++ {
		lastErr = fn(ctx)
		if lastErr == nil {
			return nil
		}
		if !IsRetryable(lastErr) || attempt >= cfg.MaxAttempts {
			return lastErr
		}

		delay := ComputeDelay(attempt, cfg, r.Rand)
		log.Printf("リトライします: op=%s attempt=%d/%d delay=%v err=%v",
			op, attempt, cfg.MaxAttempts-1, delay, lastErr)

		if err := sleep(ctx, delay); err != nil {
			// 待機中に context がキャンセルされた。元のエラーを保ったまま理由を添える
			return fmt.Errorf("%w (リトライ待機中に中断: %v)", lastErr, err)
		}
	}
	return lastErr
}

// RetryValue は戻り値を持つ関数を Retrier で実行するジェネリックヘルパー。
func RetryValue[T any](ctx context.Context, r Retrier, op string, fn func(context.Context) (T, error)) (T, error) {
	var result T
	err := r.Do(ctx, op, func(c context.Context) error {
		var callErr error
		result, callErr = fn(c)
		return callErr
	})
	return result, err
}

package main

// Retrier.OnRetry フックの検証。
//
// フックは logger.go の RetryLogHook() / metrics.go の RetryMetricsHook() を
// そのまま差し込めることを前提にしている。ここではフック単体の呼ばれ方を固定する。

import (
	"context"
	"errors"
	"testing"
	"time"
)

func hookTestRetrier(maxAttempts int) Retrier {
	return Retrier{
		Config: RetryConfig{
			MaxAttempts: maxAttempts,
			BaseDelay:   time.Millisecond,
			MaxDelay:    time.Millisecond,
			Jitter:      false,
		},
		// 実待機ゼロ
		Sleep: func(context.Context, time.Duration) error { return nil },
	}
}

func TestRetrier_OnRetryが呼ばれる(t *testing.T) {
	type call struct {
		attempt int
		delay   time.Duration
		err     error
	}
	var calls []call

	r := hookTestRetrier(3)
	r.OnRetry = func(attempt int, delay time.Duration, err error) {
		calls = append(calls, call{attempt, delay, err})
	}

	err := r.Do(context.Background(), "Publish", func(context.Context) error {
		return retryTestThrottling
	})
	if err == nil {
		t.Fatal("最終的にエラーが返るはず")
	}

	// MaxAttempts=3 なら、リトライ直前のフックは 2 回
	if len(calls) != 2 {
		t.Fatalf("OnRetry の呼び出し回数 = %d, want 2", len(calls))
	}
	for i, c := range calls {
		if c.attempt != i+1 {
			t.Errorf("calls[%d].attempt = %d, want %d", i, c.attempt, i+1)
		}
		if c.delay <= 0 {
			t.Errorf("calls[%d].delay = %v, want > 0", i, c.delay)
		}
		if !errors.Is(c.err, retryTestThrottling) {
			t.Errorf("calls[%d].err = %v, want throttling", i, c.err)
		}
	}
}

func TestRetrier_成功したらOnRetryは呼ばれない(t *testing.T) {
	called := 0
	r := hookTestRetrier(3)
	r.OnRetry = func(int, time.Duration, error) { called++ }

	if err := r.Do(context.Background(), "Publish", func(context.Context) error {
		return nil
	}); err != nil {
		t.Fatalf("予期しないエラー: %v", err)
	}
	if called != 0 {
		t.Errorf("OnRetry の呼び出し回数 = %d, want 0", called)
	}
}

func TestRetrier_リトライ不能ならOnRetryは呼ばれない(t *testing.T) {
	called := 0
	r := hookTestRetrier(3)
	r.OnRetry = func(int, time.Duration, error) { called++ }

	if err := r.Do(context.Background(), "Publish", func(context.Context) error {
		return errors.New("plain error")
	}); err == nil {
		t.Fatal("エラーが返るはず")
	}
	if called != 0 {
		t.Errorf("OnRetry の呼び出し回数 = %d, want 0", called)
	}
}

func TestRetrier_OnRetry未設定でも従来どおり動く(t *testing.T) {
	// フックを設定しない場合は標準ログへ出力する（出力先は検証せず、
	// 動作が変わっていないことだけを固定する）。
	r := hookTestRetrier(2)

	calls := 0
	err := r.Do(context.Background(), "Publish", func(context.Context) error {
		calls++
		return retryTestThrottling
	})
	if err == nil {
		t.Fatal("最終的にエラーが返るはず")
	}
	if calls != 2 {
		t.Errorf("実行回数 = %d, want 2", calls)
	}
}

func TestRetrier_OnRetryにRetryLogHookとRetryMetricsHookを同時に差せる(t *testing.T) {
	// main.go と同じ形の結線が型として成立することを固定する。
	logger := NewLogger(LoggerOptions{})
	m, err := NewMetrics(MetricsOptions{Namespace: "Test/Hook"})
	if err != nil {
		t.Fatalf("メトリクスの生成に失敗: %v", err)
	}

	logHook := RetryLogHook(logger, "Publish")
	metricsHook := RetryMetricsHook(m, "Publish")

	r := hookTestRetrier(2)
	r.OnRetry = func(attempt int, delay time.Duration, err error) {
		logHook(attempt, delay, err)
		metricsHook(attempt, delay, err)
	}

	if err := r.Do(context.Background(), "Publish", func(context.Context) error {
		return retryTestThrottling
	}); err == nil {
		t.Fatal("最終的にエラーが返るはず")
	}
}

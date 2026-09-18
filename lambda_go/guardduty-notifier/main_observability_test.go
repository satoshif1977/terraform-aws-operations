package main

// main.go と logger.go / metrics.go の結線を検証するテスト。
//
// logger.go / metrics.go 単体の振る舞いは logger_test.go / metrics_test.go が
// 網羅している。ここで見るのは「ハンドラーが実際にそれらを通しているか」だけ。

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/sns"
)

// ── ヘルパー ──────────────────────────────────────────────────

// obsCapture はログとメトリクスの出力を捕まえるための入れ物。
type obsCapture struct {
	logs    *bytes.Buffer
	metrics *bytes.Buffer
}

// withCapturedObservability は生成関数を差し替え、出力をバッファへ集める。
// 戻り値の restore を defer で呼ぶこと。
func withCapturedObservability(t *testing.T) *obsCapture {
	t.Helper()

	c := &obsCapture{logs: &bytes.Buffer{}, metrics: &bytes.Buffer{}}
	origLogger, origMetrics := newHandlerLogger, newHandlerMetrics

	newHandlerLogger = func() *slog.Logger {
		return NewLogger(LoggerOptions{Writer: c.logs})
	}
	newHandlerMetrics = func(_ *slog.Logger) *Metrics {
		m, err := NewMetrics(MetricsOptions{
			Namespace:  "Test/GuarddutyNotifier",
			Dimensions: map[string]string{"Handler": handlerDimension},
			Sink:       c.metrics,
		})
		if err != nil {
			t.Fatalf("テスト用メトリクスの生成に失敗: %v", err)
		}
		return m
	}

	t.Cleanup(func() {
		newHandlerLogger, newHandlerMetrics = origLogger, origMetrics
	})
	return c
}

// logEntries は捕まえたログを 1 行ずつ JSON として読む。
func (c *obsCapture) logEntries(t *testing.T) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(c.logs.String()), "\n") {
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("ログが JSON として読めない: %q (%v)", line, err)
		}
		out = append(out, m)
	}
	return out
}

// findLog は message が一致する最初のログを返す。
func (c *obsCapture) findLog(t *testing.T, message string) map[string]any {
	t.Helper()
	for _, e := range c.logEntries(t) {
		if e["message"] == message {
			return e
		}
	}
	return nil
}

// emfDocument は捕まえた EMF の 1 行目を読む。
func (c *obsCapture) emfDocument(t *testing.T) map[string]any {
	t.Helper()
	raw := strings.TrimSpace(c.metrics.String())
	if raw == "" {
		t.Fatal("EMF が 1 行も出力されていない")
	}
	var doc map[string]any
	if err := json.Unmarshal([]byte(strings.Split(raw, "\n")[0]), &doc); err != nil {
		t.Fatalf("EMF が JSON として読めない: %v", err)
	}
	return doc
}

// flakySNS は指定回数だけ失敗し、その後は成功する SNS モック。
// 既存の mockSNS は「常に成功」か「常に失敗」しか表現できないため用意した。
type flakySNS struct {
	failTimes int
	failErr   error
	calls     int
}

func (m *flakySNS) Publish(_ context.Context, _ *sns.PublishInput, _ ...func(*sns.Options)) (*sns.PublishOutput, error) {
	m.calls++
	if m.calls <= m.failTimes {
		return nil, m.failErr
	}
	msgID := "test-message-id"
	return &sns.PublishOutput{MessageId: &msgID}, nil
}

// obsEvent はテスト用の GuardDuty イベントを作る。
func obsEvent(findingID string) GuardDutyEvent {
	return GuardDutyEvent{Detail: map[string]any{
		"severity":    8.5,
		"title":       "Unauthorized API call detected",
		"description": "テスト用の検知",
		"type":        "UnauthorizedAccess:EC2/SSHBruteForce",
		"region":      "ap-northeast-1",
		"accountId":   "123456789012",
		"id":          findingID,
	}}
}

// ── 構造化ログ ────────────────────────────────────────────────

func TestHandleRequest_ログが1行のJSONで出力される(t *testing.T) {
	c := withCapturedObservability(t)
	snsClient = &mockSNS{}

	if _, err := HandleRequest(context.Background(), obsEvent("finding-001")); err != nil {
		t.Fatalf("予期しないエラー: %v", err)
	}

	entries := c.logEntries(t)
	if len(entries) == 0 {
		t.Fatal("ログが 1 行も出力されていない")
	}
}

func TestHandleRequest_成功ログにfindingIdとseverityが載る(t *testing.T) {
	c := withCapturedObservability(t)
	snsClient = &mockSNS{}

	if _, err := HandleRequest(context.Background(), obsEvent("finding-777")); err != nil {
		t.Fatalf("予期しないエラー: %v", err)
	}

	entry := c.findLog(t, "SNS への通知に成功しました")
	if entry == nil {
		t.Fatal("成功ログが見つからない")
	}
	if entry["findingId"] != "finding-777" {
		t.Errorf("findingId = %v, want finding-777", entry["findingId"])
	}
	if entry["severity"] != 8.5 {
		t.Errorf("severity = %v, want 8.5", entry["severity"])
	}
}

func TestHandleRequest_detailが空ならwarnログを出す(t *testing.T) {
	c := withCapturedObservability(t)
	snsClient = &mockSNS{}

	resp, err := HandleRequest(context.Background(), GuardDutyEvent{})
	if err != nil {
		t.Fatalf("予期しないエラー: %v", err)
	}
	if resp.StatusCode != 400 {
		t.Errorf("StatusCode = %d, want 400", resp.StatusCode)
	}

	entry := c.findLog(t, "detail が空のイベントを受信しました。処理をスキップします")
	if entry == nil {
		t.Fatal("空 detail の warn ログが見つからない")
	}
	if entry["level"] != "warn" {
		t.Errorf("level = %v, want warn", entry["level"])
	}
}

func TestHandleRequest_失敗時はerrorログを出す(t *testing.T) {
	c := withCapturedObservability(t)
	snsClient = &mockSNS{returnErr: errors.New("SNS connection error")}

	if _, err := HandleRequest(context.Background(), obsEvent("finding-002")); err == nil {
		t.Fatal("エラーが返るはず")
	}

	entry := c.findLog(t, "SNS への通知に失敗しました")
	if entry == nil {
		t.Fatal("エラーログが見つからない")
	}
	if entry["level"] != "error" {
		t.Errorf("level = %v, want error", entry["level"])
	}
}

// ── EMF メトリクス ────────────────────────────────────────────

func TestHandleRequest_EMFが1行出力される(t *testing.T) {
	c := withCapturedObservability(t)
	snsClient = &mockSNS{}

	if _, err := HandleRequest(context.Background(), obsEvent("finding-003")); err != nil {
		t.Fatalf("予期しないエラー: %v", err)
	}

	doc := c.emfDocument(t)
	if doc["Handler"] != handlerDimension {
		t.Errorf("Handler = %v, want %s", doc["Handler"], handlerDimension)
	}

	aws, ok := doc["_aws"].(map[string]any)
	if !ok {
		t.Fatal("_aws が無い")
	}
	cwm, ok := aws["CloudWatchMetrics"].([]any)
	if !ok || len(cwm) == 0 {
		t.Fatal("CloudWatchMetrics が無い")
	}
	ns := cwm[0].(map[string]any)["Namespace"]
	if ns != "Test/GuarddutyNotifier" {
		t.Errorf("Namespace = %v, want Test/GuarddutyNotifier", ns)
	}
}

func TestHandleRequest_成功時のメトリクス(t *testing.T) {
	c := withCapturedObservability(t)
	snsClient = &mockSNS{}

	if _, err := HandleRequest(context.Background(), obsEvent("finding-004")); err != nil {
		t.Fatalf("予期しないエラー: %v", err)
	}

	doc := c.emfDocument(t)
	if doc["NotificationSuccess"] != 1.0 {
		t.Errorf("NotificationSuccess = %v, want 1", doc["NotificationSuccess"])
	}
	if _, ok := doc["PublishLatency"]; !ok {
		t.Error("PublishLatency が記録されていない")
	}
	if _, ok := doc["NotificationError"]; ok {
		t.Error("成功時に NotificationError が記録されている")
	}
}

func TestHandleRequest_失敗時のメトリクス(t *testing.T) {
	c := withCapturedObservability(t)
	snsClient = &mockSNS{returnErr: errors.New("SNS down")}

	if _, err := HandleRequest(context.Background(), obsEvent("finding-005")); err == nil {
		t.Fatal("エラーが返るはず")
	}

	doc := c.emfDocument(t)
	if doc["NotificationError"] != 1.0 {
		t.Errorf("NotificationError = %v, want 1", doc["NotificationError"])
	}
	if _, ok := doc["NotificationSuccess"]; ok {
		t.Error("失敗時に NotificationSuccess が記録されている")
	}
}

func TestHandleRequest_空detailはEmptyDetailに計上される(t *testing.T) {
	c := withCapturedObservability(t)
	snsClient = &mockSNS{}

	if _, err := HandleRequest(context.Background(), GuardDutyEvent{}); err != nil {
		t.Fatalf("予期しないエラー: %v", err)
	}

	doc := c.emfDocument(t)
	if doc["EmptyDetail"] != 1.0 {
		t.Errorf("EmptyDetail = %v, want 1", doc["EmptyDetail"])
	}
}

// ── リトライ層との結線 ────────────────────────────────────────

func TestHandleRequest_リトライでログとメトリクスの両方が記録される(t *testing.T) {
	c := withCapturedObservability(t)
	// 1 回目はスロットリング、2 回目で成功する
	flaky := &flakySNS{failTimes: 1, failErr: retryTestThrottling}
	snsClient = flaky

	orig := retrier
	retrier = Retrier{Config: RetryConfig{MaxAttempts: 3, BaseDelay: time.Millisecond, MaxDelay: time.Millisecond, Jitter: false}}
	t.Cleanup(func() { retrier = orig })

	if _, err := HandleRequest(context.Background(), obsEvent("finding-006")); err != nil {
		t.Fatalf("リトライ後に成功するはず: %v", err)
	}

	// ログ側
	entry := c.findLog(t, "AWS API 呼び出しをリトライします")
	if entry == nil {
		t.Fatal("リトライの warn ログが見つからない")
	}
	if entry["level"] != "warn" {
		t.Errorf("level = %v, want warn", entry["level"])
	}
	if entry["operation"] != RetryOperation {
		t.Errorf("operation = %v, want %s", entry["operation"], RetryOperation)
	}
	if entry["findingId"] != "finding-006" {
		t.Errorf("findingId = %v, want finding-006（子ロガーの情報が載っていない）", entry["findingId"])
	}

	if flaky.calls != 2 {
		t.Errorf("Publish 呼び出し回数 = %d, want 2（1 回失敗 + 1 回成功）", flaky.calls)
	}

	// メトリクス側
	doc := c.emfDocument(t)
	if doc["RetryAttempt"] != 1.0 {
		t.Errorf("RetryAttempt = %v, want 1", doc["RetryAttempt"])
	}
	if doc["retryOperation"] != RetryOperation {
		t.Errorf("retryOperation = %v, want %s", doc["retryOperation"], RetryOperation)
	}
	if doc["NotificationSuccess"] != 1.0 {
		t.Errorf("NotificationSuccess = %v, want 1", doc["NotificationSuccess"])
	}
}

func TestHandleRequest_リトライ不能なエラーはリトライしない(t *testing.T) {
	c := withCapturedObservability(t)
	snsClient = &mockSNS{returnErr: errors.New("plain error")}

	if _, err := HandleRequest(context.Background(), obsEvent("finding-007")); err == nil {
		t.Fatal("エラーが返るはず")
	}

	if entry := c.findLog(t, "AWS API 呼び出しをリトライします"); entry != nil {
		t.Error("リトライ対象外のエラーでリトライのログが出ている")
	}
	if _, ok := c.emfDocument(t)["RetryAttempt"]; ok {
		t.Error("リトライ対象外のエラーで RetryAttempt が記録されている")
	}
}

// ── 既定値の不変条件 ──────────────────────────────────────────

func TestNewMetrics_既定の名前空間なら必ず生成できる(t *testing.T) {
	// newMetrics() は環境変数が不正なとき、この組み合わせで作り直して
	// エラーを無視している。その前提が崩れていないことを固定する。
	m, err := NewMetrics(MetricsOptions{
		Namespace:  DefaultMetricsNamespace,
		Dimensions: map[string]string{"Handler": handlerDimension},
	})
	if err != nil {
		t.Fatalf("既定の名前空間で生成できない: %v", err)
	}
	if m == nil {
		t.Fatal("Metrics が nil")
	}
}

func TestNewMetrics_環境変数が不正でも既定値へ倒す(t *testing.T) {
	t.Setenv("METRICS_NAMESPACE", strings.Repeat("a", 2000)) // 上限超過
	var buf bytes.Buffer
	logger := NewLogger(LoggerOptions{Writer: &buf})

	m := newMetrics(logger)
	if m == nil {
		t.Fatal("メトリクスが nil。名前空間が不正でも本処理は止めない方針")
	}
	if !strings.Contains(buf.String(), "METRICS_NAMESPACE") {
		t.Error("不正な名前空間の警告ログが出ていない")
	}
}

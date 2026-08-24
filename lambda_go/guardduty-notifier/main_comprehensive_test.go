package main

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/sns"
)

// ── getString テーブル駆動テスト ────────────────────────────────────

func TestGetString_Table(t *testing.T) {
	tests := []struct {
		name string
		m    map[string]interface{}
		key  string
		want string
	}{
		{"existing key", map[string]interface{}{"k": "v"}, "k", "v"},
		{"missing key", map[string]interface{}{"k": "v"}, "other", ""},
		{"empty string value", map[string]interface{}{"k": ""}, "k", ""},
		{"nil value", map[string]interface{}{"k": nil}, "k", ""},
		{"int value returns empty", map[string]interface{}{"k": 42}, "k", ""},
		{"bool value returns empty", map[string]interface{}{"k": true}, "k", ""},
		{"float value returns empty", map[string]interface{}{"k": 3.14}, "k", ""},
		{"Japanese value", map[string]interface{}{"k": "東京リージョン"}, "k", "東京リージョン"},
		{"special chars", map[string]interface{}{"k": "a&b<c>d"}, "k", "a&b<c>d"},
		{"empty map", map[string]interface{}{}, "k", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := getString(tt.m, tt.key)
			if got != tt.want {
				t.Errorf("getString(%v, %q) = %q, want %q", tt.m, tt.key, got, tt.want)
			}
		})
	}
}

// ── getFloat64 テーブル駆動テスト ───────────────────────────────────

func TestGetFloat64_Table(t *testing.T) {
	tests := []struct {
		name string
		m    map[string]interface{}
		key  string
		want float64
	}{
		{"float64 value", map[string]interface{}{"s": 7.5}, "s", 7.5},
		{"int value", map[string]interface{}{"s": int(4)}, "s", 4.0},
		{"zero float", map[string]interface{}{"s": float64(0)}, "s", 0.0},
		{"negative float", map[string]interface{}{"s": -3.0}, "s", -3.0},
		{"missing key", map[string]interface{}{}, "s", 0.0},
		{"string value returns 0", map[string]interface{}{"s": "high"}, "s", 0.0},
		{"bool value returns 0", map[string]interface{}{"s": true}, "s", 0.0},
		{"nil value returns 0", map[string]interface{}{"s": nil}, "s", 0.0},
		{"large float", map[string]interface{}{"s": 999.99}, "s", 999.99},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := getFloat64(tt.m, tt.key)
			if got != tt.want {
				t.Errorf("getFloat64(%v, %q) = %f, want %f", tt.m, tt.key, got, tt.want)
			}
		})
	}
}

// ── truncate テーブル駆動テスト ─────────────────────────────────────

func TestTruncate_Table(t *testing.T) {
	tests := []struct {
		name  string
		input string
		n     int
		want  string
	}{
		{"shorter than n", "abc", 10, "abc"},
		{"exact length", "abcde", 5, "abcde"},
		{"longer than n", "abcdef", 3, "abc"},
		{"empty string", "", 5, ""},
		{"n=0", "hello", 0, ""},
		{"n=1", "hello", 1, "h"},
		{"mixed ASCII+Japanese", "aあbいc", 3, "aあb"},
		{"emoji", "🎉🎊🎈", 2, "🎉🎊"},
		{"single char", "x", 1, "x"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := truncate(tt.input, tt.n)
			if got != tt.want {
				t.Errorf("truncate(%q, %d) = %q, want %q", tt.input, tt.n, got, tt.want)
			}
		})
	}
}

// ── GetSeverityLabel テーブル駆動テスト（網羅） ─────────────────────

func TestGetSeverityLabel_Comprehensive(t *testing.T) {
	tests := []struct {
		severity float64
		want     string
	}{
		{0.0, "[LOW]"},
		{1.0, "[LOW]"},
		{3.9, "[LOW]"},
		{4.0, "[MEDIUM]"},
		{5.5, "[MEDIUM]"},
		{6.9, "[MEDIUM]"},
		{7.0, "[HIGH]"},
		{8.0, "[HIGH]"},
		{8.9, "[HIGH]"},
		{9.0, "[CRITICAL]"},
		{9.5, "[CRITICAL]"},
		{10.0, "[CRITICAL]"},
	}
	for _, tt := range tests {
		t.Run("", func(t *testing.T) {
			got := GetSeverityLabel(tt.severity)
			if got != tt.want {
				t.Errorf("GetSeverityLabel(%.1f) = %q, want %q", tt.severity, got, tt.want)
			}
		})
	}
}

// ── BuildMessage 構造検証 ───────────────────────────────────────────

func TestBuildMessage_HeaderText(t *testing.T) {
	detail := makeDetail(5.0, "Title", "Desc", "Type", "ap-northeast-1", "123", "id")
	_, message := BuildMessage(detail)

	lines := strings.Split(message, "\n")
	if lines[0] != "GuardDuty セキュリティアラート" {
		t.Errorf("first line should be header, got %q", lines[0])
	}
}

func TestBuildMessage_LineCount(t *testing.T) {
	detail := makeDetail(5.0, "Title", "Desc", "Type", "ap-northeast-1", "123", "id")
	_, message := BuildMessage(detail)

	lines := strings.Split(message, "\n")
	// main.go の lines スライスは 19 要素
	if len(lines) != 19 {
		t.Errorf("message should have 19 lines, got %d", len(lines))
	}
}

func TestBuildMessage_AllFieldsPresent(t *testing.T) {
	detail := makeDetail(8.5, "CryptoMining:EC2/BitcoinTool", "マイニング検出", "CryptoCurrency:EC2/BitcoinTool.B", "eu-west-1", "444555666777", "find-crypto-001")
	subject, message := BuildMessage(detail)

	// subject に必要要素が含まれる
	if !strings.Contains(subject, "[GuardDuty]") {
		t.Error("subject missing [GuardDuty] prefix")
	}
	if !strings.Contains(subject, "[HIGH]") {
		t.Error("subject missing [HIGH] label for severity 8.5")
	}

	// message に全フィールドが含まれる
	required := []string{
		"8.5",
		"[HIGH]",
		"CryptoCurrency:EC2/BitcoinTool.B",
		"CryptoMining:EC2/BitcoinTool",
		"マイニング検出",
		"eu-west-1",
		"444555666777",
		"find-crypto-001",
		"eu-west-1.console.aws.amazon.com",
	}
	for _, r := range required {
		if !strings.Contains(message, r) {
			t.Errorf("message missing required field: %q", r)
		}
	}
}

func TestBuildMessage_SubjectFormat(t *testing.T) {
	detail := makeDetail(4.0, "Stealth:IAMUser/CloudTrailLoggingDisabled", "Desc", "Type", "ap-northeast-1", "123", "id")
	subject, _ := BuildMessage(detail)

	// 形式: "[GuardDuty] [MEDIUM] Stealth:IAMUser/CloudTrailLoggingDisabled"
	parts := strings.SplitN(subject, " ", 3)
	if len(parts) < 3 {
		t.Fatalf("subject should have at least 3 parts: %q", subject)
	}
	if parts[0] != "[GuardDuty]" {
		t.Errorf("first part should be [GuardDuty], got %q", parts[0])
	}
	if parts[1] != "[MEDIUM]" {
		t.Errorf("second part should be [MEDIUM], got %q", parts[1])
	}
}

func TestBuildMessage_SpecialCharsInTitle(t *testing.T) {
	detail := makeDetail(7.0, "Backdoor:EC2/C&CActivity.B!DNS", "Desc", "Type", "ap-northeast-1", "123", "id")
	subject, _ := BuildMessage(detail)

	if !strings.Contains(subject, "C&CActivity") {
		t.Errorf("subject should preserve special characters: %q", subject)
	}
}

func TestBuildMessage_ConsoleURLStructure(t *testing.T) {
	detail := makeDetail(5.0, "Title", "Desc", "Type", "us-east-1", "123", "abc-def-123")
	_, message := BuildMessage(detail)

	expectedURL := "https://us-east-1.console.aws.amazon.com/guardduty/home?region=us-east-1#/findings?macros=current&fId=abc-def-123"
	if !strings.Contains(message, expectedURL) {
		t.Errorf("message should contain exact console URL:\nwant: %s\ngot message:\n%s", expectedURL, message)
	}
}

// ── HandleRequest 追加検証 ──────────────────────────────────────────

func TestHandleRequest_EmptyMapDetail_Returns400Body(t *testing.T) {
	mock := &mockSNS{}
	snsClient = mock

	resp, _ := HandleRequest(context.Background(), GuardDutyEvent{Detail: map[string]interface{}{}})

	if resp.Body != "Empty detail" {
		t.Errorf("body = %q, want %q", resp.Body, "Empty detail")
	}
}

func TestHandleRequest_SNSErrorWrapsOriginal(t *testing.T) {
	originalErr := errors.New("connection timeout")
	mock := &mockSNS{returnErr: originalErr}
	snsClient = mock
	t.Setenv("SNS_TOPIC_ARN", "arn:aws:sns:ap-northeast-1:123:topic")

	detail := makeDetail(7.0, "Title", "Desc", "Type", "ap-northeast-1", "123", "id")
	_, err := HandleRequest(context.Background(), makeEvent(detail))

	if !errors.Is(err, originalErr) {
		t.Errorf("error should wrap original error: %v", err)
	}
}

func TestHandleRequest_LowSeverityStillProcesses(t *testing.T) {
	mock := &mockSNS{}
	snsClient = mock
	t.Setenv("SNS_TOPIC_ARN", "arn:aws:sns:ap-northeast-1:123:topic")

	// severity 2.0 は EventBridge フィルタで通常除外されるが、
	// Lambda 自体は処理可能
	detail := makeDetail(2.0, "Low Finding", "Desc", "Type", "ap-northeast-1", "123", "id")
	resp, err := HandleRequest(context.Background(), makeEvent(detail))

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Errorf("statusCode = %d, want 200", resp.StatusCode)
	}
	if !strings.Contains(*mock.publishedInput.Subject, "[LOW]") {
		t.Errorf("subject should contain [LOW] for severity 2.0")
	}
}

func TestHandleRequest_TopicArnFromEnv(t *testing.T) {
	mock := &mockSNS{}
	snsClient = mock
	customARN := "arn:aws:sns:eu-west-1:999:custom-topic"
	t.Setenv("SNS_TOPIC_ARN", customARN)

	detail := makeDetail(5.0, "Title", "Desc", "Type", "ap-northeast-1", "123", "id")
	HandleRequest(context.Background(), makeEvent(detail))

	if *mock.publishedInput.TopicArn != customARN {
		t.Errorf("TopicArn = %q, want %q", *mock.publishedInput.TopicArn, customARN)
	}
}

func TestHandleRequest_MessageIdReturned(t *testing.T) {
	mock := &mockSNS{}
	snsClient = mock
	t.Setenv("SNS_TOPIC_ARN", "arn:aws:sns:ap-northeast-1:123:topic")

	detail := makeDetail(7.0, "Title", "Desc", "Type", "ap-northeast-1", "123", "id")
	resp, err := HandleRequest(context.Background(), makeEvent(detail))

	// mockSNS は "test-message-id" を返す → 正常レスポンスであること
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Errorf("statusCode = %d, want 200", resp.StatusCode)
	}
}

func TestHandleRequest_SNSPublishCalledOnce(t *testing.T) {
	callCount := 0
	mock := &countingSNS{count: &callCount}
	snsClient = mock
	t.Setenv("SNS_TOPIC_ARN", "arn:aws:sns:ap-northeast-1:123:topic")

	detail := makeDetail(5.0, "Title", "Desc", "Type", "ap-northeast-1", "123", "id")
	HandleRequest(context.Background(), makeEvent(detail))

	if callCount != 1 {
		t.Errorf("SNS Publish should be called once, got %d", callCount)
	}
}

// ── countingSNS（呼び出し回数カウント用モック） ──────────────────────

type countingSNS struct {
	count *int
}

func (c *countingSNS) Publish(_ context.Context, _ *sns.PublishInput, _ ...func(*sns.Options)) (*sns.PublishOutput, error) {
	*c.count++
	msgID := "count-msg-id"
	return &sns.PublishOutput{MessageId: &msgID}, nil
}

// ── ベンチマーク追加 ────────────────────────────────────────────────

func BenchmarkHandleRequest(b *testing.B) {
	mock := &mockSNS{}
	snsClient = mock
	b.Setenv("SNS_TOPIC_ARN", "arn:aws:sns:ap-northeast-1:123:topic")

	detail := makeDetail(7.0, "Recon:IAMUser/MaliciousIPCaller", "不審なIPから呼び出し", "Recon", "ap-northeast-1", "123456789012", "find-bench-001")
	event := makeEvent(detail)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		HandleRequest(context.Background(), event)
	}
}

func BenchmarkGetString(b *testing.B) {
	m := map[string]interface{}{"title": "Test Finding Title"}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		getString(m, "title")
	}
}

func BenchmarkGetFloat64(b *testing.B) {
	m := map[string]interface{}{"severity": 7.5}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		getFloat64(m, "severity")
	}
}

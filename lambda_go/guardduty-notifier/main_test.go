package main

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/sns"
)

// ── モック SNS ────────────────────────────────────────────────────

type mockSNS struct {
	publishedInput *sns.PublishInput
	returnErr      error
}

func (m *mockSNS) Publish(_ context.Context, params *sns.PublishInput, _ ...func(*sns.Options)) (*sns.PublishOutput, error) {
	m.publishedInput = params
	if m.returnErr != nil {
		return nil, m.returnErr
	}
	msgID := "test-message-id"
	return &sns.PublishOutput{MessageId: &msgID}, nil
}

// ── ヘルパー ─────────────────────────────────────────────────────

func makeDetail(severity float64, title, description, findingType, region, accountID, findingID string) map[string]interface{} {
	return map[string]interface{}{
		"severity":    severity,
		"title":       title,
		"description": description,
		"type":        findingType,
		"region":      region,
		"accountId":   accountID,
		"id":          findingID,
	}
}

func makeEvent(detail map[string]interface{}) GuardDutyEvent {
	return GuardDutyEvent{Detail: detail}
}

// ── GetSeverityLabel ─────────────────────────────────────────────

func TestGetSeverityLabel(t *testing.T) {
	tests := []struct {
		severity float64
		want     string
	}{
		{9.0, "[CRITICAL]"},
		{9.5, "[CRITICAL]"},
		{7.0, "[HIGH]"},
		{8.9, "[HIGH]"},
		{4.0, "[MEDIUM]"},
		{6.9, "[MEDIUM]"},
		{3.9, "[LOW]"},
		{0.0, "[LOW]"},
	}
	for _, tt := range tests {
		got := GetSeverityLabel(tt.severity)
		if got != tt.want {
			t.Errorf("GetSeverityLabel(%.1f) = %q, want %q", tt.severity, got, tt.want)
		}
	}
}

// ── BuildMessage ────────────────────────────────────────────────

func TestBuildMessage_Subject(t *testing.T) {
	detail := makeDetail(7.5, "Recon:IAMUser/MaliciousIPCaller", "不審なIPから呼び出しがありました", "Recon", "ap-northeast-1", "123456789012", "abc-def")
	subject, _ := BuildMessage(detail)

	if !strings.HasPrefix(subject, "[GuardDuty] [HIGH]") {
		t.Errorf("subject prefix mismatch: %s", subject)
	}
	if !strings.Contains(subject, "Recon:IAMUser/MaliciousIPCaller") {
		t.Errorf("subject should contain title: %s", subject)
	}
}

func TestBuildMessage_MessageContainsFields(t *testing.T) {
	detail := makeDetail(9.0, "Backdoor:EC2/C&CActivity.B", "C2サーバーへの通信を検出", "Backdoor", "us-east-1", "999888777666", "find-xyz")
	_, message := BuildMessage(detail)

	checks := []string{"[CRITICAL]", "us-east-1", "999888777666", "find-xyz", "Backdoor:EC2/C&CActivity.B"}
	for _, c := range checks {
		if !strings.Contains(message, c) {
			t.Errorf("message should contain %q", c)
		}
	}
}

func TestBuildMessage_LongTitleTruncated(t *testing.T) {
	longTitle := strings.Repeat("あ", 80)
	detail := makeDetail(5.0, longTitle, "説明", "Type", "ap-northeast-1", "123", "id")
	subject, _ := BuildMessage(detail)

	// [GuardDuty] [MEDIUM] + 60 文字以内 → 全体が過剰に長くならないこと
	runes := []rune(subject)
	if len(runes) > 150 {
		t.Errorf("subject too long: %d runes", len(runes))
	}
}

func TestBuildMessage_ConsoleURLContainsRegionAndID(t *testing.T) {
	detail := makeDetail(4.5, "Title", "Desc", "Type", "ap-northeast-1", "123", "finding-001")
	_, message := BuildMessage(detail)

	if !strings.Contains(message, "ap-northeast-1.console.aws.amazon.com") {
		t.Errorf("message should contain console URL with region")
	}
	if !strings.Contains(message, "finding-001") {
		t.Errorf("message should contain finding ID in URL")
	}
}

// ── HandleRequest ────────────────────────────────────────────────

func TestHandleRequest_正常系_200を返す(t *testing.T) {
	mock := &mockSNS{}
	snsClient = mock
	t.Setenv("SNS_TOPIC_ARN", "arn:aws:sns:ap-northeast-1:123:test-topic")

	detail := makeDetail(7.0, "Test Finding", "テスト説明", "Test:Type", "ap-northeast-1", "123456789012", "find-001")
	resp, err := HandleRequest(context.Background(), makeEvent(detail))

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Errorf("statusCode = %d, want 200", resp.StatusCode)
	}
}

func TestHandleRequest_SNSにTopicArnが渡される(t *testing.T) {
	mock := &mockSNS{}
	snsClient = mock
	t.Setenv("SNS_TOPIC_ARN", "arn:aws:sns:ap-northeast-1:123:test-topic")

	detail := makeDetail(7.0, "Title", "Desc", "Type", "ap-northeast-1", "123", "id-1")
	HandleRequest(context.Background(), makeEvent(detail))

	if *mock.publishedInput.TopicArn != "arn:aws:sns:ap-northeast-1:123:test-topic" {
		t.Errorf("TopicArn mismatch: %s", *mock.publishedInput.TopicArn)
	}
}

func TestHandleRequest_件名が100文字以内(t *testing.T) {
	mock := &mockSNS{}
	snsClient = mock
	t.Setenv("SNS_TOPIC_ARN", "arn:aws:sns:ap-northeast-1:123:test-topic")

	longTitle := strings.Repeat("X", 200)
	detail := makeDetail(9.0, longTitle, "Desc", "Type", "ap-northeast-1", "123", "id-2")
	HandleRequest(context.Background(), makeEvent(detail))

	subject := *mock.publishedInput.Subject
	if len([]rune(subject)) > 100 {
		t.Errorf("subject too long: %d runes", len([]rune(subject)))
	}
}

func TestHandleRequest_空のdetailは400を返す(t *testing.T) {
	mock := &mockSNS{}
	snsClient = mock

	resp, err := HandleRequest(context.Background(), GuardDutyEvent{Detail: map[string]interface{}{}})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.StatusCode != 400 {
		t.Errorf("statusCode = %d, want 400", resp.StatusCode)
	}
}

func TestHandleRequest_SNSエラーは伝播する(t *testing.T) {
	mock := &mockSNS{returnErr: errors.New("SNS connection error")}
	snsClient = mock
	t.Setenv("SNS_TOPIC_ARN", "arn:aws:sns:ap-northeast-1:123:test-topic")

	detail := makeDetail(7.0, "Title", "Desc", "Type", "ap-northeast-1", "123", "id-3")
	_, err := HandleRequest(context.Background(), makeEvent(detail))

	if err == nil {
		t.Fatal("expected error but got nil")
	}
	if !strings.Contains(err.Error(), "SNS publish failed") {
		t.Errorf("error message mismatch: %v", err)
	}
}

func TestHandleRequest_本文にSeverityが含まれる(t *testing.T) {
	mock := &mockSNS{}
	snsClient = mock
	t.Setenv("SNS_TOPIC_ARN", "arn:aws:sns:ap-northeast-1:123:test-topic")

	detail := makeDetail(7.0, "Title", "Desc", "Type", "ap-northeast-1", "123", "id-4")
	HandleRequest(context.Background(), makeEvent(detail))

	if !strings.Contains(*mock.publishedInput.Message, "7.0") {
		t.Errorf("message should contain severity value 7.0")
	}
}

func TestHandleRequest_CriticalEventは200を返す(t *testing.T) {
	mock := &mockSNS{}
	snsClient = mock
	t.Setenv("SNS_TOPIC_ARN", "arn:aws:sns:ap-northeast-1:123:test-topic")

	detail := makeDetail(9.5, "Backdoor:EC2/XORDDOS", "深刻な脅威", "Backdoor", "ap-northeast-1", "123456789012", "find-critical")
	resp, err := HandleRequest(context.Background(), makeEvent(detail))

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Errorf("statusCode = %d, want 200", resp.StatusCode)
	}
}

// ── ユーティリティ関数の直接テスト ───────────────────────────────

func TestGetString_MissingKey(t *testing.T) {
	m := map[string]interface{}{"key": "value"}
	got := getString(m, "missing")
	if got != "" {
		t.Errorf("missing key should return empty string, got %q", got)
	}
}

func TestGetString_NonStringValue(t *testing.T) {
	m := map[string]interface{}{"num": 42}
	got := getString(m, "num")
	if got != "" {
		t.Errorf("non-string value should return empty string, got %q", got)
	}
}

func TestGetFloat64_IntValue(t *testing.T) {
	m := map[string]interface{}{"severity": int(7)}
	got := getFloat64(m, "severity")
	if got != 7.0 {
		t.Errorf("int value should be converted to float64: want 7.0, got %f", got)
	}
}

func TestGetFloat64_MissingKey(t *testing.T) {
	m := map[string]interface{}{}
	got := getFloat64(m, "missing")
	if got != 0.0 {
		t.Errorf("missing key should return 0.0, got %f", got)
	}
}

func TestTruncate_ExactLength(t *testing.T) {
	s := strings.Repeat("a", 60)
	got := truncate(s, 60)
	if got != s {
		t.Errorf("exact length should not be truncated")
	}
}

func TestTruncate_EmptyString(t *testing.T) {
	got := truncate("", 10)
	if got != "" {
		t.Errorf("empty string truncation should return empty, got %q", got)
	}
}

func TestBuildMessage_CriticalLabelInSubject(t *testing.T) {
	detail := makeDetail(9.5, "Title", "Desc", "Type", "ap-northeast-1", "123", "id")
	subject, _ := BuildMessage(detail)

	if !strings.Contains(subject, "[CRITICAL]") {
		t.Errorf("subject should contain [CRITICAL] for severity 9.5: %s", subject)
	}
}

func TestBuildMessage_LowSeverityLabel(t *testing.T) {
	detail := makeDetail(0.0, "Title", "Desc", "Type", "ap-northeast-1", "123", "id")
	subject, _ := BuildMessage(detail)

	if !strings.Contains(subject, "[LOW]") {
		t.Errorf("subject should contain [LOW] for severity 0.0: %s", subject)
	}
}

func TestBuildMessage_DescriptionInMessage(t *testing.T) {
	detail := makeDetail(5.0, "Title", "不審なS3アクセスが検出されました", "Type", "ap-northeast-1", "123", "id")
	_, message := BuildMessage(detail)

	if !strings.Contains(message, "不審なS3アクセスが検出されました") {
		t.Errorf("message should contain description text")
	}
}

func TestBuildMessage_AccountIDInMessage(t *testing.T) {
	detail := makeDetail(5.0, "Title", "Desc", "Type", "ap-northeast-1", "555666777888", "id")
	_, message := BuildMessage(detail)

	if !strings.Contains(message, "555666777888") {
		t.Errorf("message should contain accountId: 555666777888")
	}
}

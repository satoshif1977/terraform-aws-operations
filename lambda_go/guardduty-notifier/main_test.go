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

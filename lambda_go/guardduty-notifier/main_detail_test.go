package main

import (
	"context"
	"strings"
	"testing"
)

// ── truncate 詳細テスト ───────────────────────────────────────────

func TestTruncate_LongerThanN(t *testing.T) {
	got := truncate("abcdef", 3)
	if got != "abc" {
		t.Errorf("truncate(abcdef, 3) = %q, want %q", got, "abc")
	}
}

func TestTruncate_JapaneseRunes(t *testing.T) {
	// 日本語はルーン単位でカウントされる
	s := "あいうえおかきくけこ" // 10 runes
	got := truncate(s, 5)
	if got != "あいうえお" {
		t.Errorf("truncate Japanese = %q, want %q", got, "あいうえお")
	}
}

func TestTruncate_Zero(t *testing.T) {
	got := truncate("hello", 0)
	if got != "" {
		t.Errorf("truncate to 0 should return empty, got %q", got)
	}
}

func TestTruncate_ShorterThanN(t *testing.T) {
	got := truncate("hi", 100)
	if got != "hi" {
		t.Errorf("short string should not be truncated, got %q", got)
	}
}

// ── getFloat64 詳細テスト ─────────────────────────────────────────

func TestGetFloat64_Float64Value(t *testing.T) {
	m := map[string]interface{}{"severity": float64(9.0)}
	got := getFloat64(m, "severity")
	if got != 9.0 {
		t.Errorf("getFloat64 = %f, want 9.0", got)
	}
}

func TestGetFloat64_WrongType(t *testing.T) {
	m := map[string]interface{}{"severity": "high"}
	got := getFloat64(m, "severity")
	if got != 0.0 {
		t.Errorf("wrong type should return 0.0, got %f", got)
	}
}

// ── getString 詳細テスト ─────────────────────────────────────────

func TestGetString_ExistsAndEmpty(t *testing.T) {
	m := map[string]interface{}{"title": ""}
	got := getString(m, "title")
	if got != "" {
		t.Errorf("empty string value should return empty, got %q", got)
	}
}

func TestGetString_NormalValue(t *testing.T) {
	m := map[string]interface{}{"region": "ap-northeast-1"}
	got := getString(m, "region")
	if got != "ap-northeast-1" {
		t.Errorf("getString = %q, want %q", got, "ap-northeast-1")
	}
}

// ── BuildMessage 詳細テスト ───────────────────────────────────────

func TestBuildMessage_SeparatorInMessage(t *testing.T) {
	detail := makeDetail(5.0, "Title", "Desc", "Type", "ap-northeast-1", "123", "id")
	_, message := BuildMessage(detail)

	if !strings.Contains(message, strings.Repeat("=", 50)) {
		t.Errorf("message should contain separator line of '='")
	}
}

func TestBuildMessage_FindingTypeInMessage(t *testing.T) {
	detail := makeDetail(7.0, "Title", "Desc", "UnauthorizedAccess:EC2/TorIPCaller", "ap-northeast-1", "123", "id")
	_, message := BuildMessage(detail)

	if !strings.Contains(message, "UnauthorizedAccess:EC2/TorIPCaller") {
		t.Errorf("message should contain finding type")
	}
}

func TestBuildMessage_FooterInMessage(t *testing.T) {
	detail := makeDetail(5.0, "Title", "Desc", "Type", "ap-northeast-1", "123", "id")
	_, message := BuildMessage(detail)

	if !strings.Contains(message, "guardduty-notifier") {
		t.Errorf("message should contain footer text with lambda name")
	}
}

func TestBuildMessage_MediumLabel(t *testing.T) {
	detail := makeDetail(6.0, "Title", "Desc", "Type", "ap-northeast-1", "123", "id")
	subject, _ := BuildMessage(detail)

	if !strings.Contains(subject, "[MEDIUM]") {
		t.Errorf("subject should contain [MEDIUM] for severity 6.0: %s", subject)
	}
}

func TestBuildMessage_HighLabel(t *testing.T) {
	detail := makeDetail(7.0, "Title", "Desc", "Type", "ap-northeast-1", "123", "id")
	subject, _ := BuildMessage(detail)

	if !strings.Contains(subject, "[HIGH]") {
		t.Errorf("subject should contain [HIGH] for severity 7.0: %s", subject)
	}
}

func TestBuildMessage_RegionInMessage(t *testing.T) {
	detail := makeDetail(5.0, "Title", "Desc", "Type", "eu-west-1", "123", "id")
	_, message := BuildMessage(detail)

	if !strings.Contains(message, "eu-west-1") {
		t.Errorf("message should contain region eu-west-1")
	}
}

func TestBuildMessage_SeverityValueInMessage(t *testing.T) {
	detail := makeDetail(4.5, "Title", "Desc", "Type", "ap-northeast-1", "123", "id")
	_, message := BuildMessage(detail)

	if !strings.Contains(message, "4.5") {
		t.Errorf("message should contain severity value 4.5")
	}
}

// ── HandleRequest 詳細テスト ──────────────────────────────────────

func TestHandleRequest_BodyIsNotificationSent(t *testing.T) {
	mock := &mockSNS{}
	snsClient = mock
	t.Setenv("SNS_TOPIC_ARN", "arn:aws:sns:ap-northeast-1:123:topic")

	detail := makeDetail(5.0, "Title", "Desc", "Type", "ap-northeast-1", "123", "id")
	resp, _ := HandleRequest(context.Background(), makeEvent(detail))

	if resp.Body != "Notification sent" {
		t.Errorf("body = %q, want %q", resp.Body, "Notification sent")
	}
}

func TestHandleRequest_MediumSeverityReturns200(t *testing.T) {
	mock := &mockSNS{}
	snsClient = mock
	t.Setenv("SNS_TOPIC_ARN", "arn:aws:sns:ap-northeast-1:123:topic")

	detail := makeDetail(5.0, "UnauthorizedAccess:S3/TorIPCaller", "説明", "Type", "ap-northeast-1", "123", "id-m")
	resp, err := HandleRequest(context.Background(), makeEvent(detail))

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Errorf("statusCode = %d, want 200", resp.StatusCode)
	}
}

func TestHandleRequest_MessageContainsFindingType(t *testing.T) {
	mock := &mockSNS{}
	snsClient = mock
	t.Setenv("SNS_TOPIC_ARN", "arn:aws:sns:ap-northeast-1:123:topic")

	detail := makeDetail(7.0, "Title", "Desc", "Recon:IAMUser/NetworkPermissions", "ap-northeast-1", "123", "id")
	HandleRequest(context.Background(), makeEvent(detail))

	if !strings.Contains(*mock.publishedInput.Message, "Recon:IAMUser/NetworkPermissions") {
		t.Errorf("SNS message should contain finding type")
	}
}

func TestHandleRequest_SubjectContainsSeverityLabel(t *testing.T) {
	mock := &mockSNS{}
	snsClient = mock
	t.Setenv("SNS_TOPIC_ARN", "arn:aws:sns:ap-northeast-1:123:topic")

	detail := makeDetail(9.0, "Backdoor:Lambda/C&CActivity", "C2通信", "Backdoor", "ap-northeast-1", "123", "id")
	HandleRequest(context.Background(), makeEvent(detail))

	if !strings.Contains(*mock.publishedInput.Subject, "[CRITICAL]") {
		t.Errorf("SNS subject should contain [CRITICAL]: %s", *mock.publishedInput.Subject)
	}
}

func TestHandleRequest_EmptyBodyReturns400(t *testing.T) {
	mock := &mockSNS{}
	snsClient = mock

	resp, err := HandleRequest(context.Background(), GuardDutyEvent{Detail: nil})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.StatusCode != 400 {
		t.Errorf("nil detail should return 400, got %d", resp.StatusCode)
	}
}

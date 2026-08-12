package main

import (
	"context"
	"strings"
	"testing"
)

// ── GetSeverityLabel 境界値テスト ─────────────────────────────────

func TestGetSeverityLabel_Boundary9_0(t *testing.T) {
	// 9.0 ちょうど → CRITICAL
	got := GetSeverityLabel(9.0)
	if got != "[CRITICAL]" {
		t.Errorf("GetSeverityLabel(9.0) = %q, want [CRITICAL]", got)
	}
}

func TestGetSeverityLabel_Boundary7_0(t *testing.T) {
	// 7.0 ちょうど → HIGH
	got := GetSeverityLabel(7.0)
	if got != "[HIGH]" {
		t.Errorf("GetSeverityLabel(7.0) = %q, want [HIGH]", got)
	}
}

func TestGetSeverityLabel_Boundary4_0(t *testing.T) {
	// 4.0 ちょうど → MEDIUM
	got := GetSeverityLabel(4.0)
	if got != "[MEDIUM]" {
		t.Errorf("GetSeverityLabel(4.0) = %q, want [MEDIUM]", got)
	}
}

func TestGetSeverityLabel_Boundary3_9(t *testing.T) {
	// 3.9 → LOW
	got := GetSeverityLabel(3.9)
	if got != "[LOW]" {
		t.Errorf("GetSeverityLabel(3.9) = %q, want [LOW]", got)
	}
}

func TestGetSeverityLabel_Negative(t *testing.T) {
	// 負の値 → LOW
	got := GetSeverityLabel(-1.0)
	if got != "[LOW]" {
		t.Errorf("GetSeverityLabel(-1.0) = %q, want [LOW]", got)
	}
}

func TestGetSeverityLabel_VeryHigh(t *testing.T) {
	// 100.0 → CRITICAL
	got := GetSeverityLabel(100.0)
	if got != "[CRITICAL]" {
		t.Errorf("GetSeverityLabel(100.0) = %q, want [CRITICAL]", got)
	}
}

// ── BuildMessage 空フィールド・エッジケース ───────────────────────

func TestBuildMessage_EmptyTitle(t *testing.T) {
	detail := makeDetail(7.0, "", "説明文", "Type", "ap-northeast-1", "123456789012", "id-001")
	subject, _ := BuildMessage(detail)

	// タイトルが空でも [HIGH] ラベルは入る
	if !strings.Contains(subject, "[HIGH]") {
		t.Errorf("subject should contain [HIGH] even with empty title: %q", subject)
	}
}

func TestBuildMessage_EmptyDescription(t *testing.T) {
	detail := makeDetail(5.0, "Title", "", "Type", "ap-northeast-1", "123", "id")
	_, message := BuildMessage(detail)

	// 説明フィールド自体は存在する
	if !strings.Contains(message, "説明:") {
		t.Errorf("message should contain 説明: section even with empty description")
	}
}

func TestBuildMessage_EmptyRegion(t *testing.T) {
	detail := makeDetail(5.0, "Title", "Desc", "Type", "", "123", "id")
	_, message := BuildMessage(detail)

	// リージョンが空でも本文は生成される
	if message == "" {
		t.Error("message should not be empty even with empty region")
	}
}

func TestBuildMessage_EmptyAccountID(t *testing.T) {
	detail := makeDetail(5.0, "Title", "Desc", "Type", "ap-northeast-1", "", "id")
	_, message := BuildMessage(detail)

	// アカウントフィールド自体は存在する
	if !strings.Contains(message, "アカウント") {
		t.Errorf("message should contain アカウント field")
	}
}

func TestBuildMessage_SubjectPrefixFormat(t *testing.T) {
	detail := makeDetail(9.0, "Backdoor:EC2/XORDDOS", "説明", "Backdoor", "ap-northeast-1", "123", "id")
	subject, _ := BuildMessage(detail)

	if !strings.HasPrefix(subject, "[GuardDuty]") {
		t.Errorf("subject should start with [GuardDuty]: %q", subject)
	}
}

func TestBuildMessage_ConsoleURLFormat(t *testing.T) {
	detail := makeDetail(5.0, "Title", "Desc", "Type", "us-west-2", "123", "finding-999")
	_, message := BuildMessage(detail)

	// コンソール URL のフォーマット確認
	if !strings.Contains(message, "us-west-2.console.aws.amazon.com") {
		t.Errorf("message should contain us-west-2 console URL")
	}
	if !strings.Contains(message, "finding-999") {
		t.Errorf("message should contain finding-999 in URL")
	}
}

func TestBuildMessage_SeparatorIsDashes(t *testing.T) {
	detail := makeDetail(5.0, "Title", "Desc", "Type", "ap-northeast-1", "123", "id")
	_, message := BuildMessage(detail)

	// 区切り線が含まれる（─ 50個）
	if !strings.Contains(message, strings.Repeat("─", 50)) {
		t.Errorf("message should contain ─ separator line")
	}
}

// ── HandleRequest 追加パターン ────────────────────────────────────

func TestHandleRequest_SNS_ARN_Empty(t *testing.T) {
	// SNS_TOPIC_ARN が未設定でも detail が空でなければ Publish を試みる
	mock := &mockSNS{}
	snsClient = mock
	t.Setenv("SNS_TOPIC_ARN", "")

	detail := makeDetail(7.0, "Title", "Desc", "Type", "ap-northeast-1", "123", "id")
	_, err := HandleRequest(context.Background(), makeEvent(detail))

	// ARN が空でも Publish は呼ばれる（エラーなし or SNS エラー）
	// ここでは error が nil かどうかを確認（mockSNS は常に成功）
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestHandleRequest_MultipleFields_InSNSMessage(t *testing.T) {
	mock := &mockSNS{}
	snsClient = mock
	t.Setenv("SNS_TOPIC_ARN", "arn:aws:sns:ap-northeast-1:123:topic")

	detail := makeDetail(8.0, "Policy:IAMUser/RootCredentialUsage", "ルートアカウントが使用されました", "Policy", "ap-northeast-1", "111222333444", "root-find-001")
	HandleRequest(context.Background(), makeEvent(detail))

	msg := *mock.publishedInput.Message
	for _, want := range []string{"111222333444", "root-find-001", "Policy:IAMUser/RootCredentialUsage"} {
		if !strings.Contains(msg, want) {
			t.Errorf("SNS message should contain %q", want)
		}
	}
}

func TestHandleRequest_SubjectNeverExceedsLimit(t *testing.T) {
	mock := &mockSNS{}
	snsClient = mock
	t.Setenv("SNS_TOPIC_ARN", "arn:aws:sns:ap-northeast-1:123:topic")

	// 極端に長いタイトル
	longTitle := strings.Repeat("あ", 500)
	detail := makeDetail(9.5, longTitle, "Desc", "Type", "ap-northeast-1", "123", "id")
	HandleRequest(context.Background(), makeEvent(detail))

	subject := *mock.publishedInput.Subject
	if len([]rune(subject)) > 100 {
		t.Errorf("SNS subject must not exceed 100 runes, got %d", len([]rune(subject)))
	}
}

func TestHandleRequest_NilDetail_Returns400(t *testing.T) {
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

func TestHandleRequest_HighSeveritySubjectContainsHIGH(t *testing.T) {
	mock := &mockSNS{}
	snsClient = mock
	t.Setenv("SNS_TOPIC_ARN", "arn:aws:sns:ap-northeast-1:123:topic")

	detail := makeDetail(7.5, "Recon:EC2/PortProbeUnprotectedPort", "説明", "Recon", "ap-northeast-1", "123", "id")
	HandleRequest(context.Background(), makeEvent(detail))

	if !strings.Contains(*mock.publishedInput.Subject, "[HIGH]") {
		t.Errorf("subject should contain [HIGH] for severity 7.5: %s", *mock.publishedInput.Subject)
	}
}

// ── ベンチマーク ─────────────────────────────────────────────────

func BenchmarkGetSeverityLabel(b *testing.B) {
	for i := 0; i < b.N; i++ {
		GetSeverityLabel(7.5)
	}
}

func BenchmarkBuildMessage(b *testing.B) {
	detail := makeDetail(7.0, "Recon:IAMUser/MaliciousIPCaller", "不審なIPから呼び出し", "Recon", "ap-northeast-1", "123456789012", "find-bench-001")
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		BuildMessage(detail)
	}
}

func BenchmarkTruncate(b *testing.B) {
	s := strings.Repeat("あ", 200)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		truncate(s, 60)
	}
}

/*
GuardDuty Finding Notifier（Go 版）

EventBridge 経由で受け取った GuardDuty Finding を整形して SNS へ通知する。
Python 版（lambda/guardduty-notifier/index.py）と同じロジックを Go で実装した並置実装。

アーキテクチャ:

	GuardDuty → EventBridge Rule (severity >= 4.0) → Lambda → SNS → Email
*/
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sns"
)

// ── 型定義 ──────────────────────────────────────────────────────

// GuardDutyEvent は EventBridge から受け取る GuardDuty イベント。
type GuardDutyEvent struct {
	Detail map[string]interface{} `json:"detail"`
}

// Response はハンドラーの戻り値。
type Response struct {
	StatusCode int    `json:"statusCode"`
	Body       string `json:"body"`
}

// ── SNS クライアント（テスト時はモックに差し替え可能） ─────────

// SNSPublisher は SNS への Publish 操作を抽象化するインターフェース。
type SNSPublisher interface {
	Publish(ctx context.Context, params *sns.PublishInput, optFns ...func(*sns.Options)) (*sns.PublishOutput, error)
}

var snsClient SNSPublisher

// ── リトライ実行器 ───────────────────────────────────────────────
// SNS のスロットリング（ThrottledException）等に指数バックオフ +
// フルジッターで自動リトライする（retry.go を参照）
var retrier = NewRetrier()

func init() {
	cfg, err := config.LoadDefaultConfig(context.Background())
	if err != nil {
		log.Fatalf("failed to load AWS config: %v", err)
	}
	snsClient = sns.NewFromConfig(cfg)
}

// ── 重大度ラベル ─────────────────────────────────────────────────

// GetSeverityLabel は GuardDuty の数値重大度を日本語ラベルに変換する。
func GetSeverityLabel(severity float64) string {
	switch {
	case severity >= 9.0:
		return "[CRITICAL]"
	case severity >= 7.0:
		return "[HIGH]"
	case severity >= 4.0:
		return "[MEDIUM]"
	default:
		return "[LOW]"
	}
}

// ── メッセージ整形 ───────────────────────────────────────────────

// getString は map から文字列を安全に取り出す。
func getString(m map[string]interface{}, key string) string {
	if v, ok := m[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// getFloat64 は map から float64 を安全に取り出す。
func getFloat64(m map[string]interface{}, key string) float64 {
	if v, ok := m[key]; ok {
		switch n := v.(type) {
		case float64:
			return n
		case int:
			return float64(n)
		}
	}
	return 0.0
}

// truncate は文字列を最大 n 文字に切り詰める。
func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// BuildMessage は GuardDuty Finding detail から SNS の件名と本文を生成する。
func BuildMessage(detail map[string]interface{}) (subject, message string) {
	severity := getFloat64(detail, "severity")
	title := getString(detail, "title")
	description := getString(detail, "description")
	findingType := getString(detail, "type")
	region := getString(detail, "region")
	accountID := getString(detail, "accountId")
	findingID := getString(detail, "id")

	severityLabel := GetSeverityLabel(severity)
	subject = fmt.Sprintf("[GuardDuty] %s %s", severityLabel, truncate(title, 60))

	consoleURL := fmt.Sprintf(
		"https://%s.console.aws.amazon.com/guardduty/home?region=%s#/findings?macros=current&fId=%s",
		region, region, findingID,
	)

	lines := []string{
		"GuardDuty セキュリティアラート",
		strings.Repeat("=", 50),
		"",
		fmt.Sprintf("重大度  : %.1f %s", severity, severityLabel),
		fmt.Sprintf("タイプ  : %s", findingType),
		fmt.Sprintf("タイトル: %s", title),
		"",
		"説明:",
		fmt.Sprintf("  %s", description),
		"",
		strings.Repeat("─", 50),
		fmt.Sprintf("リージョン  : %s", region),
		fmt.Sprintf("アカウント  : %s", accountID),
		fmt.Sprintf("Finding ID  : %s", findingID),
		"",
		"コンソールで確認:",
		fmt.Sprintf("  %s", consoleURL),
		"",
		"-- 自動通知: terraform-aws-operations / guardduty-notifier（Go版）",
	}
	message = strings.Join(lines, "\n")
	return subject, message
}

// ── ハンドラー ───────────────────────────────────────────────────

// HandleRequest は EventBridge から GuardDuty Finding を受け取り SNS へ通知する。
func HandleRequest(ctx context.Context, event GuardDutyEvent) (Response, error) {
	snsTopicARN := os.Getenv("SNS_TOPIC_ARN")

	detail := event.Detail
	if len(detail) == 0 {
		log.Println("Empty detail in event. Skipping.")
		return Response{StatusCode: 400, Body: "Empty detail"}, nil
	}

	subject, message := BuildMessage(detail)

	// SNS 件名は 100 文字制限
	subjectStr := truncate(subject, 100)

	out, err := RetryValue(ctx, retrier, "Publish", func(c context.Context) (*sns.PublishOutput, error) {
		return snsClient.Publish(c, &sns.PublishInput{
			TopicArn: aws.String(snsTopicARN),
			Subject:  aws.String(subjectStr),
			Message:  aws.String(message),
		})
	})
	if err != nil {
		return Response{}, fmt.Errorf("SNS publish failed: %w", err)
	}

	log.Printf("SNS publish succeeded. MessageId=%s severity=%.1f title=%s",
		aws.ToString(out.MessageId),
		getFloat64(detail, "severity"),
		getString(detail, "title"),
	)

	return Response{StatusCode: 200, Body: "Notification sent"}, nil
}

func main() {
	lambda.Start(HandleRequest)
}

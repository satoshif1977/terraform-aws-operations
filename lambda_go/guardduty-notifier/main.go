/*
GuardDuty Finding Notifier（Go 版）

EventBridge 経由で受け取った GuardDuty Finding を整形して SNS へ通知する。
Python 版（lambda/guardduty-notifier/index.py）と同じロジックを Go で実装した並置実装。

アーキテクチャ:

	GuardDuty → EventBridge Rule (severity >= 4.0) → Lambda → SNS → Email

ログとメトリクスは同ディレクトリの logger.go / metrics.go に寄せてある。
標準 log を直接呼ばないのは、GuardDuty の検知内容がそのまま CloudWatch Logs に
流れるため、logger.go のマスキング（sensitiveKeyPatterns）を必ず通したいから。
*/
package main

import (
	"context"
	"fmt"
	"log"
	"log/slog"
	"os"
	"strings"
	"time"

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

// ── ログ・メトリクスの設定 ───────────────────────────────────────

const (
	// DefaultMetricsNamespace は METRICS_NAMESPACE 未設定時に使う名前空間。
	DefaultMetricsNamespace = "TerraformAwsOperations/GuarddutyNotifier"
	// RetryOperation はリトライ層へ渡す操作名。ログとメトリクスで同じ値を使う。
	RetryOperation = "Publish"
	// handlerDimension は全メトリクスに付与するディメンション値。
	handlerDimension = "guardduty-notifier"
)

// テストから差し替えるための生成関数（snsClient と同じ流儀）。
var (
	newHandlerLogger  = func() *slog.Logger { return NewLoggerFromEnv(LoggerOptions{}) }
	newHandlerMetrics = newMetrics
)

// newMetrics は環境変数を見てメトリクスを組み立てる。
//
// 名前空間が不正でも本処理は止めない。メトリクスは副次処理であり、
// 通知そのものを落とすほうが害が大きいため、既定値へ倒して継続する。
func newMetrics(logger *slog.Logger) *Metrics {
	dims := map[string]string{"Handler": handlerDimension}

	ns := strings.TrimSpace(os.Getenv("METRICS_NAMESPACE"))
	if ns == "" {
		ns = DefaultMetricsNamespace
	}
	if m, err := NewMetrics(MetricsOptions{Namespace: ns, Dimensions: dims}); err == nil {
		return m
	} else {
		logger.Warn("METRICS_NAMESPACE が不正です。既定の名前空間で初期化します",
			"namespace", ns, "error", err)
	}

	// DefaultMetricsNamespace と dims は定数なので、ここで失敗することはない。
	// その不変条件は TestNewMetrics_既定の名前空間なら必ず生成できる で固定している。
	m, _ := NewMetrics(MetricsOptions{Namespace: DefaultMetricsNamespace, Dimensions: dims})
	return m
}

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
	logger := newHandlerLogger()
	// メトリクスは 1 回の起動で 1 ドキュメントにまとめるため、呼び出しごとに作る。
	metrics := newHandlerMetrics(logger)
	defer func() {
		// EMF は標準出力へ 1 行書くだけ。ここでの失敗で通知の成否は変えない。
		if err := metrics.Flush(); err != nil {
			logger.Warn("メトリクスの出力に失敗しました", "error", err)
		}
	}()

	snsTopicARN := os.Getenv("SNS_TOPIC_ARN")

	detail := event.Detail
	if len(detail) == 0 {
		logger.Warn("detail が空のイベントを受信しました。処理をスキップします")
		_ = metrics.Count("EmptyDetail", 1)
		return Response{StatusCode: 400, Body: "Empty detail"}, nil
	}

	// finding 単位の情報を子ロガーへ持たせて、以降のログすべてに載せる。
	findingLogger := logger.With(
		"findingId", getString(detail, "id"),
		"severity", getFloat64(detail, "severity"),
	)

	subject, message := BuildMessage(detail)

	// SNS 件名は 100 文字制限
	subjectStr := truncate(subject, 100)

	// リトライ層へフックを差し込む。Retrier は値型なので呼び出しごとにコピーする
	// （パッケージ変数を書き換えると同時実行で干渉するため）。
	r := retrier
	logHook := RetryLogHook(findingLogger, RetryOperation)
	metricsHook := RetryMetricsHook(metrics, RetryOperation)
	r.OnRetry = func(attempt int, delay time.Duration, err error) {
		logHook(attempt, delay, err)
		metricsHook(attempt, delay, err)
	}

	stopTimer := metrics.Timer("PublishLatency")
	out, err := RetryValue(ctx, r, RetryOperation, func(c context.Context) (*sns.PublishOutput, error) {
		return snsClient.Publish(c, &sns.PublishInput{
			TopicArn: aws.String(snsTopicARN),
			Subject:  aws.String(subjectStr),
			Message:  aws.String(message),
		})
	})
	_ = stopTimer()
	if err != nil {
		findingLogger.Error("SNS への通知に失敗しました", "error", err)
		_ = metrics.Count("NotificationError", 1)
		return Response{}, fmt.Errorf("SNS publish failed: %w", err)
	}

	findingLogger.Info("SNS への通知に成功しました",
		"messageId", aws.ToString(out.MessageId),
		"title", getString(detail, "title"),
	)
	_ = metrics.Count("NotificationSuccess", 1)

	return Response{StatusCode: 200, Body: "Notification sent"}, nil
}

func main() {
	lambda.Start(HandleRequest)
}

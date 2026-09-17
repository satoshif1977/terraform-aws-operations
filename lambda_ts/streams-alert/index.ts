// terraform-aws-operations: TypeScript 実装（Python 版 streams-alert との並置）
//
// Python 版との比較ポイント:
//   - 型安全: DynamoDB AttributeValue を Union 型で厳密に定義
//   - SNSClient を依存注入（DI）することでユニットテストが容易
//   - 処理対象イベントを Set<string> で定義し switch より可読性を向上
//   - 同一ロジック・同一出力フォーマットで Python と動作を揃える
//
// ログとメトリクスは同ディレクトリの logger.ts / metrics.ts に寄せてある。
// console を直接呼ばないのは、GuardDuty の検知内容がそのまま CloudWatch Logs に
// 流れるため、logger.ts のマスキング（SENSITIVE_KEY_PATTERNS）を必ず通したいから。

import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import type { DynamoDBRecord, HandlerResult, ProcessResult } from './types';
import { PROCESSABLE_EVENTS, extractDynamoValue, getSeverityLabel, buildMessage } from './helpers';
import { retryAsync } from './retry';
import type { RetryConfig, RetryOptions } from './retry';
import { createLoggerFromEnv, retryLogger } from './logger';
import type { Logger } from './logger';
import { createMetrics, retryMetrics } from './metrics';
import type { Metrics } from './metrics';

// ヘルパー関数を re-export（テストファイルが "./index" から import しているため）
export { extractDynamoValue, getSeverityLabel, buildMessage };

// ── リトライ設定 ──────────────────────────────────────────────

/**
 * SNS Publish に適用するリトライ設定。
 *
 * 同リポジトリの Go 版（lambda_go/guardduty-notifier/retry.go）の既定値と揃えてある。
 * 共通モジュール retry.ts の既定値（500ms / 8s）より短くしているのは、
 * DynamoDB Streams のハンドラーが 1 回の起動で複数レコードを直列に処理するため、
 * 1 レコードあたりの待機がバッチ全体のタイムアウトに直接効いてくるから。
 */
export const SNS_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 4,
  baseDelayMs: 100,
  maxDelayMs: 5000,
  jitter: true,
};

// ── メトリクス設定 ────────────────────────────────────────────

/** メトリクスの既定の名前空間。METRICS_NAMESPACE で上書きできる */
export const DEFAULT_METRICS_NAMESPACE = 'TerraformAwsOperations/StreamsAlert';

/** リトライ層に渡す操作名。ログとメトリクスで同じ値を使う */
export const RETRY_OPERATION = 'sns:Publish';

// ── 依存の注入 ────────────────────────────────────────────────

/**
 * ハンドラーが使う副次機能。テストから固定の sink を渡して出力を検証できる。
 *
 * 省略した場合は環境変数からロガーを、既定の名前空間でメトリクスを組み立てる。
 */
export interface HandlerDeps {
  logger?: Logger;
  metrics?: Metrics;
}

// ── ハンドラーファクトリ（DI 対応） ──────────────────────────

/**
 * SNS クライアントを受け取りハンドラー関数を返す。
 * テスト時はモック SNS クライアントを渡すことで AWS 接続なしで検証できる。
 *
 * retryOptions は sleep / rand を差し替えるために公開している。
 * テストから即時解決する sleep を渡せば、実待機ゼロでリトライ挙動を検証できる。
 */
export const createHandler = (
  sns: SNSClient = new SNSClient({}),
  retryOptions: RetryOptions = {},
  deps: HandlerDeps = {},
) =>
  async (event: DynamoDBRecord[] | DynamoDBRecord): Promise<HandlerResult> => {
    const logger = deps.logger ?? createLoggerFromEnv();
    // メトリクスは 1 回の起動で 1 ドキュメントにまとめるため、呼び出しごとに作る
    const metrics =
      deps.metrics ??
      createMetrics({
        namespace: process.env['METRICS_NAMESPACE'] ?? DEFAULT_METRICS_NAMESPACE,
        dimensions: { Handler: 'streams-alert' },
      });

    const records: DynamoDBRecord[] = Array.isArray(event) ? event : [event];
    logger.info('streams-alert handler 起動', { recordCount: records.length });
    metrics.count('RecordsReceived', records.length);

    const processed: ProcessResult[] = [];
    const skipped: ProcessResult[] = [];
    const errors: ProcessResult[] = [];

    for (const record of records) {
      const eventName = record.eventName ?? '';
      const newImage = record.dynamodb?.NewImage;

      if (!PROCESSABLE_EVENTS.has(eventName)) {
        logger.info('対象外イベントをスキップ', { eventName, reason: 'non-target event' });
        metrics.count('RecordSkipped');
        skipped.push({ eventName, status: 'skipped', reason: 'non-target event' });
        continue;
      }

      if (!newImage || Object.keys(newImage).length === 0) {
        logger.warn('NewImage が空のレコードをスキップ', { eventName, reason: 'empty NewImage' });
        metrics.count('RecordSkipped');
        skipped.push({ eventName, status: 'skipped', reason: 'empty NewImage' });
        continue;
      }

      const incidentId = extractDynamoValue(newImage['incident_id']) || 'UNKNOWN';
      const severity = extractDynamoValue(newImage['severity']) || 'UNKNOWN';
      // incidentId / severity を子ロガーに持たせて、以降のログすべてに載せる
      const recordLogger = logger.child({ incidentId, severity });

      const logRetry = retryLogger(recordLogger, RETRY_OPERATION);
      const countRetry = retryMetrics(metrics, RETRY_OPERATION);

      const stopTimer = metrics.timer('PublishLatency');
      try {
        const { subject, body } = buildMessage(newImage);
        // スロットリングや一時的な 5xx は指数バックオフで再試行する。
        // 通知が 1 回の失敗で落ちると、GuardDuty の検知が誰にも届かないまま終わる。
        const res = await retryAsync(
          () =>
            sns.send(
              new PublishCommand({
                TopicArn: process.env['SNS_TOPIC_ARN'],
                Subject: subject.slice(0, 100),
                Message: body,
              }),
            ),
          {
            config: SNS_RETRY_CONFIG,
            ...retryOptions,
            onRetry: (attempt, delayMs, error) => {
              logRetry(attempt, delayMs, error);
              countRetry(attempt, delayMs, error);
              retryOptions.onRetry?.(attempt, delayMs, error);
            },
          },
        );
        stopTimer();
        recordLogger.info('SNS 通知成功', { messageId: res.MessageId });
        metrics.count('NotificationSuccess');
        processed.push({ incident_id: incidentId, severity, status: 'success', message_id: res.MessageId });
      } catch (err) {
        stopTimer();
        recordLogger.error('SNS 通知エラー', { error: err });
        metrics.count('NotificationError');
        errors.push({ incident_id: incidentId, severity, status: 'error', reason: String(err) });
      }
    }

    logger.info('処理完了', {
      processed: processed.length,
      skipped: skipped.length,
      errors: errors.length,
    });
    // EMF は 1 行の JSON を標準出力に書くだけなので、ここでの失敗は本処理に影響しない
    metrics.flush();

    return { processed, skipped, errors };
  };

// ── Lambda エントリーポイント ─────────────────────────────────
export const handler = createHandler();

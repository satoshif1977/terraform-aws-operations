// terraform-aws-operations: TypeScript 実装（Python 版 streams-alert との並置）
//
// Python 版との比較ポイント:
//   - 型安全: DynamoDB AttributeValue を Union 型で厳密に定義
//   - SNSClient を依存注入（DI）することでユニットテストが容易
//   - 処理対象イベントを Set<string> で定義し switch より可読性を向上
//   - 同一ロジック・同一出力フォーマットで Python と動作を揃える

import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import type { DynamoDBRecord, HandlerResult, ProcessResult } from './types';
import { PROCESSABLE_EVENTS, extractDynamoValue, getSeverityLabel, buildMessage } from './helpers';
import { retryAsync } from './retry';
import type { RetryConfig, RetryOptions } from './retry';

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
) =>
  async (event: DynamoDBRecord[] | DynamoDBRecord): Promise<HandlerResult> => {
    const records: DynamoDBRecord[] = Array.isArray(event) ? event : [event];
    console.log(`streams-alert handler 起動: ${records.length} レコード`);

    const processed: ProcessResult[] = [];
    const skipped: ProcessResult[] = [];
    const errors: ProcessResult[] = [];

    for (const record of records) {
      const eventName = record.eventName ?? '';
      const newImage = record.dynamodb?.NewImage;

      if (!PROCESSABLE_EVENTS.has(eventName)) {
        console.log(`eventName=${eventName} をスキップ（対象外）`);
        skipped.push({ eventName, status: 'skipped', reason: 'non-target event' });
        continue;
      }

      if (!newImage || Object.keys(newImage).length === 0) {
        console.warn(`NewImage が空のレコードをスキップ: eventName=${eventName}`);
        skipped.push({ eventName, status: 'skipped', reason: 'empty NewImage' });
        continue;
      }

      const incidentId = extractDynamoValue(newImage['incident_id']) || 'UNKNOWN';
      const severity = extractDynamoValue(newImage['severity']) || 'UNKNOWN';

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
              console.warn(
                `SNS 通知をリトライします: incident_id=${incidentId} attempt=${attempt} delayMs=${Math.round(delayMs)} error=${error}`,
              );
              retryOptions.onRetry?.(attempt, delayMs, error);
            },
          },
        );
        console.log(`SNS 通知成功: incident_id=${incidentId} severity=${severity} MessageId=${res.MessageId}`);
        processed.push({ incident_id: incidentId, severity, status: 'success', message_id: res.MessageId });
      } catch (err) {
        console.error(`SNS 通知エラー: incident_id=${incidentId} error=${err}`);
        errors.push({ incident_id: incidentId, severity, status: 'error', reason: String(err) });
      }
    }

    console.log(`処理完了: 成功=${processed.length} / スキップ=${skipped.length} / エラー=${errors.length}`);
    return { processed, skipped, errors };
  };

// ── Lambda エントリーポイント ─────────────────────────────────
export const handler = createHandler();

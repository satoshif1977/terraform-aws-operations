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

// ヘルパー関数を re-export（テストファイルが "./index" から import しているため）
export { extractDynamoValue, getSeverityLabel, buildMessage };

// ── ハンドラーファクトリ（DI 対応） ──────────────────────────

/**
 * SNS クライアントを受け取りハンドラー関数を返す。
 * テスト時はモック SNS クライアントを渡すことで AWS 接続なしで検証できる。
 */
export const createHandler = (sns: SNSClient = new SNSClient({})) =>
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
        const res = await sns.send(
          new PublishCommand({
            TopicArn: process.env['SNS_TOPIC_ARN'],
            Subject: subject.slice(0, 100),
            Message: body,
          }),
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

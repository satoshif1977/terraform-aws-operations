// terraform-aws-operations: TypeScript 実装（Python 版 streams-alert との並置）
//
// Python 版との比較ポイント:
//   - 型安全: DynamoDB AttributeValue を Union 型で厳密に定義
//   - SNSClient を依存注入（DI）することでユニットテストが容易
//   - 処理対象イベントを Set<string> で定義し switch より可読性を向上
//   - 同一ロジック・同一出力フォーマットで Python と動作を揃える

import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import type {
  DynamoDBAttributeValue,
  DynamoDBNewImage,
  DynamoDBRecord,
  HandlerResult,
  ProcessResult,
} from './types';

// ── 処理対象イベント ──────────────────────────────────────────
const PROCESSABLE_EVENTS = new Set(['INSERT', 'MODIFY']);

// ── 重大度ラベル ──────────────────────────────────────────────
const SEVERITY_LABEL: Record<string, string> = {
  CRITICAL: '[CRITICAL]',
  HIGH: '[HIGH]',
  MEDIUM: '[MEDIUM]',
  LOW: '[LOW]',
};

// ── ヘルパー ──────────────────────────────────────────────────

/** DynamoDB AttributeValue（{"S":"..."} 形式）から文字列値を取り出す */
export const extractDynamoValue = (attr: DynamoDBAttributeValue | undefined): string => {
  if (!attr) return '';
  if ('S' in attr) return attr.S;
  if ('N' in attr) return attr.N;
  if ('BOOL' in attr) return String(attr.BOOL);
  return '';
};

/** 重大度文字列を SNS 件名用ラベルに変換する */
export const getSeverityLabel = (severity: string): string =>
  SEVERITY_LABEL[severity] ?? `[${severity}]`;

/** DynamoDB NewImage から SNS の件名と本文を生成する */
export const buildMessage = (newImage: DynamoDBNewImage): { subject: string; body: string } => {
  const incidentId = extractDynamoValue(newImage['incident_id']) || 'UNKNOWN';
  const timestamp = extractDynamoValue(newImage['timestamp']) || 'UNKNOWN';
  const severity = extractDynamoValue(newImage['severity']) || 'UNKNOWN';
  const status = extractDynamoValue(newImage['status']) || 'UNKNOWN';
  const message = extractDynamoValue(newImage['message']) || '（詳細なし）';
  const resource = extractDynamoValue(newImage['resource']) || '（不明）';

  const label = getSeverityLabel(severity);
  const subject = `[インシデント] ${label} ${incidentId}`.slice(0, 100);

  const body = [
    'インシデントアラート',
    '='.repeat(50),
    '',
    `インシデントID: ${incidentId}`,
    `重大度        : ${severity} ${label}`,
    `ステータス    : ${status}`,
    `発生時刻      : ${timestamp}`,
    '',
    '対象リソース:',
    `  ${resource}`,
    '',
    '詳細:',
    `  ${message}`,
    '',
    '─'.repeat(50),
    '-- 自動通知: terraform-aws-operations / streams-alert',
  ].join('\n');

  return { subject, body };
};

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

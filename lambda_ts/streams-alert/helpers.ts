/**
 * streams-alert ヘルパー関数・定数
 *
 * DynamoDB AttributeValue の値抽出・重大度ラベル変換・SNS メッセージ生成を担当する。
 * ハンドラー（index.ts）から分離し、単体テストの対象を明確にする。
 */

import type { DynamoDBAttributeValue, DynamoDBNewImage } from './types';

// ── 定数 ─────────────────────────────────────────────────────────

/** 処理対象の DynamoDB Streams イベント名 */
export const PROCESSABLE_EVENTS = new Set(['INSERT', 'MODIFY']);

/** 重大度 → SNS 件名用ラベル */
const SEVERITY_LABEL: Record<string, string> = {
  CRITICAL: '[CRITICAL]',
  HIGH: '[HIGH]',
  MEDIUM: '[MEDIUM]',
  LOW: '[LOW]',
};

// ── ヘルパー関数 ─────────────────────────────────────────────────

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

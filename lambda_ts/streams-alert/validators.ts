/**
 * DynamoDB Streams インシデントアラート バリデーター
 *
 * DynamoDB Streams レコード・インシデントフィールド・SNS メッセージ制約を
 * 検証する純粋関数群。AWS SDK に依存しないため単体テストが容易。
 *
 * 検証内容:
 *   - DynamoDB Streams レコード構造（eventName / dynamodb / NewImage）
 *   - DynamoDB AttributeValue の型チェック
 *   - インシデント必須フィールド（incident_id / severity / timestamp / status / message）
 *   - 重大度（severity）の有効値チェック
 *   - タイムスタンプ形式の妥当性
 *   - SNS メッセージ制約（件名バイト長・本文サイズ上限）
 *   - HandlerResult の整合性チェック
 */

import type {
  DynamoDBAttributeValue,
  DynamoDBNewImage,
  DynamoDBRecord,
  ProcessResult,
  HandlerResult,
} from "./types";

// ── 型定義 ────────────────────────────────────────────────────

export interface ValidationError {
  field: string;
  message: string;
  severity: "error" | "warning";
}

// ── 定数 ─────────────────────────────────────────────────────

/** 処理対象の DynamoDB Streams イベント名 */
export const PROCESSABLE_EVENT_NAMES = ["INSERT", "MODIFY"] as const;

/** 無視される DynamoDB Streams イベント名 */
export const IGNORED_EVENT_NAMES = ["REMOVE"] as const;

/** 有効な重大度 */
export const VALID_SEVERITIES = [
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
] as const;

/** 有効なインシデントステータス */
export const VALID_INCIDENT_STATUSES = [
  "OPEN",
  "ACKNOWLEDGED",
  "RESOLVED",
  "CLOSED",
] as const;

/** 有効な ProcessResult ステータス */
export const VALID_PROCESS_STATUSES = [
  "success",
  "skipped",
  "error",
] as const;

/** インシデントレコードの必須フィールド */
export const REQUIRED_INCIDENT_FIELDS = [
  "incident_id",
  "severity",
  "timestamp",
  "status",
  "message",
] as const;

/** インシデントレコードの推奨フィールド */
export const RECOMMENDED_INCIDENT_FIELDS = ["resource"] as const;

/** SNS 件名の最大バイト長（UTF-8） */
export const MAX_SNS_SUBJECT_BYTES = 100;

/** SNS 本文の最大サイズ（256 KB） */
export const MAX_SNS_MESSAGE_BYTES = 256 * 1024;

/** ISO 8601 日時パターン（基本形式） */
export const ISO8601_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/** incident_id のパターン（英数字・ハイフン・アンダースコア） */
export const INCIDENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

// ── DynamoDB AttributeValue バリデーション ────────────────────

/** AttributeValue が有効な DynamoDB 型か */
export function isValidAttributeValue(
  value: unknown
): value is DynamoDBAttributeValue {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if ("S" in obj && typeof obj.S === "string") return true;
  if ("N" in obj && typeof obj.N === "string") return true;
  if ("BOOL" in obj && typeof obj.BOOL === "boolean") return true;
  if ("NULL" in obj && obj.NULL === true) return true;
  return false;
}

/** AttributeValue から文字列値を安全に取得する */
export function safeExtractString(
  attr: DynamoDBAttributeValue | undefined
): string {
  if (!attr) return "";
  if ("S" in attr) return attr.S;
  if ("N" in attr) return attr.N;
  if ("BOOL" in attr) return String(attr.BOOL);
  return "";
}

/** NewImage の指定フィールドが存在し空でないか */
export function hasNonEmptyField(
  newImage: DynamoDBNewImage,
  field: string
): boolean {
  const attr = newImage[field];
  if (!attr) return false;
  return safeExtractString(attr).length > 0;
}

// ── DynamoDB Streams レコードバリデーション ───────────────────

/** eventName が処理対象か */
export function isProcessableEvent(eventName: string): boolean {
  return (PROCESSABLE_EVENT_NAMES as readonly string[]).includes(eventName);
}

/** eventName が既知のイベント名か */
export function isKnownEventName(eventName: string): boolean {
  const all = [
    ...PROCESSABLE_EVENT_NAMES,
    ...IGNORED_EVENT_NAMES,
  ] as readonly string[];
  return all.includes(eventName);
}

/** DynamoDB Streams レコードを検証する */
export function validateDynamoDBRecord(
  record: DynamoDBRecord,
  index: number
): ValidationError[] {
  const errors: ValidationError[] = [];
  const prefix = `records[${index}]`;

  // eventName チェック
  if (!record.eventName) {
    errors.push({
      field: `${prefix}.eventName`,
      message: "eventName が未定義です",
      severity: "error",
    });
  } else if (!isKnownEventName(record.eventName)) {
    errors.push({
      field: `${prefix}.eventName`,
      message: `未知の eventName: "${record.eventName}"`,
      severity: "warning",
    });
  }

  // dynamodb チェック
  if (!record.dynamodb) {
    errors.push({
      field: `${prefix}.dynamodb`,
      message: "dynamodb フィールドが未定義です",
      severity: "error",
    });
    return errors;
  }

  // REMOVE イベントの場合は NewImage 不要
  if (record.eventName === "REMOVE") {
    return errors;
  }

  // INSERT/MODIFY の場合は NewImage 必須
  if (isProcessableEvent(record.eventName ?? "")) {
    if (!record.dynamodb.NewImage) {
      errors.push({
        field: `${prefix}.dynamodb.NewImage`,
        message: `${record.eventName} イベントに NewImage がありません`,
        severity: "error",
      });
    } else if (Object.keys(record.dynamodb.NewImage).length === 0) {
      errors.push({
        field: `${prefix}.dynamodb.NewImage`,
        message: "NewImage が空オブジェクトです",
        severity: "warning",
      });
    }
  }

  return errors;
}

/** DynamoDB Streams レコード配列を検証する */
export function validateRecords(
  records: DynamoDBRecord[]
): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!Array.isArray(records)) {
    errors.push({
      field: "records",
      message: "records が配列ではありません",
      severity: "error",
    });
    return errors;
  }

  if (records.length === 0) {
    errors.push({
      field: "records",
      message: "records 配列が空です",
      severity: "warning",
    });
    return errors;
  }

  records.forEach((record, idx) => {
    errors.push(...validateDynamoDBRecord(record, idx));
  });

  return errors;
}

// ── インシデントフィールドバリデーション ──────────────────────

/** 重大度が有効な値か */
export function isValidSeverity(severity: string): boolean {
  return (VALID_SEVERITIES as readonly string[]).includes(severity);
}

/** インシデントステータスが有効な値か */
export function isValidIncidentStatus(status: string): boolean {
  return (VALID_INCIDENT_STATUSES as readonly string[]).includes(status);
}

/** タイムスタンプが ISO 8601 形式か */
export function isValidTimestamp(timestamp: string): boolean {
  if (!ISO8601_PATTERN.test(timestamp)) return false;
  const d = new Date(timestamp);
  return !isNaN(d.getTime());
}

/** incident_id が有効なフォーマットか */
export function isValidIncidentId(id: string): boolean {
  if (!id || id.length === 0) return false;
  if (id.length > 128) return false;
  return INCIDENT_ID_PATTERN.test(id);
}

/** NewImage のインシデントフィールドを検証する */
export function validateIncidentFields(
  newImage: DynamoDBNewImage
): ValidationError[] {
  const errors: ValidationError[] = [];

  // 必須フィールドの存在チェック
  for (const field of REQUIRED_INCIDENT_FIELDS) {
    if (!hasNonEmptyField(newImage, field)) {
      errors.push({
        field: `NewImage.${field}`,
        message: `必須フィールドが欠落または空: ${field}`,
        severity: "error",
      });
    }
  }

  // 推奨フィールドの存在チェック
  for (const field of RECOMMENDED_INCIDENT_FIELDS) {
    if (!hasNonEmptyField(newImage, field)) {
      errors.push({
        field: `NewImage.${field}`,
        message: `推奨フィールドが欠落: ${field}`,
        severity: "warning",
      });
    }
  }

  // incident_id フォーマットチェック
  const incidentId = safeExtractString(newImage["incident_id"]);
  if (incidentId && !isValidIncidentId(incidentId)) {
    errors.push({
      field: "NewImage.incident_id",
      message: `incident_id のフォーマットが不正です: "${incidentId}"。英数字・ハイフン・アンダースコアのみ使用可`,
      severity: "error",
    });
  }

  // severity チェック
  const severity = safeExtractString(newImage["severity"]);
  if (severity && !isValidSeverity(severity)) {
    errors.push({
      field: "NewImage.severity",
      message: `無効な severity: "${severity}"。有効値: ${VALID_SEVERITIES.join(", ")}`,
      severity: "error",
    });
  }

  // status チェック
  const status = safeExtractString(newImage["status"]);
  if (status && !isValidIncidentStatus(status)) {
    errors.push({
      field: "NewImage.status",
      message: `無効な incident status: "${status}"。有効値: ${VALID_INCIDENT_STATUSES.join(", ")}`,
      severity: "warning",
    });
  }

  // timestamp チェック
  const timestamp = safeExtractString(newImage["timestamp"]);
  if (timestamp && !isValidTimestamp(timestamp)) {
    errors.push({
      field: "NewImage.timestamp",
      message: `タイムスタンプが ISO 8601 形式ではありません: "${timestamp}"`,
      severity: "warning",
    });
  }

  return errors;
}

// ── SNS メッセージ制約バリデーション ─────────────────────────

/** UTF-8 バイト長を計算する */
export function getUtf8ByteLength(str: string): number {
  return new TextEncoder().encode(str).length;
}

/** SNS 件名が制約内か検証する */
export function validateSnsSubject(subject: string): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!subject || subject.trim().length === 0) {
    errors.push({
      field: "subject",
      message: "SNS 件名が空です",
      severity: "error",
    });
    return errors;
  }

  const byteLen = getUtf8ByteLength(subject);
  if (byteLen > MAX_SNS_SUBJECT_BYTES) {
    errors.push({
      field: "subject",
      message: `SNS 件名が ${MAX_SNS_SUBJECT_BYTES} バイトを超えています（${byteLen} バイト）`,
      severity: "warning",
    });
  }

  return errors;
}

/** SNS 本文が制約内か検証する */
export function validateSnsMessage(message: string): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!message || message.trim().length === 0) {
    errors.push({
      field: "message",
      message: "SNS 本文が空です",
      severity: "error",
    });
    return errors;
  }

  const byteLen = getUtf8ByteLength(message);
  if (byteLen > MAX_SNS_MESSAGE_BYTES) {
    errors.push({
      field: "message",
      message: `SNS 本文が ${MAX_SNS_MESSAGE_BYTES} バイトを超えています（${byteLen} バイト）`,
      severity: "error",
    });
  }

  return errors;
}

// ── ProcessResult / HandlerResult バリデーション ─────────────

/** ProcessResult のステータスが有効か */
export function isValidProcessStatus(status: string): boolean {
  return (VALID_PROCESS_STATUSES as readonly string[]).includes(status);
}

/** ProcessResult を検証する */
export function validateProcessResult(
  result: ProcessResult,
  index: number,
  category: string
): ValidationError[] {
  const errors: ValidationError[] = [];
  const prefix = `${category}[${index}]`;

  if (!isValidProcessStatus(result.status)) {
    errors.push({
      field: `${prefix}.status`,
      message: `無効な status: "${result.status}"`,
      severity: "error",
    });
  }

  // success の場合は message_id が期待される
  if (result.status === "success" && !result.message_id) {
    errors.push({
      field: `${prefix}.message_id`,
      message: "success ステータスに message_id がありません",
      severity: "warning",
    });
  }

  // error の場合は reason が期待される
  if (result.status === "error" && !result.reason) {
    errors.push({
      field: `${prefix}.reason`,
      message: "error ステータスに reason がありません",
      severity: "warning",
    });
  }

  // skipped の場合は reason が期待される
  if (result.status === "skipped" && !result.reason) {
    errors.push({
      field: `${prefix}.reason`,
      message: "skipped ステータスに reason がありません",
      severity: "warning",
    });
  }

  return errors;
}

/** HandlerResult の整合性を検証する */
export function validateHandlerResult(
  result: HandlerResult
): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!Array.isArray(result.processed)) {
    errors.push({
      field: "processed",
      message: "processed が配列ではありません",
      severity: "error",
    });
  } else {
    result.processed.forEach((r, idx) => {
      errors.push(...validateProcessResult(r, idx, "processed"));
      if (r.status !== "success") {
        errors.push({
          field: `processed[${idx}].status`,
          message: `processed 配列に success 以外のステータスが含まれています: "${r.status}"`,
          severity: "error",
        });
      }
    });
  }

  if (!Array.isArray(result.skipped)) {
    errors.push({
      field: "skipped",
      message: "skipped が配列ではありません",
      severity: "error",
    });
  } else {
    result.skipped.forEach((r, idx) => {
      errors.push(...validateProcessResult(r, idx, "skipped"));
      if (r.status !== "skipped") {
        errors.push({
          field: `skipped[${idx}].status`,
          message: `skipped 配列に skipped 以外のステータスが含まれています: "${r.status}"`,
          severity: "error",
        });
      }
    });
  }

  if (!Array.isArray(result.errors)) {
    errors.push({
      field: "errors",
      message: "errors が配列ではありません",
      severity: "error",
    });
  } else {
    result.errors.forEach((r, idx) => {
      errors.push(...validateProcessResult(r, idx, "errors"));
      if (r.status !== "error") {
        errors.push({
          field: `errors[${idx}].status`,
          message: `errors 配列に error 以外のステータスが含まれています: "${r.status}"`,
          severity: "error",
        });
      }
    });
  }

  return errors;
}

/** 入力レコード数と出力結果数の整合性を検証する */
export function validateResultCount(
  inputCount: number,
  result: HandlerResult
): ValidationError[] {
  const errors: ValidationError[] = [];

  const totalOutput =
    (result.processed?.length ?? 0) +
    (result.skipped?.length ?? 0) +
    (result.errors?.length ?? 0);

  if (totalOutput !== inputCount) {
    errors.push({
      field: "resultCount",
      message: `入力レコード数（${inputCount}）と出力合計（${totalOutput}）が一致しません`,
      severity: "warning",
    });
  }

  return errors;
}

// ── ユーティリティ ────────────────────────────────────────────

/** エラーの有無を判定する（warning は含まない） */
export function hasErrors(errors: ValidationError[]): boolean {
  return errors.some((e) => e.severity === "error");
}

/** エラーをフォーマットする */
export function formatErrors(errors: ValidationError[]): string {
  if (errors.length === 0) return "すべてのチェックが通過しました";
  return errors
    .map((e) => `[${e.severity.toUpperCase()}] ${e.field}: ${e.message}`)
    .join("\n");
}

import {
  // 型
  type ValidationError,
  // 定数
  PROCESSABLE_EVENT_NAMES,
  IGNORED_EVENT_NAMES,
  VALID_SEVERITIES,
  VALID_INCIDENT_STATUSES,
  VALID_PROCESS_STATUSES,
  REQUIRED_INCIDENT_FIELDS,
  RECOMMENDED_INCIDENT_FIELDS,
  MAX_SNS_SUBJECT_BYTES,
  MAX_SNS_MESSAGE_BYTES,
  ISO8601_PATTERN,
  INCIDENT_ID_PATTERN,
  // AttributeValue
  isValidAttributeValue,
  safeExtractString,
  hasNonEmptyField,
  // レコード
  isProcessableEvent,
  isKnownEventName,
  validateDynamoDBRecord,
  validateRecords,
  // インシデントフィールド
  isValidSeverity,
  isValidIncidentStatus,
  isValidTimestamp,
  isValidIncidentId,
  validateIncidentFields,
  // SNS
  getUtf8ByteLength,
  validateSnsSubject,
  validateSnsMessage,
  // ProcessResult / HandlerResult
  isValidProcessStatus,
  validateProcessResult,
  validateHandlerResult,
  validateResultCount,
  // ユーティリティ
  hasErrors,
  formatErrors,
} from "./validators";

import type {
  DynamoDBNewImage,
  DynamoDBRecord,
  ProcessResult,
  HandlerResult,
} from "./types";

// ── ヘルパー ─────────────────────────────────────────────────

const mkRecord = (
  eventName: string,
  newImage?: DynamoDBNewImage
): DynamoDBRecord => ({
  eventName,
  dynamodb: { NewImage: newImage },
});

const mkIncidentImage = (
  overrides: Partial<Record<string, { S: string }>> = {}
): DynamoDBNewImage => ({
  incident_id: { S: "INC-001" },
  severity: { S: "HIGH" },
  timestamp: { S: "2026-09-01T10:00:00Z" },
  status: { S: "OPEN" },
  message: { S: "CPU使用率が90%を超えました" },
  resource: { S: "arn:aws:ec2:ap-northeast-1:123456789012:instance/i-abc123" },
  ...overrides,
});

// ── 定数テスト ───────────────────────────────────────────────

describe("定数", () => {
  test("PROCESSABLE_EVENT_NAMES に INSERT と MODIFY が含まれる", () => {
    expect(PROCESSABLE_EVENT_NAMES).toContain("INSERT");
    expect(PROCESSABLE_EVENT_NAMES).toContain("MODIFY");
  });

  test("IGNORED_EVENT_NAMES に REMOVE が含まれる", () => {
    expect(IGNORED_EVENT_NAMES).toContain("REMOVE");
  });

  test("VALID_SEVERITIES が4段階", () => {
    expect(VALID_SEVERITIES).toHaveLength(4);
    expect(VALID_SEVERITIES).toContain("CRITICAL");
    expect(VALID_SEVERITIES).toContain("LOW");
  });

  test("VALID_PROCESS_STATUSES が3種", () => {
    expect(VALID_PROCESS_STATUSES).toEqual(["success", "skipped", "error"]);
  });

  test("REQUIRED_INCIDENT_FIELDS が5項目", () => {
    expect(REQUIRED_INCIDENT_FIELDS).toHaveLength(5);
  });

  test("MAX_SNS_SUBJECT_BYTES は 100", () => {
    expect(MAX_SNS_SUBJECT_BYTES).toBe(100);
  });

  test("MAX_SNS_MESSAGE_BYTES は 256KB", () => {
    expect(MAX_SNS_MESSAGE_BYTES).toBe(256 * 1024);
  });

  test("ISO8601_PATTERN が有効な日時にマッチ", () => {
    expect(ISO8601_PATTERN.test("2026-09-01T10:00:00Z")).toBe(true);
    expect(ISO8601_PATTERN.test("2026-09-01T10:00:00+09:00")).toBe(true);
    expect(ISO8601_PATTERN.test("not-a-date")).toBe(false);
  });

  test("INCIDENT_ID_PATTERN が英数字・ハイフン・アンダースコアにマッチ", () => {
    expect(INCIDENT_ID_PATTERN.test("INC-001")).toBe(true);
    expect(INCIDENT_ID_PATTERN.test("abc_123")).toBe(true);
    expect(INCIDENT_ID_PATTERN.test("has space")).toBe(false);
  });
});

// ── AttributeValue バリデーション ────────────────────────────

describe("isValidAttributeValue", () => {
  test("有効な S 型", () => {
    expect(isValidAttributeValue({ S: "hello" })).toBe(true);
  });

  test("有効な N 型", () => {
    expect(isValidAttributeValue({ N: "42" })).toBe(true);
  });

  test("有効な BOOL 型", () => {
    expect(isValidAttributeValue({ BOOL: true })).toBe(true);
    expect(isValidAttributeValue({ BOOL: false })).toBe(true);
  });

  test("有効な NULL 型", () => {
    expect(isValidAttributeValue({ NULL: true })).toBe(true);
  });

  test("null / undefined は無効", () => {
    expect(isValidAttributeValue(null)).toBe(false);
    expect(isValidAttributeValue(undefined)).toBe(false);
  });

  test("空オブジェクトは無効", () => {
    expect(isValidAttributeValue({})).toBe(false);
  });

  test("不正な型は無効", () => {
    expect(isValidAttributeValue({ S: 123 })).toBe(false);
    expect(isValidAttributeValue({ N: 42 })).toBe(false);
  });
});

describe("safeExtractString", () => {
  test("S 型から文字列を取得", () => {
    expect(safeExtractString({ S: "hello" })).toBe("hello");
  });

  test("N 型から数値文字列を取得", () => {
    expect(safeExtractString({ N: "42" })).toBe("42");
  });

  test("BOOL 型から文字列を取得", () => {
    expect(safeExtractString({ BOOL: true })).toBe("true");
    expect(safeExtractString({ BOOL: false })).toBe("false");
  });

  test("NULL 型は空文字", () => {
    expect(safeExtractString({ NULL: true })).toBe("");
  });

  test("undefined は空文字", () => {
    expect(safeExtractString(undefined)).toBe("");
  });
});

describe("hasNonEmptyField", () => {
  test("値が存在し非空なら true", () => {
    const img: DynamoDBNewImage = { name: { S: "test" } };
    expect(hasNonEmptyField(img, "name")).toBe(true);
  });

  test("値が空文字なら false", () => {
    const img: DynamoDBNewImage = { name: { S: "" } };
    expect(hasNonEmptyField(img, "name")).toBe(false);
  });

  test("フィールドが存在しないなら false", () => {
    const img: DynamoDBNewImage = {};
    expect(hasNonEmptyField(img, "name")).toBe(false);
  });
});

// ── DynamoDB Streams レコードバリデーション ───────────────────

describe("isProcessableEvent", () => {
  test("INSERT は処理対象", () => {
    expect(isProcessableEvent("INSERT")).toBe(true);
  });

  test("MODIFY は処理対象", () => {
    expect(isProcessableEvent("MODIFY")).toBe(true);
  });

  test("REMOVE は処理対象外", () => {
    expect(isProcessableEvent("REMOVE")).toBe(false);
  });

  test("未知のイベントは処理対象外", () => {
    expect(isProcessableEvent("UNKNOWN")).toBe(false);
  });
});

describe("isKnownEventName", () => {
  test.each(["INSERT", "MODIFY", "REMOVE"])("%s は既知", (name) => {
    expect(isKnownEventName(name)).toBe(true);
  });

  test("UNKNOWN は未知", () => {
    expect(isKnownEventName("UNKNOWN")).toBe(false);
  });
});

describe("validateDynamoDBRecord", () => {
  test("有効な INSERT レコード", () => {
    const record = mkRecord("INSERT", mkIncidentImage());
    expect(validateDynamoDBRecord(record, 0)).toHaveLength(0);
  });

  test("有効な MODIFY レコード", () => {
    const record = mkRecord("MODIFY", mkIncidentImage());
    expect(validateDynamoDBRecord(record, 0)).toHaveLength(0);
  });

  test("REMOVE レコードは NewImage なしでも OK", () => {
    const record: DynamoDBRecord = {
      eventName: "REMOVE",
      dynamodb: { OldImage: mkIncidentImage() },
    };
    expect(validateDynamoDBRecord(record, 0)).toHaveLength(0);
  });

  test("eventName が未定義でエラー", () => {
    const record = { eventName: "", dynamodb: { NewImage: mkIncidentImage() } };
    const errors = validateDynamoDBRecord(record as DynamoDBRecord, 0);
    expect(errors.some((e) => e.field.includes("eventName"))).toBe(true);
  });

  test("dynamodb が未定義でエラー", () => {
    const record = { eventName: "INSERT" } as unknown as DynamoDBRecord;
    const errors = validateDynamoDBRecord(record, 0);
    expect(errors.some((e) => e.field.includes("dynamodb"))).toBe(true);
  });

  test("INSERT で NewImage なしはエラー", () => {
    const record: DynamoDBRecord = {
      eventName: "INSERT",
      dynamodb: {},
    };
    const errors = validateDynamoDBRecord(record, 0);
    expect(errors.some((e) => e.field.includes("NewImage"))).toBe(true);
  });

  test("INSERT で空 NewImage は warning", () => {
    const record = mkRecord("INSERT", {});
    const errors = validateDynamoDBRecord(record, 0);
    expect(errors.some((e) => e.severity === "warning")).toBe(true);
  });

  test("未知の eventName は warning", () => {
    const record = mkRecord("CUSTOM_EVENT", mkIncidentImage());
    const errors = validateDynamoDBRecord(record, 0);
    expect(
      errors.some(
        (e) => e.field.includes("eventName") && e.severity === "warning"
      )
    ).toBe(true);
  });

  test("index がフィールド名に反映される", () => {
    const record = mkRecord("INSERT", mkIncidentImage());
    record.dynamodb = undefined as unknown as DynamoDBRecord["dynamodb"];
    const errors = validateDynamoDBRecord(record, 5);
    expect(errors[0].field).toContain("records[5]");
  });
});

describe("validateRecords", () => {
  test("有効なレコード配列", () => {
    const records = [
      mkRecord("INSERT", mkIncidentImage()),
      mkRecord("MODIFY", mkIncidentImage()),
    ];
    expect(validateRecords(records)).toHaveLength(0);
  });

  test("空配列は warning", () => {
    const errors = validateRecords([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe("warning");
  });

  test("配列でない入力はエラー", () => {
    const errors = validateRecords("not-array" as unknown as DynamoDBRecord[]);
    expect(errors.some((e) => e.severity === "error")).toBe(true);
  });

  test("複数レコードの個別エラーが集約される", () => {
    const records = [
      { eventName: "INSERT" } as unknown as DynamoDBRecord,
      mkRecord("INSERT", mkIncidentImage()),
    ];
    const errors = validateRecords(records);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].field).toContain("records[0]");
  });
});

// ── インシデントフィールドバリデーション ──────────────────────

describe("isValidSeverity", () => {
  test.each(["CRITICAL", "HIGH", "MEDIUM", "LOW"])("%s は有効", (s) => {
    expect(isValidSeverity(s)).toBe(true);
  });

  test("小文字は無効", () => {
    expect(isValidSeverity("high")).toBe(false);
  });

  test("空文字は無効", () => {
    expect(isValidSeverity("")).toBe(false);
  });
});

describe("isValidIncidentStatus", () => {
  test.each(["OPEN", "ACKNOWLEDGED", "RESOLVED", "CLOSED"])(
    "%s は有効",
    (s) => {
      expect(isValidIncidentStatus(s)).toBe(true);
    }
  );

  test("unknown は無効", () => {
    expect(isValidIncidentStatus("unknown")).toBe(false);
  });
});

describe("isValidTimestamp", () => {
  test("UTC 形式は有効", () => {
    expect(isValidTimestamp("2026-09-01T10:00:00Z")).toBe(true);
  });

  test("タイムゾーンオフセット付きは有効", () => {
    expect(isValidTimestamp("2026-09-01T10:00:00+09:00")).toBe(true);
  });

  test("ミリ秒付きは有効", () => {
    expect(isValidTimestamp("2026-09-01T10:00:00.123Z")).toBe(true);
  });

  test("日付のみは無効", () => {
    expect(isValidTimestamp("2026-09-01")).toBe(false);
  });

  test("不正な日付は無効", () => {
    expect(isValidTimestamp("2026-13-01T10:00:00Z")).toBe(false);
  });

  test("空文字は無効", () => {
    expect(isValidTimestamp("")).toBe(false);
  });
});

describe("isValidIncidentId", () => {
  test("ハイフン区切りは有効", () => {
    expect(isValidIncidentId("INC-001")).toBe(true);
  });

  test("アンダースコアは有効", () => {
    expect(isValidIncidentId("inc_2026_001")).toBe(true);
  });

  test("空文字は無効", () => {
    expect(isValidIncidentId("")).toBe(false);
  });

  test("スペース含みは無効", () => {
    expect(isValidIncidentId("INC 001")).toBe(false);
  });

  test("129文字以上は無効", () => {
    expect(isValidIncidentId("A".repeat(129))).toBe(false);
  });

  test("128文字は有効", () => {
    expect(isValidIncidentId("A".repeat(128))).toBe(true);
  });
});

describe("validateIncidentFields", () => {
  test("全フィールド揃いでエラーなし", () => {
    const errors = validateIncidentFields(mkIncidentImage());
    expect(errors).toHaveLength(0);
  });

  test("incident_id 欠落でエラー", () => {
    const img = mkIncidentImage();
    delete img["incident_id"];
    const errors = validateIncidentFields(img);
    expect(
      errors.some(
        (e) => e.field === "NewImage.incident_id" && e.severity === "error"
      )
    ).toBe(true);
  });

  test("severity 欠落でエラー", () => {
    const img = mkIncidentImage();
    delete img["severity"];
    const errors = validateIncidentFields(img);
    expect(
      errors.some(
        (e) => e.field === "NewImage.severity" && e.severity === "error"
      )
    ).toBe(true);
  });

  test("無効な severity でエラー", () => {
    const img = mkIncidentImage({ severity: { S: "UNKNOWN" } });
    const errors = validateIncidentFields(img);
    expect(
      errors.some(
        (e) => e.field === "NewImage.severity" && e.severity === "error"
      )
    ).toBe(true);
  });

  test("無効な incident status は warning", () => {
    const img = mkIncidentImage({ status: { S: "PENDING" } });
    const errors = validateIncidentFields(img);
    expect(
      errors.some(
        (e) => e.field === "NewImage.status" && e.severity === "warning"
      )
    ).toBe(true);
  });

  test("無効なタイムスタンプは warning", () => {
    const img = mkIncidentImage({ timestamp: { S: "yesterday" } });
    const errors = validateIncidentFields(img);
    expect(
      errors.some(
        (e) => e.field === "NewImage.timestamp" && e.severity === "warning"
      )
    ).toBe(true);
  });

  test("resource 欠落は warning", () => {
    const img = mkIncidentImage();
    delete img["resource"];
    const errors = validateIncidentFields(img);
    expect(
      errors.some(
        (e) => e.field === "NewImage.resource" && e.severity === "warning"
      )
    ).toBe(true);
  });

  test("不正な incident_id フォーマットでエラー", () => {
    const img = mkIncidentImage({ incident_id: { S: "INC 001!@#" } });
    const errors = validateIncidentFields(img);
    expect(
      errors.some(
        (e) =>
          e.field === "NewImage.incident_id" &&
          e.message.includes("フォーマット")
      )
    ).toBe(true);
  });
});

// ── SNS メッセージ制約バリデーション ─────────────────────────

describe("getUtf8ByteLength", () => {
  test("ASCII 文字は1バイト", () => {
    expect(getUtf8ByteLength("abc")).toBe(3);
  });

  test("日本語文字は3バイト", () => {
    expect(getUtf8ByteLength("あ")).toBe(3);
  });

  test("空文字は0バイト", () => {
    expect(getUtf8ByteLength("")).toBe(0);
  });
});

describe("validateSnsSubject", () => {
  test("有効な件名", () => {
    expect(validateSnsSubject("[インシデント] [HIGH] INC-001")).toHaveLength(0);
  });

  test("空の件名はエラー", () => {
    const errors = validateSnsSubject("");
    expect(errors.some((e) => e.severity === "error")).toBe(true);
  });

  test("スペースのみはエラー", () => {
    const errors = validateSnsSubject("   ");
    expect(errors.some((e) => e.severity === "error")).toBe(true);
  });

  test("100バイト超えは warning", () => {
    const longSubject = "[インシデント] " + "A".repeat(100);
    const errors = validateSnsSubject(longSubject);
    expect(errors.some((e) => e.severity === "warning")).toBe(true);
  });

  test("ちょうど100バイトは OK", () => {
    const subject = "A".repeat(100);
    expect(validateSnsSubject(subject)).toHaveLength(0);
  });
});

describe("validateSnsMessage", () => {
  test("有効な本文", () => {
    expect(validateSnsMessage("インシデントアラート")).toHaveLength(0);
  });

  test("空の本文はエラー", () => {
    const errors = validateSnsMessage("");
    expect(errors.some((e) => e.severity === "error")).toBe(true);
  });

  test("256KB 超えはエラー", () => {
    const bigMessage = "A".repeat(MAX_SNS_MESSAGE_BYTES + 1);
    const errors = validateSnsMessage(bigMessage);
    expect(
      errors.some((e) => e.field === "message" && e.severity === "error")
    ).toBe(true);
  });
});

// ── ProcessResult / HandlerResult バリデーション ─────────────

describe("isValidProcessStatus", () => {
  test.each(["success", "skipped", "error"])("%s は有効", (s) => {
    expect(isValidProcessStatus(s)).toBe(true);
  });

  test("unknown は無効", () => {
    expect(isValidProcessStatus("unknown")).toBe(false);
  });
});

describe("validateProcessResult", () => {
  test("有効な success 結果", () => {
    const result: ProcessResult = {
      incident_id: "INC-001",
      severity: "HIGH",
      status: "success",
      message_id: "msg-123",
    };
    expect(validateProcessResult(result, 0, "processed")).toHaveLength(0);
  });

  test("success に message_id なしは warning", () => {
    const result: ProcessResult = {
      incident_id: "INC-001",
      severity: "HIGH",
      status: "success",
    };
    const errors = validateProcessResult(result, 0, "processed");
    expect(errors.some((e) => e.field.includes("message_id"))).toBe(true);
  });

  test("error に reason なしは warning", () => {
    const result: ProcessResult = {
      incident_id: "INC-001",
      severity: "HIGH",
      status: "error",
    };
    const errors = validateProcessResult(result, 0, "errors");
    expect(errors.some((e) => e.field.includes("reason"))).toBe(true);
  });

  test("skipped に reason なしは warning", () => {
    const result: ProcessResult = {
      eventName: "REMOVE",
      status: "skipped",
    };
    const errors = validateProcessResult(result, 0, "skipped");
    expect(errors.some((e) => e.field.includes("reason"))).toBe(true);
  });

  test("無効な status はエラー", () => {
    const result = { status: "pending" } as unknown as ProcessResult;
    const errors = validateProcessResult(result, 0, "processed");
    expect(errors.some((e) => e.severity === "error")).toBe(true);
  });
});

describe("validateHandlerResult", () => {
  test("有効な HandlerResult", () => {
    const result: HandlerResult = {
      processed: [
        { incident_id: "INC-001", severity: "HIGH", status: "success", message_id: "msg-1" },
      ],
      skipped: [
        { eventName: "REMOVE", status: "skipped", reason: "non-target event" },
      ],
      errors: [],
    };
    expect(validateHandlerResult(result)).toHaveLength(0);
  });

  test("processed に error ステータスがあればエラー", () => {
    const result: HandlerResult = {
      processed: [
        { incident_id: "INC-001", severity: "HIGH", status: "error", reason: "fail" },
      ],
      skipped: [],
      errors: [],
    };
    const errors = validateHandlerResult(result);
    expect(
      errors.some(
        (e) =>
          e.field.includes("processed") &&
          e.message.includes("success 以外")
      )
    ).toBe(true);
  });

  test("skipped に success ステータスがあればエラー", () => {
    const result: HandlerResult = {
      processed: [],
      skipped: [
        { incident_id: "INC-001", severity: "HIGH", status: "success", message_id: "m-1" },
      ],
      errors: [],
    };
    const errors = validateHandlerResult(result);
    expect(
      errors.some(
        (e) =>
          e.field.includes("skipped") &&
          e.message.includes("skipped 以外")
      )
    ).toBe(true);
  });

  test("errors に skipped ステータスがあればエラー", () => {
    const result: HandlerResult = {
      processed: [],
      skipped: [],
      errors: [
        { eventName: "INSERT", status: "skipped", reason: "oops" },
      ],
    };
    const errors = validateHandlerResult(result);
    expect(
      errors.some(
        (e) =>
          e.field.includes("errors") &&
          e.message.includes("error 以外")
      )
    ).toBe(true);
  });

  test("processed が配列でなければエラー", () => {
    const result = {
      processed: "invalid",
      skipped: [],
      errors: [],
    } as unknown as HandlerResult;
    const errors = validateHandlerResult(result);
    expect(
      errors.some((e) => e.field === "processed" && e.severity === "error")
    ).toBe(true);
  });
});

describe("validateResultCount", () => {
  test("入出力数一致", () => {
    const result: HandlerResult = {
      processed: [{ status: "success", message_id: "m-1" } as ProcessResult],
      skipped: [{ status: "skipped", reason: "r" } as ProcessResult],
      errors: [],
    };
    expect(validateResultCount(2, result)).toHaveLength(0);
  });

  test("入出力数不一致は warning", () => {
    const result: HandlerResult = {
      processed: [{ status: "success", message_id: "m-1" } as ProcessResult],
      skipped: [],
      errors: [],
    };
    const errors = validateResultCount(3, result);
    expect(errors.some((e) => e.severity === "warning")).toBe(true);
    expect(errors[0].message).toContain("3");
    expect(errors[0].message).toContain("1");
  });
});

// ── ユーティリティ ────────────────────────────────────────────

describe("hasErrors", () => {
  test("error があれば true", () => {
    const errors: ValidationError[] = [
      { field: "x", message: "err", severity: "error" },
    ];
    expect(hasErrors(errors)).toBe(true);
  });

  test("warning のみなら false", () => {
    const errors: ValidationError[] = [
      { field: "x", message: "warn", severity: "warning" },
    ];
    expect(hasErrors(errors)).toBe(false);
  });

  test("空配列なら false", () => {
    expect(hasErrors([])).toBe(false);
  });
});

describe("formatErrors", () => {
  test("空配列は成功メッセージ", () => {
    expect(formatErrors([])).toBe("すべてのチェックが通過しました");
  });

  test("エラーをフォーマット", () => {
    const errors: ValidationError[] = [
      { field: "x", message: "問題", severity: "error" },
      { field: "y", message: "注意", severity: "warning" },
    ];
    const result = formatErrors(errors);
    expect(result).toContain("[ERROR] x: 問題");
    expect(result).toContain("[WARNING] y: 注意");
  });
});

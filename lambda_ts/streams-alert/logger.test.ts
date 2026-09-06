import {
  // 定数
  LOG_LEVELS,
  DEFAULT_LOG_LEVEL,
  SENSITIVE_KEY_PATTERNS,
  REDACTED,
  CIRCULAR,
  TRUNCATED,
  DEFAULT_REDACT_OPTIONS,
  // レベル
  parseLogLevel,
  shouldLog,
  // マスキング
  isSensitiveKey,
  redact,
  // エントリ
  buildLogEntry,
  formatLogEntry,
  // 本体
  createLogger,
  createLoggerFromEnv,
  consoleSink,
  retryLogger,
} from "./logger";
import type { EmittableLevel, LogEntry, LogLevel } from "./logger";

// ── テスト用ヘルパー ───────────────────────────────────────────

/** 出力行を溜め込むシンク */
function createSink(): {
  sink: (line: string, level: EmittableLevel) => void;
  lines: string[];
  levels: EmittableLevel[];
  entries: () => Record<string, unknown>[];
} {
  const lines: string[] = [];
  const levels: EmittableLevel[] = [];
  return {
    sink: (line, level) => {
      lines.push(line);
      levels.push(level);
    },
    lines,
    levels,
    entries: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

/** 固定時刻を返す now */
const FIXED_ISO = "2026-09-07T00:00:00.000Z";
const fixedNow = (): Date => new Date(FIXED_ISO);

/** 1 回だけログを出して、その JSON を返す */
function logOnce(
  level: EmittableLevel,
  message: string,
  context?: Record<string, unknown>,
): Record<string, unknown> {
  const { sink, entries } = createSink();
  const logger = createLogger({ level: "debug", sink, now: fixedNow });
  logger[level](message, context);
  return entries()[0];
}

// ── parseLogLevel ─────────────────────────────────────────────

describe("parseLogLevel", () => {
  test.each(LOG_LEVELS)("正規のレベル %s をそのまま解釈する", (level) => {
    expect(parseLogLevel(level)).toBe(level);
  });

  test.each([
    ["DEBUG", "debug"],
    ["Info", "info"],
    ["  warn  ", "warn"],
    ["ERROR", "error"],
  ])("大文字・空白を含む %s を %s に正規化する", (input, expected) => {
    expect(parseLogLevel(input)).toBe(expected);
  });

  test.each([
    ["warning", "warn"],
    ["fatal", "error"],
    ["critical", "error"],
    ["trace", "debug"],
    ["verbose", "debug"],
    ["none", "silent"],
    ["off", "silent"],
  ])("別名 %s を %s として扱う", (input, expected) => {
    expect(parseLogLevel(input)).toBe(expected);
  });

  test.each([undefined, null, "", "   ", "unknown", "12345"])(
    "未知の値 %p は既定値にフォールバックする",
    (input) => {
      expect(parseLogLevel(input as string | undefined)).toBe(DEFAULT_LOG_LEVEL);
    },
  );

  it("fallback を明示指定できる", () => {
    expect(parseLogLevel("なにこれ", "error")).toBe("error");
  });

  it("数値など文字列以外を渡しても例外を投げない", () => {
    expect(() => parseLogLevel(42 as unknown as string)).not.toThrow();
    expect(parseLogLevel(42 as unknown as string)).toBe(DEFAULT_LOG_LEVEL);
  });
});

// ── shouldLog ─────────────────────────────────────────────────

describe("shouldLog", () => {
  const cases: [LogLevel, EmittableLevel, boolean][] = [
    ["debug", "debug", true],
    ["debug", "info", true],
    ["debug", "warn", true],
    ["debug", "error", true],
    ["info", "debug", false],
    ["info", "info", true],
    ["info", "error", true],
    ["warn", "info", false],
    ["warn", "warn", true],
    ["error", "warn", false],
    ["error", "error", true],
    ["silent", "debug", false],
    ["silent", "error", false],
  ];

  test.each(cases)("設定 %s のとき %s は %p", (current, entry, expected) => {
    expect(shouldLog(current, entry)).toBe(expected);
  });

  it("silent はすべての出力を止める", () => {
    const emittable: EmittableLevel[] = ["debug", "info", "warn", "error"];
    expect(emittable.every((l) => shouldLog("silent", l) === false)).toBe(true);
  });
});

// ── isSensitiveKey ────────────────────────────────────────────

describe("isSensitiveKey", () => {
  test.each(SENSITIVE_KEY_PATTERNS)("既定パターン %s を機密と判定する", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  test.each([
    "password",
    "userPassword",
    "PASSWORD",
    "access-key",
    "access_key",
    "AccessKeyId",
    "x-api-key",
    "clientSecret",
    "Authorization",
    "refreshToken",
    "sessionId",
    "Set-Cookie",
  ])("派生名 %s も部分一致で拾う", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  test.each(["itemId", "name", "count", "createdAt", "message", "userName", ""])(
    "通常のキー %p は機密ではない",
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );

  it("追加キーを指定できる", () => {
    expect(isSensitiveKey("myCompanyId")).toBe(false);
    expect(isSensitiveKey("myCompanyId", ["companyId"])).toBe(true);
  });

  it("空文字の追加キーは全件マッチを起こさない", () => {
    expect(isSensitiveKey("itemId", [""])).toBe(false);
  });
});

// ── redact ────────────────────────────────────────────────────

describe("redact", () => {
  it("機密キーの値をマスクする", () => {
    const result = redact({ userId: "u1", password: "p@ssw0rd" }) as Record<string, unknown>;
    expect(result).toEqual({ userId: "u1", password: REDACTED });
  });

  it("ネストした機密キーもマスクする", () => {
    const result = redact({
      request: { headers: { authorization: "Bearer xyz" }, path: "/items" },
    }) as Record<string, { headers: Record<string, unknown>; path: string }>;
    expect(result.request.headers.authorization).toBe(REDACTED);
    expect(result.request.path).toBe("/items");
  });

  it("配列の中の機密キーもマスクする", () => {
    const result = redact({ users: [{ name: "a", token: "t1" }] }) as {
      users: Record<string, unknown>[];
    };
    expect(result.users[0]).toEqual({ name: "a", token: REDACTED });
  });

  it("入力オブジェクトを変更しない", () => {
    const input = { password: "secret", nested: { token: "t" } };
    const snapshot = JSON.stringify(input);
    redact(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("循環参照を [Circular] に置き換える", () => {
    const node: Record<string, unknown> = { name: "root" };
    node.self = node;
    const result = redact(node) as Record<string, unknown>;
    expect(result.name).toBe("root");
    expect(result.self).toBe(CIRCULAR);
  });

  it("兄弟位置での同一オブジェクト参照は循環扱いしない", () => {
    const shared = { id: 1 };
    const result = redact({ a: shared, b: shared }) as Record<string, unknown>;
    expect(result.a).toEqual({ id: 1 });
    expect(result.b).toEqual({ id: 1 });
  });

  it("maxDepth を超えるネストを切り詰める", () => {
    const deep = { l1: { l2: { l3: { l4: "値" } } } };
    const result = redact(deep, { maxDepth: 2 }) as Record<string, Record<string, unknown>>;
    expect(result.l1.l2).toBe(TRUNCATED);
  });

  it("maxArrayLength を超える配列を切り詰めて残数を示す", () => {
    const result = redact({ items: [1, 2, 3, 4, 5] }, { maxArrayLength: 2 }) as {
      items: unknown[];
    };
    expect(result.items).toHaveLength(3);
    expect(result.items.slice(0, 2)).toEqual([1, 2]);
    expect(String(result.items[2])).toContain("残り 3 件");
  });

  it("maxStringLength を超える文字列を切り詰める", () => {
    const result = redact({ body: "あ".repeat(50) }, { maxStringLength: 10 }) as {
      body: string;
    };
    expect(result.body.startsWith("あ".repeat(10))).toBe(true);
    expect(result.body).toContain(TRUNCATED);
  });

  it("Error を name / message / stack に展開する", () => {
    const error = new Error("失敗しました");
    error.name = "ThrottlingException";
    const result = redact({ error }) as { error: Record<string, unknown> };
    expect(result.error.name).toBe("ThrottlingException");
    expect(result.error.message).toBe("失敗しました");
    expect(typeof result.error.stack).toBe("string");
  });

  it("stack を持たない Error でも落ちない", () => {
    const error = new Error("stack なし");
    delete (error as { stack?: string }).stack;
    const result = redact({ error }) as { error: Record<string, unknown> };
    expect(result.error).toEqual({ name: "Error", message: "stack なし" });
  });

  it("Date を ISO 文字列にする", () => {
    const result = redact({ at: new Date(FIXED_ISO) }) as { at: string };
    expect(result.at).toBe(FIXED_ISO);
  });

  it("不正な Date を Invalid Date として表す", () => {
    const result = redact({ at: new Date("なにこれ") }) as { at: string };
    expect(result.at).toBe("Invalid Date");
  });

  it("Map をオブジェクトに変換しつつ機密キーをマスクする", () => {
    const map = new Map<string, unknown>([
      ["userId", "u1"],
      ["apiKey", "k1"],
    ]);
    expect(redact(map)).toEqual({ userId: "u1", apiKey: REDACTED });
  });

  it("Set を配列に変換する", () => {
    expect(redact(new Set([1, 2, 3]))).toEqual([1, 2, 3]);
  });

  test.each([
    [null, null],
    [undefined, undefined],
    [true, true],
    [0, 0],
    ["文字列", "文字列"],
  ])("プリミティブ %p はそのまま返す", (input, expected) => {
    expect(redact(input)).toEqual(expected);
  });

  test.each([
    [NaN, "NaN"],
    [Infinity, "Infinity"],
    [-Infinity, "-Infinity"],
  ])("JSON 化できない数値 %p を文字列として残す", (input, expected) => {
    expect(redact({ v: input })).toEqual({ v: expected });
  });

  it("BigInt を末尾 n 付きの文字列にする", () => {
    expect(redact({ v: BigInt(10) })).toEqual({ v: "10n" });
  });

  it("関数を関数名付きの印にする", () => {
    function namedFn(): void {}
    expect(redact({ fn: namedFn })).toEqual({ fn: "[Function: namedFn]" });
  });

  it("Symbol を文字列にする", () => {
    expect(redact({ s: Symbol("tag") })).toEqual({ s: "Symbol(tag)" });
  });

  it("既定の上限値が公開されている", () => {
    expect(DEFAULT_REDACT_OPTIONS.maxDepth).toBeGreaterThan(0);
    expect(DEFAULT_REDACT_OPTIONS.maxArrayLength).toBeGreaterThan(0);
    expect(DEFAULT_REDACT_OPTIONS.maxStringLength).toBeGreaterThan(0);
  });
});

// ── buildLogEntry ─────────────────────────────────────────────

describe("buildLogEntry", () => {
  it("timestamp / level / message を必ず持つ", () => {
    const entry = buildLogEntry("info", "テスト", {}, { now: fixedNow });
    expect(entry.timestamp).toBe(FIXED_ISO);
    expect(entry.level).toBe("info");
    expect(entry.message).toBe("テスト");
  });

  it("base と context をマージし、context を優先する", () => {
    const entry = buildLogEntry(
      "info",
      "m",
      { requestId: "後勝ち" },
      { base: { requestId: "先", functionName: "fn" }, now: fixedNow },
    );
    expect(entry.requestId).toBe("後勝ち");
    expect(entry.functionName).toBe("fn");
  });

  test.each(["timestamp", "level", "message"])(
    "予約フィールド %s は context から上書きできない",
    (field) => {
      const entry = buildLogEntry("warn", "本文", { [field]: "乗っ取り" }, { now: fixedNow });
      expect(entry[field]).not.toBe("乗っ取り");
    },
  );

  it("context の機密情報をマスクする", () => {
    const entry = buildLogEntry("info", "m", { password: "p" }, { now: fixedNow });
    expect(entry.password).toBe(REDACTED);
  });

  it("extraKeys がマスキングに反映される", () => {
    const entry = buildLogEntry(
      "info",
      "m",
      { companyId: "c1" },
      { now: fixedNow, extraKeys: ["companyId"] },
    );
    expect(entry.companyId).toBe(REDACTED);
  });

  it("context を省略できる", () => {
    expect(() => buildLogEntry("debug", "m")).not.toThrow();
  });
});

// ── formatLogEntry ────────────────────────────────────────────

describe("formatLogEntry", () => {
  it("改行を含まない 1 行の JSON を返す", () => {
    const line = formatLogEntry(buildLogEntry("info", "複数\n行", {}, { now: fixedNow }));
    expect(line).not.toContain("\n");
    expect(JSON.parse(line).message).toBe("複数\n行");
  });

  it("シリアライズに失敗しても例外を投げずフォールバック行を返す", () => {
    const broken = {
      timestamp: FIXED_ISO,
      level: "error",
      message: "壊れた値",
      bad: {
        toJSON(): never {
          throw new Error("toJSON が失敗");
        },
      },
    } as unknown as LogEntry;

    const line = formatLogEntry(broken);
    const parsed = JSON.parse(line);
    expect(parsed.message).toBe("壊れた値");
    expect(parsed.level).toBe("error");
    expect(parsed.logError).toContain("シリアライズ");
  });
});

// ── createLogger ──────────────────────────────────────────────

describe("createLogger", () => {
  test.each<EmittableLevel>(["debug", "info", "warn", "error"])(
    "%s が level フィールドに入る",
    (level) => {
      expect(logOnce(level, "m").level).toBe(level);
    },
  );

  it("設定レベル未満のログを出力しない", () => {
    const { sink, lines } = createSink();
    const logger = createLogger({ level: "warn", sink, now: fixedNow });
    logger.debug("出ない");
    logger.info("出ない");
    logger.warn("出る");
    logger.error("出る");
    expect(lines).toHaveLength(2);
  });

  it("silent では一切出力しない", () => {
    const { sink, lines } = createSink();
    const logger = createLogger({ level: "silent", sink });
    logger.error("出ない");
    expect(lines).toHaveLength(0);
  });

  it("既定レベルは info", () => {
    const { sink, lines } = createSink();
    const logger = createLogger({ sink });
    expect(logger.level).toBe(DEFAULT_LOG_LEVEL);
    logger.debug("出ない");
    expect(lines).toHaveLength(0);
  });

  it("sink にレベルを渡す", () => {
    const { sink, levels } = createSink();
    const logger = createLogger({ level: "debug", sink });
    logger.warn("w");
    logger.error("e");
    expect(levels).toEqual(["warn", "error"]);
  });

  it("base フィールドを全ログに付与する", () => {
    const { sink, entries } = createSink();
    const logger = createLogger({ level: "debug", sink, now: fixedNow, base: { app: "api" } });
    logger.info("a");
    logger.error("b");
    expect(entries().every((e) => e.app === "api")).toBe(true);
  });

  describe("child", () => {
    it("共通フィールドを追加する", () => {
      const { sink, entries } = createSink();
      const logger = createLogger({ level: "debug", sink, now: fixedNow, base: { app: "api" } });
      logger.child({ requestId: "r1" }).info("m");
      expect(entries()[0]).toMatchObject({ app: "api", requestId: "r1" });
    });

    it("親ロガーを変更しない", () => {
      const { sink, entries } = createSink();
      const logger = createLogger({ level: "debug", sink, now: fixedNow });
      logger.child({ requestId: "r1" }).info("子");
      logger.info("親");
      expect(entries()[0].requestId).toBe("r1");
      expect(entries()[1].requestId).toBeUndefined();
    });

    it("入れ子にでき、後から指定した値が勝つ", () => {
      const { sink, entries } = createSink();
      const logger = createLogger({ level: "debug", sink, now: fixedNow });
      logger.child({ a: 1, b: 1 }).child({ b: 2 }).info("m");
      expect(entries()[0]).toMatchObject({ a: 1, b: 2 });
    });

    it("レベル設定を引き継ぐ", () => {
      const { sink, lines } = createSink();
      const child = createLogger({ level: "error", sink }).child({ requestId: "r1" });
      expect(child.level).toBe("error");
      child.info("出ない");
      expect(lines).toHaveLength(0);
    });
  });
});

// ── createLoggerFromEnv ───────────────────────────────────────

describe("createLoggerFromEnv", () => {
  it("LOG_LEVEL を読み取る", () => {
    expect(createLoggerFromEnv({ LOG_LEVEL: "error" }).level).toBe("error");
  });

  it("LOG_LEVEL 未設定なら既定値になる", () => {
    expect(createLoggerFromEnv({}).level).toBe(DEFAULT_LOG_LEVEL);
  });

  it("不正な LOG_LEVEL でも例外を投げない", () => {
    expect(() => createLoggerFromEnv({ LOG_LEVEL: "でたらめ" })).not.toThrow();
    expect(createLoggerFromEnv({ LOG_LEVEL: "でたらめ" }).level).toBe(DEFAULT_LOG_LEVEL);
  });
});

// ── consoleSink ───────────────────────────────────────────────

describe("consoleSink", () => {
  const spies = {
    log: jest.spyOn(console, "log").mockImplementation(() => {}),
    warn: jest.spyOn(console, "warn").mockImplementation(() => {}),
    error: jest.spyOn(console, "error").mockImplementation(() => {}),
  };

  afterEach(() => {
    spies.log.mockClear();
    spies.warn.mockClear();
    spies.error.mockClear();
  });

  afterAll(() => {
    spies.log.mockRestore();
    spies.warn.mockRestore();
    spies.error.mockRestore();
  });

  it("error は console.error に出す", () => {
    consoleSink("line", "error");
    expect(spies.error).toHaveBeenCalledWith("line");
  });

  it("warn は console.warn に出す", () => {
    consoleSink("line", "warn");
    expect(spies.warn).toHaveBeenCalledWith("line");
  });

  test.each<EmittableLevel>(["debug", "info"])("%s は console.log に出す", (level) => {
    consoleSink("line", level);
    expect(spies.log).toHaveBeenCalledWith("line");
  });
});

// ── retryLogger ───────────────────────────────────────────────

describe("retryLogger", () => {
  it("リトライを warn で構造化して記録する", () => {
    const { sink, entries } = createSink();
    const logger = createLogger({ level: "debug", sink, now: fixedNow });
    const error = new Error("スロットリング");
    error.name = "ThrottlingException";

    retryLogger(logger, "PutItem")(2, 512.7, error);

    const entry = entries()[0];
    expect(entry.level).toBe("warn");
    expect(entry.operation).toBe("PutItem");
    expect(entry.attempt).toBe(2);
    expect(entry.delayMs).toBe(513);
    expect((entry.error as Record<string, unknown>).name).toBe("ThrottlingException");
  });

  it("silent なロガーでは何も出力しない", () => {
    const { sink, lines } = createSink();
    const logger = createLogger({ level: "silent", sink });
    retryLogger(logger, "PutItem")(1, 100, new Error("x"));
    expect(lines).toHaveLength(0);
  });
});

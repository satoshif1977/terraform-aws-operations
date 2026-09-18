import {
  // 定数
  RETRYABLE_ERROR_CODES,
  RETRYABLE_STATUS_CODES,
  DEFAULT_RETRY_CONFIG,
  // 設定
  validateRetryConfig,
  resolveRetryConfig,
  // 抽出
  extractErrorCode,
  extractStatusCode,
  isRetryableError,
  // 計算
  computeDelay,
  // 待機
  delay,
  // 本体
  retryAsync,
  withRetry,
} from "./retry";
import type { RetryConfig } from "./retry";

// ── テスト用ヘルパー ───────────────────────────────────────────

/** AWS SDK v3 風のエラーを組み立てる */
function awsError(name: string, httpStatusCode?: number): Error {
  const error = new Error(`${name} が発生しました`);
  error.name = name;
  if (httpStatusCode !== undefined) {
    (error as unknown as { $metadata: { httpStatusCode: number } }).$metadata = {
      httpStatusCode,
    };
  }
  return error;
}

/** Node.js のネットワークエラー風オブジェクトを組み立てる */
function nodeError(code: string): Error {
  const error = new Error(code);
  (error as unknown as { code: string }).code = code;
  return error;
}

/** 待機時間を記録するスタブ */
function createSleeper(): {
  sleep: (ms: number) => Promise<void>;
  calls: number[];
} {
  const calls: number[] = [];
  return {
    calls,
    sleep: async (ms: number) => {
      calls.push(ms);
    },
  };
}

/** 指定回数だけ失敗し、その後成功する関数を作る */
function createFlaky<T>(
  failTimes: number,
  error: unknown,
  value: T,
): { fn: () => Promise<T>; getCalls: () => number } {
  let calls = 0;
  return {
    getCalls: () => calls,
    fn: async () => {
      calls += 1;
      if (calls <= failTimes) throw error;
      return value;
    },
  };
}

const NO_JITTER: RetryConfig = {
  maxAttempts: 4,
  baseDelayMs: 100,
  maxDelayMs: 10_000,
  jitter: false,
};

const THROTTLING = awsError("ThrottlingException", 429);

// ── 設定 ───────────────────────────────────────────────────────

describe("DEFAULT_RETRY_CONFIG", () => {
  it("既定値が想定どおり", () => {
    expect(DEFAULT_RETRY_CONFIG).toEqual({
      maxAttempts: 4,
      baseDelayMs: 500,
      maxDelayMs: 8000,
      jitter: true,
    });
  });

  it("既定値は検証を通る", () => {
    expect(() => validateRetryConfig(DEFAULT_RETRY_CONFIG)).not.toThrow();
  });
});

describe("validateRetryConfig", () => {
  const base = DEFAULT_RETRY_CONFIG;

  it.each([
    ["maxAttempts が 1", { maxAttempts: 1 }],
    ["maxAttempts が大きい", { maxAttempts: 100 }],
    ["maxDelayMs と baseDelayMs が同値", { baseDelayMs: 200, maxDelayMs: 200 }],
  ])("正常系: %s", (_name, patch) => {
    expect(() => validateRetryConfig({ ...base, ...patch })).not.toThrow();
  });

  it.each([
    ["maxAttempts が 0", { maxAttempts: 0 }],
    ["maxAttempts が負数", { maxAttempts: -1 }],
    ["maxAttempts が小数", { maxAttempts: 2.5 }],
    ["maxAttempts が NaN", { maxAttempts: NaN }],
  ])("異常系: %s", (_name, patch) => {
    expect(() => validateRetryConfig({ ...base, ...patch })).toThrow(RangeError);
  });

  it.each([
    ["baseDelayMs が 0", { baseDelayMs: 0 }],
    ["baseDelayMs が負数", { baseDelayMs: -100 }],
    ["baseDelayMs が Infinity", { baseDelayMs: Infinity }],
  ])("異常系: %s", (_name, patch) => {
    expect(() => validateRetryConfig({ ...base, ...patch })).toThrow(RangeError);
  });

  it.each([
    ["maxDelayMs が baseDelayMs 未満", { baseDelayMs: 1000, maxDelayMs: 500 }],
    ["maxDelayMs が Infinity", { maxDelayMs: Infinity }],
  ])("異常系: %s", (_name, patch) => {
    expect(() => validateRetryConfig({ ...base, ...patch })).toThrow(RangeError);
  });

  it("エラーメッセージに項目名が含まれる", () => {
    expect(() => validateRetryConfig({ ...base, maxAttempts: 0 })).toThrow(
      /maxAttempts/,
    );
  });
});

describe("resolveRetryConfig", () => {
  it("未指定なら既定値を返す", () => {
    expect(resolveRetryConfig()).toEqual(DEFAULT_RETRY_CONFIG);
  });

  it("部分指定を既定値で補完する", () => {
    expect(resolveRetryConfig({ maxAttempts: 2 })).toEqual({
      ...DEFAULT_RETRY_CONFIG,
      maxAttempts: 2,
    });
  });

  it("既定値を破壊しない", () => {
    resolveRetryConfig({ maxAttempts: 9 });
    expect(DEFAULT_RETRY_CONFIG.maxAttempts).toBe(4);
  });

  it("不正な部分指定は RangeError", () => {
    expect(() => resolveRetryConfig({ maxAttempts: 0 })).toThrow(RangeError);
  });
});

// ── エラー情報の抽出 ───────────────────────────────────────────

describe("extractErrorCode", () => {
  it("AWS SDK の name を取得する", () => {
    expect(extractErrorCode(awsError("ThrottlingException"))).toBe(
      "ThrottlingException",
    );
  });

  it("Node.js の code を優先する", () => {
    expect(extractErrorCode(nodeError("ECONNRESET"))).toBe("ECONNRESET");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["文字列", "boom"],
    ["数値", 42],
  ])("オブジェクトでない場合は空文字: %s", (_name, value) => {
    expect(extractErrorCode(value)).toBe("");
  });

  it("name も code も無い場合は空文字", () => {
    expect(extractErrorCode({})).toBe("");
  });

  it("code が空文字なら name にフォールバックする", () => {
    expect(extractErrorCode({ code: "", name: "Fallback" })).toBe("Fallback");
  });
});

describe("extractStatusCode", () => {
  it("$metadata.httpStatusCode を取得する", () => {
    expect(extractStatusCode(awsError("X", 503))).toBe(503);
  });

  it("status を取得する（fetch 由来）", () => {
    expect(extractStatusCode({ status: 429 })).toBe(429);
  });

  it("statusCode を取得する", () => {
    expect(extractStatusCode({ statusCode: 500 })).toBe(500);
  });

  it("$metadata を優先する", () => {
    expect(extractStatusCode({ $metadata: { httpStatusCode: 503 }, status: 200 })).toBe(
      503,
    );
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["空オブジェクト", {}],
    ["文字列ステータス", { status: "429" }],
  ])("取得できない場合は undefined: %s", (_name, value) => {
    expect(extractStatusCode(value)).toBeUndefined();
  });
});

// ── リトライ可否の判定 ─────────────────────────────────────────

describe("isRetryableError", () => {
  it.each([...RETRYABLE_ERROR_CODES])("リトライ対象コード: %s", (code) => {
    // ステータスは非リトライ対象の 400 にして、コード単体の判定を確認する
    expect(isRetryableError(awsError(code, 400))).toBe(true);
  });

  it.each([...RETRYABLE_STATUS_CODES])("リトライ対象ステータス: %s", (status) => {
    expect(isRetryableError(awsError("UnknownError", status))).toBe(true);
  });

  it.each([
    "ValidationException",
    "AccessDeniedException",
    "ResourceNotFoundException",
    "ConditionalCheckFailedException",
  ])("リトライ不能コード: %s", (code) => {
    expect(isRetryableError(awsError(code, 400))).toBe(false);
  });

  it.each([400, 401, 403, 404, 409])("リトライ不能ステータス: %s", (status) => {
    expect(isRetryableError(awsError("SomeError", status))).toBe(false);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["空オブジェクト", {}],
    ["一般エラー", new Error("boom")],
  ])("リトライ対象外: %s", (_name, value) => {
    expect(isRetryableError(value)).toBe(false);
  });

  it("AbortError はリトライしない", () => {
    expect(isRetryableError(awsError("AbortError", 500))).toBe(false);
  });

  it("$retryable を持つエラーはリトライする", () => {
    expect(isRetryableError({ name: "Unknown", $retryable: { throttling: true } })).toBe(
      true,
    );
  });

  it("Node.js のネットワークエラーはリトライする", () => {
    expect(isRetryableError(nodeError("ECONNRESET"))).toBe(true);
    expect(isRetryableError(nodeError("ETIMEDOUT"))).toBe(true);
  });

  it("未知の Node.js エラーコードはリトライしない", () => {
    expect(isRetryableError(nodeError("ENOENT"))).toBe(false);
  });
});

// ── 待機時間の計算 ─────────────────────────────────────────────

describe("computeDelay", () => {
  it.each([
    [1, 100],
    [2, 200],
    [3, 400],
    [4, 800],
    [5, 1600],
  ])("ジッター無効: attempt=%i → %i ms", (attempt, expected) => {
    expect(computeDelay(attempt, NO_JITTER)).toBe(expected);
  });

  it("maxDelayMs で頭打ちになる", () => {
    const config: RetryConfig = {
      maxAttempts: 10,
      baseDelayMs: 100,
      maxDelayMs: 500,
      jitter: false,
    };
    expect(computeDelay(3, config)).toBe(400);
    expect(computeDelay(4, config)).toBe(500);
    expect(computeDelay(9, config)).toBe(500);
  });

  it("巨大な attempt でも Infinity にならない", () => {
    const config: RetryConfig = {
      maxAttempts: 1000,
      baseDelayMs: 100,
      maxDelayMs: 30_000,
      jitter: false,
    };
    for (const attempt of [100, 1000, 1_000_000]) {
      expect(computeDelay(attempt, config)).toBe(30_000);
    }
  });

  it.each([0, -1, -100])("attempt が 1 未満なら 1 として扱う: %i", (attempt) => {
    expect(computeDelay(attempt, NO_JITTER)).toBe(computeDelay(1, NO_JITTER));
  });

  it("小数の attempt は切り捨てる", () => {
    expect(computeDelay(2.9, NO_JITTER)).toBe(computeDelay(2, NO_JITTER));
  });

  it.each([
    [0, 0],
    [0.25, 100],
    [0.5, 200],
    [1, 400],
  ])("フルジッター: rand=%s → %i ms", (rand, expected) => {
    const config: RetryConfig = { ...NO_JITTER, jitter: true };
    expect(computeDelay(3, config, () => rand)).toBe(expected);
  });

  it("ジッターありでも常に 0〜maxDelayMs の範囲", () => {
    const config: RetryConfig = {
      maxAttempts: 20,
      baseDelayMs: 50,
      maxDelayMs: 3000,
      jitter: true,
    };
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      for (const r of [0, 0.33, 0.5, 0.99, 1]) {
        const value = computeDelay(attempt, config, () => r);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(3000);
      }
    }
  });

  it("既定設定でも計算できる", () => {
    const value = computeDelay(1);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(DEFAULT_RETRY_CONFIG.baseDelayMs);
  });
});

// ── delay ──────────────────────────────────────────────────────

describe("delay", () => {
  it("指定時間後に解決する", async () => {
    await expect(delay(1)).resolves.toBeUndefined();
  });

  it("0ms でも解決する", async () => {
    await expect(delay(0)).resolves.toBeUndefined();
  });

  it("中断済みシグナルなら即座に AbortError", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(delay(1000, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("待機中に中断されたら AbortError", async () => {
    const controller = new AbortController();
    const promise = delay(10_000, controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });
});

// ── retryAsync ─────────────────────────────────────────────────

describe("retryAsync", () => {
  it("初回成功ならリトライしない", async () => {
    const sleeper = createSleeper();
    const flaky = createFlaky(0, THROTTLING, "ok");

    await expect(
      retryAsync(flaky.fn, { config: NO_JITTER, sleep: sleeper.sleep }),
    ).resolves.toBe("ok");
    expect(flaky.getCalls()).toBe(1);
    expect(sleeper.calls).toEqual([]);
  });

  it("2回失敗後に成功する", async () => {
    const sleeper = createSleeper();
    const flaky = createFlaky(2, THROTTLING, "ok");

    await expect(
      retryAsync(flaky.fn, { config: NO_JITTER, sleep: sleeper.sleep }),
    ).resolves.toBe("ok");
    expect(flaky.getCalls()).toBe(3);
    expect(sleeper.calls).toEqual([100, 200]);
  });

  it("試行回数を使い切ると元のエラーをスローする", async () => {
    const sleeper = createSleeper();
    const flaky = createFlaky(99, THROTTLING, "ok");

    await expect(
      retryAsync(flaky.fn, { config: NO_JITTER, sleep: sleeper.sleep }),
    ).rejects.toBe(THROTTLING);
    expect(flaky.getCalls()).toBe(4);
    expect(sleeper.calls).toEqual([100, 200, 400]);
  });

  it("リトライ不能なエラーは即座にスローする", async () => {
    const sleeper = createSleeper();
    const nonRetryable = awsError("ValidationException", 400);
    const flaky = createFlaky(99, nonRetryable, "ok");

    await expect(
      retryAsync(flaky.fn, { config: NO_JITTER, sleep: sleeper.sleep }),
    ).rejects.toBe(nonRetryable);
    expect(flaky.getCalls()).toBe(1);
    expect(sleeper.calls).toEqual([]);
  });

  it("maxAttempts=1 ならリトライしない", async () => {
    const sleeper = createSleeper();
    const flaky = createFlaky(99, THROTTLING, "ok");

    await expect(
      retryAsync(flaky.fn, {
        config: { ...NO_JITTER, maxAttempts: 1 },
        sleep: sleeper.sleep,
      }),
    ).rejects.toBe(THROTTLING);
    expect(flaky.getCalls()).toBe(1);
    expect(sleeper.calls).toEqual([]);
  });

  it("設定が不正なら実行前に RangeError", async () => {
    const flaky = createFlaky(0, THROTTLING, "ok");

    await expect(
      retryAsync(flaky.fn, { config: { maxAttempts: 0 } }),
    ).rejects.toThrow(RangeError);
    expect(flaky.getCalls()).toBe(0);
  });

  it("onRetry がリトライ直前に呼ばれる", async () => {
    const sleeper = createSleeper();
    const events: Array<[number, number]> = [];
    const flaky = createFlaky(2, THROTTLING, "ok");

    await retryAsync(flaky.fn, {
      config: NO_JITTER,
      sleep: sleeper.sleep,
      onRetry: (attempt, delayMs) => events.push([attempt, delayMs]),
    });

    expect(events).toEqual([
      [1, 100],
      [2, 200],
    ]);
  });

  it("onRetry は成功時に呼ばれない", async () => {
    const onRetry = jest.fn();
    await retryAsync(createFlaky(0, THROTTLING, "ok").fn, {
      config: NO_JITTER,
      onRetry,
    });
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("onRetry は最終失敗時には呼ばれない", async () => {
    const onRetry = jest.fn();
    const config: RetryConfig = { ...NO_JITTER, maxAttempts: 3 };

    await expect(
      retryAsync(createFlaky(99, THROTTLING, "ok").fn, {
        config,
        sleep: createSleeper().sleep,
        onRetry,
      }),
    ).rejects.toBe(THROTTLING);

    // 3 回試行 = リトライは 2 回のみ
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("rand が待機時間に反映される", async () => {
    const sleeper = createSleeper();
    await retryAsync(createFlaky(2, THROTTLING, "ok").fn, {
      config: { ...NO_JITTER, jitter: true, baseDelayMs: 200 },
      sleep: sleeper.sleep,
      rand: () => 0.5,
    });
    expect(sleeper.calls).toEqual([100, 200]);
  });

  it("待機時間は単調増加する", async () => {
    const sleeper = createSleeper();
    await expect(
      retryAsync(createFlaky(99, THROTTLING, "ok").fn, {
        config: { ...NO_JITTER, maxAttempts: 5 },
        sleep: sleeper.sleep,
      }),
    ).rejects.toBe(THROTTLING);

    expect(sleeper.calls).toEqual([...sleeper.calls].sort((a, b) => a - b));
    expect(sleeper.calls).toEqual([100, 200, 400, 800]);
  });

  it("中断済みシグナルなら実行しない", async () => {
    const controller = new AbortController();
    controller.abort();
    const flaky = createFlaky(0, THROTTLING, "ok");

    await expect(
      retryAsync(flaky.fn, { config: NO_JITTER, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(flaky.getCalls()).toBe(0);
  });

  it("戻り値をそのまま返す", async () => {
    await expect(
      retryAsync(async () => ({ items: [1, 2, 3] }), { config: NO_JITTER }),
    ).resolves.toEqual({ items: [1, 2, 3] });
  });

  it("undefined を返す関数も扱える", async () => {
    await expect(
      retryAsync(async () => undefined, { config: NO_JITTER }),
    ).resolves.toBeUndefined();
  });

  it("HTTP 503 でリトライする", async () => {
    const sleeper = createSleeper();
    const flaky = createFlaky(1, awsError("Whatever", 503), "ok");

    await expect(
      retryAsync(flaky.fn, { config: NO_JITTER, sleep: sleeper.sleep }),
    ).resolves.toBe("ok");
    expect(flaky.getCalls()).toBe(2);
  });

  it("オプション未指定でも動作する（既定は実待機）", async () => {
    await expect(retryAsync(async () => "ok")).resolves.toBe("ok");
  });
});

// ── withRetry ──────────────────────────────────────────────────

describe("withRetry", () => {
  it("引数をそのまま渡す", async () => {
    const add = withRetry(async (a: number, b: number) => a + b, {
      config: NO_JITTER,
    });
    await expect(add(1, 2)).resolves.toBe(3);
  });

  it("リトライが働く", async () => {
    const sleeper = createSleeper();
    let calls = 0;
    const flaky = withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw THROTTLING;
        return "ok";
      },
      { config: NO_JITTER, sleep: sleeper.sleep },
    );

    await expect(flaky()).resolves.toBe("ok");
    expect(calls).toBe(3);
    expect(sleeper.calls).toEqual([100, 200]);
  });

  it("リトライ不能なエラーはそのままスローする", async () => {
    const nonRetryable = awsError("AccessDeniedException", 403);
    const broken = withRetry(
      async () => {
        throw nonRetryable;
      },
      { config: NO_JITTER, sleep: createSleeper().sleep },
    );

    await expect(broken()).rejects.toBe(nonRetryable);
  });

  it("同じラッパーを複数回呼べる", async () => {
    const echo = withRetry(async (value: string) => value, { config: NO_JITTER });
    await expect(echo("a")).resolves.toBe("a");
    await expect(echo("b")).resolves.toBe("b");
  });
});

import {
  MAX_DIMENSION_KEYS,
  MAX_DIMENSION_VALUE_LENGTH,
  MAX_METRICS_PER_DOCUMENT,
  MAX_NAME_LENGTH,
  MAX_VALUES_PER_METRIC,
  METRIC_UNITS,
  RESERVED_ROOT_KEY,
  createMetrics,
  retryMetrics,
  type Metrics,
  type MetricUnit,
} from "./metrics";
import { createLogger, retryLogger } from "./logger";

// ── テスト用ヘルパー ──────────────────────────────────────────

/** テストで使う固定時刻（エポックミリ秒） */
const FIXED_NOW = Date.UTC(2026, 8, 14, 12, 0, 0);

interface Harness {
  metrics: Metrics;
  lines: string[];
  docs(): Record<string, unknown>[];
  setNow(ms: number): void;
}

function createHarness(dimensions?: Record<string, string>): Harness {
  const lines: string[] = [];
  let current = FIXED_NOW;
  const metrics = createMetrics({
    namespace: "TestNamespace",
    dimensions,
    sink: (line) => lines.push(line),
    now: () => current,
  });
  return {
    metrics,
    lines,
    docs: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
    setNow: (ms) => {
      current = ms;
    },
  };
}

function directiveOf(doc: Record<string, unknown>): Record<string, unknown> {
  const aws = doc[RESERVED_ROOT_KEY] as Record<string, unknown>;
  const list = aws.CloudWatchMetrics as Record<string, unknown>[];
  return list[0];
}

function metricNamesOf(doc: Record<string, unknown>): string[] {
  const defs = directiveOf(doc).Metrics as { Name: string }[];
  return defs.map((d) => d.Name);
}

function dimensionKeysOf(doc: Record<string, unknown>): string[] {
  return (directiveOf(doc).Dimensions as string[][])[0];
}

// ── 生成 ──────────────────────────────────────────────────────

describe("createMetrics", () => {
  it.each(["", "   ", "\t"])("空の名前空間 %p を拒否する", (ns) => {
    expect(() => createMetrics({ namespace: ns })).toThrow(TypeError);
  });

  it("長すぎる名前空間を拒否する", () => {
    expect(() =>
      createMetrics({ namespace: "a".repeat(MAX_NAME_LENGTH + 1) }),
    ).toThrow(RangeError);
  });

  it("名前空間の前後の空白を落とす", () => {
    expect(createMetrics({ namespace: "  NS  " }).namespace).toBe("NS");
  });

  it("不正な既定ディメンションを拒否する", () => {
    expect(() =>
      createMetrics({ namespace: "NS", dimensions: { Service: "" } }),
    ).toThrow(TypeError);
  });
});

// ── 出力の基本形 ──────────────────────────────────────────────

describe("flush", () => {
  it("EMF ドキュメントを 1 行で出力する", () => {
    const h = createHarness({ Service: "items" });
    h.metrics.putMetric("Latency", 12.5, { unit: "Milliseconds" });
    h.metrics.flush();

    expect(h.lines).toHaveLength(1);
    const doc = h.docs()[0];
    expect(doc.Latency).toBe(12.5);
    expect(doc.Service).toBe("items");
    expect(directiveOf(doc).Namespace).toBe("TestNamespace");
  });

  it("Timestamp をエポック秒ではなくミリ秒で出す", () => {
    const h = createHarness();
    h.metrics.count("Requests");
    h.metrics.flush();

    const aws = h.docs()[0][RESERVED_ROOT_KEY] as { Timestamp: number };
    expect(aws.Timestamp).toBe(FIXED_NOW);
    expect(aws.Timestamp).not.toBe(Math.floor(FIXED_NOW / 1000));
  });

  it("メトリクスが 0 件なら何も出力しない", () => {
    const h = createHarness();
    h.metrics.flush();
    expect(h.lines).toHaveLength(0);
  });

  it("flush 後もディメンションは保持し、メトリクスはリセットする", () => {
    const h = createHarness({ Service: "items" });
    h.metrics.count("A");
    h.metrics.flush();
    h.metrics.count("B");
    h.metrics.flush();

    const docs = h.docs();
    expect(docs).toHaveLength(2);
    expect(docs[1]).not.toHaveProperty("A");
    expect(docs[1].Service).toBe("items");
  });
});

// ── 値の積み上げ ──────────────────────────────────────────────

describe("putMetric", () => {
  it("同じ名前の値を配列に積み上げる", () => {
    const h = createHarness();
    [1, 2, 3].forEach((v) => h.metrics.putMetric("Latency", v));
    h.metrics.flush();
    expect(h.docs()[0].Latency).toEqual([1, 2, 3]);
  });

  it("値が 1 件ならスカラーで出す", () => {
    const h = createHarness();
    h.metrics.putMetric("Latency", 42);
    h.metrics.flush();
    expect(h.docs()[0].Latency).toBe(42);
  });

  it("メトリクスの追加順を保つ", () => {
    const h = createHarness();
    ["C", "A", "B"].forEach((n) => h.metrics.count(n));
    h.metrics.flush();
    expect(metricNamesOf(h.docs()[0])).toEqual(["C", "A", "B"]);
  });

  it("負の値とゼロを受け付ける", () => {
    const h = createHarness();
    expect(() => h.metrics.putMetric("Delta", -1)).not.toThrow();
    expect(() => h.metrics.putMetric("Zero", 0)).not.toThrow();
  });
});

// ── バリデーション ────────────────────────────────────────────

describe("バリデーション", () => {
  it.each([
    ["空文字", ""],
    ["予約キー", RESERVED_ROOT_KEY],
    ["長すぎる名前", "a".repeat(MAX_NAME_LENGTH + 1)],
  ])("%s のメトリクス名を拒否する", (_label, name) => {
    const h = createHarness();
    expect(() => h.metrics.putMetric(name, 1)).toThrow();
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("%s を拒否する", (_label, value) => {
    const h = createHarness();
    expect(() => h.metrics.putMetric("X", value)).toThrow(TypeError);
  });

  it("単位の大文字小文字を区別する", () => {
    const h = createHarness();
    expect(() =>
      h.metrics.putMetric("X", 1, { unit: "milliseconds" as MetricUnit }),
    ).toThrow(TypeError);
  });

  it("存在しない単位を拒否する", () => {
    const h = createHarness();
    expect(() =>
      h.metrics.putMetric("X", 1, { unit: "Furlongs" as MetricUnit }),
    ).toThrow(TypeError);
  });

  it.each(METRIC_UNITS)("正当な単位 %s を受け付ける", (unit) => {
    const h = createHarness();
    expect(() => h.metrics.putMetric("X", 1, { unit })).not.toThrow();
  });
});

// ── 単位・解像度の出力 ────────────────────────────────────────

describe("単位と解像度", () => {
  it("既定単位 None を出力から省略する", () => {
    const h = createHarness();
    h.metrics.putMetric("Plain", 1);
    h.metrics.flush();
    const def = (directiveOf(h.docs()[0]).Metrics as Record<string, unknown>[])[0];
    expect(def).not.toHaveProperty("Unit");
  });

  it("高解像度のときだけ StorageResolution を出す", () => {
    const h = createHarness();
    h.metrics.putMetric("Fast", 1, { highResolution: true });
    h.metrics.putMetric("Normal", 1);
    h.metrics.flush();

    const defs = directiveOf(h.docs()[0]).Metrics as Record<string, unknown>[];
    const fast = defs.find((d) => d.Name === "Fast");
    const normal = defs.find((d) => d.Name === "Normal");
    expect(fast).toHaveProperty("StorageResolution", 1);
    expect(normal).not.toHaveProperty("StorageResolution");
  });
});

// ── ディメンション ────────────────────────────────────────────

describe("setDimensions", () => {
  it("キー数の上限を超えたら拒否する", () => {
    const h = createHarness();
    const dims: Record<string, string> = {};
    for (let i = 0; i <= MAX_DIMENSION_KEYS; i += 1) dims[`k${i}`] = "v";
    expect(() => h.metrics.setDimensions(dims)).toThrow(RangeError);
  });

  it("予約キーを拒否する", () => {
    const h = createHarness();
    expect(() =>
      h.metrics.setDimensions({ [RESERVED_ROOT_KEY]: "x" }),
    ).toThrow(TypeError);
  });

  it("長すぎる値を拒否する", () => {
    const h = createHarness();
    expect(() =>
      h.metrics.setDimensions({ k: "v".repeat(MAX_DIMENSION_VALUE_LENGTH + 1) }),
    ).toThrow(RangeError);
  });

  it("キーを辞書順で出力する", () => {
    const h = createHarness({ Z: "1", A: "2", M: "3" });
    h.metrics.count("X");
    h.metrics.flush();
    expect(dimensionKeysOf(h.docs()[0])).toEqual(["A", "M", "Z"]);
  });

  it("ディメンションが無くても DimensionSet を 1 つ出す", () => {
    const h = createHarness();
    h.metrics.count("X");
    h.metrics.flush();
    expect(directiveOf(h.docs()[0]).Dimensions).toEqual([[]]);
  });
});

// ── 名前の衝突検出 ────────────────────────────────────────────

describe("名前の衝突", () => {
  it("ディメンション名と同じメトリクス名を拒否する", () => {
    const h = createHarness({ Service: "items" });
    expect(() => h.metrics.putMetric("Service", 1)).toThrow(TypeError);
  });

  it("メトリクス名と同じディメンション名を拒否する", () => {
    const h = createHarness();
    h.metrics.count("Latency");
    expect(() => h.metrics.setDimensions({ Latency: "x" })).toThrow(TypeError);
  });

  it("メトリクス名と同じプロパティ名を拒否する", () => {
    const h = createHarness();
    h.metrics.count("Latency");
    expect(() => h.metrics.setProperty("Latency", "x")).toThrow(TypeError);
  });

  it("ディメンション名と同じプロパティ名を拒否する", () => {
    const h = createHarness({ Service: "items" });
    expect(() => h.metrics.setProperty("Service", "x")).toThrow(TypeError);
  });

  it("プロパティ名と同じメトリクス名を拒否する", () => {
    const h = createHarness();
    h.metrics.setProperty("requestId", "abc");
    expect(() => h.metrics.putMetric("requestId", 1)).toThrow(TypeError);
  });
});

// ── プロパティ ────────────────────────────────────────────────

describe("setProperty", () => {
  it("ルートに載せるがメトリクス定義には含めない", () => {
    const h = createHarness();
    h.metrics.setProperty("requestId", "abc-123");
    h.metrics.count("Requests");
    h.metrics.flush();

    const doc = h.docs()[0];
    expect(doc.requestId).toBe("abc-123");
    expect(metricNamesOf(doc)).not.toContain("requestId");
  });

  it("空キー・予約キーを拒否する", () => {
    const h = createHarness();
    expect(() => h.metrics.setProperty("", 1)).toThrow(TypeError);
    expect(() => h.metrics.setProperty(RESERVED_ROOT_KEY, 1)).toThrow(TypeError);
  });
});

// ── 上限到達時の自動 flush ────────────────────────────────────

describe("上限到達時の自動 flush", () => {
  it("値の上限を超えたら自動で flush する", () => {
    const h = createHarness();
    for (let i = 0; i < MAX_VALUES_PER_METRIC + 1; i += 1) {
      h.metrics.putMetric("Latency", i);
    }
    expect(h.lines).toHaveLength(1);
    expect(h.docs()[0].Latency).toHaveLength(MAX_VALUES_PER_METRIC);
  });

  it("メトリクス定義の上限を超えたら自動で flush する", () => {
    const h = createHarness();
    for (let i = 0; i < MAX_METRICS_PER_DOCUMENT + 1; i += 1) {
      h.metrics.count(`M${String(i).padStart(3, "0")}`);
    }
    expect(h.lines).toHaveLength(1);
    expect(metricNamesOf(h.docs()[0])).toHaveLength(MAX_METRICS_PER_DOCUMENT);
  });

  it("上限到達は例外にしない", () => {
    const h = createHarness();
    expect(() => {
      for (let i = 0; i < MAX_VALUES_PER_METRIC * 2; i += 1) {
        h.metrics.putMetric("Latency", i);
      }
    }).not.toThrow();
  });
});

// ── 糖衣 ──────────────────────────────────────────────────────

describe("糖衣メソッド", () => {
  it("count は単位 Count・既定値 1 を使う", () => {
    const h = createHarness();
    h.metrics.count("Requests");
    h.metrics.flush();
    const doc = h.docs()[0];
    expect(doc.Requests).toBe(1);
    const def = (directiveOf(doc).Metrics as Record<string, unknown>[])[0];
    expect(def.Unit).toBe("Count");
  });

  it("duration は単位 Milliseconds を使う", () => {
    const h = createHarness();
    h.metrics.duration("Latency", 1500);
    h.metrics.flush();
    const def = (directiveOf(h.docs()[0]).Metrics as Record<string, unknown>[])[0];
    expect(def.Unit).toBe("Milliseconds");
  });

  it("timer は注入した時計で計測する", () => {
    const h = createHarness();
    const stop = h.metrics.timer("Elapsed");
    h.setNow(FIXED_NOW + 250);
    stop();
    h.metrics.flush();
    expect(h.docs()[0].Elapsed).toBe(250);
  });
});

// ── リトライ層との結線 ────────────────────────────────────────

describe("retryMetrics", () => {
  it("リトライの試行回数と待機時間を記録する", () => {
    const h = createHarness();
    retryMetrics(h.metrics, "PutItem")(1, 200, new Error("throttled"));
    h.metrics.flush();

    const doc = h.docs()[0];
    expect(doc.RetryAttempt).toBe(1);
    expect(doc.RetryDelay).toBe(200);
    expect(doc.RetryAttemptNumber).toBe(1);
    expect(doc.retryOperation).toBe("PutItem");
  });

  it("操作名はディメンションにしない", () => {
    const h = createHarness();
    retryMetrics(h.metrics, "PutItem")(1, 200, new Error("x"));
    h.metrics.flush();
    expect(dimensionKeysOf(h.docs()[0])).not.toContain("retryOperation");
  });

  it("記録に失敗しても例外を投げない", () => {
    const h = createHarness();
    // メトリクス名を先取りして衝突させ、内部で例外が出る状況を作る
    h.metrics.setDimensions({ RetryAttempt: "x" });
    expect(() =>
      retryMetrics(h.metrics, "PutItem")(1, 200, new Error("x")),
    ).not.toThrow();
  });

  it("retryLogger と同じシグネチャを持つ", () => {
    const h = createHarness();
    const fromMetrics: (a: number, d: number, e: unknown) => void = retryMetrics(
      h.metrics,
      "op",
    );
    const fromLogger: (a: number, d: number, e: unknown) => void = retryLogger(
      createLogger({ sink: () => undefined }),
      "op",
    );
    expect(typeof fromMetrics).toBe("function");
    expect(typeof fromLogger).toBe("function");
  });
});

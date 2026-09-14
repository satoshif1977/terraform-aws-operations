/**
 * metrics.ts: CloudWatch EMF（Embedded Metric Format）メトリクスユーティリティ
 *
 * 標準出力に 1 行の JSON を書くだけで、CloudWatch Logs 側がメトリクスとして
 * 抽出してくれる形式（EMF）でメトリクスを出力する。
 *
 * 同ディレクトリの logger.ts と同じ「AWS 呼び出しの運用品質を揃える」方針の一環。
 * retryMetrics() を retryLogger() と同じ場所に差し込める（シグネチャを揃えてある）。
 * ストリームのアラート通知は通知先の障害でリトライが増えやすい。通知の成否と
 * 所要時間をメトリクス化しておくと運用時の切り分けが速くなる。
 * 同リポジトリの lambda_go/guardduty-notifier/metrics.go（Go 版）と
 * 出力キーを揃えた並置実装。
 *
 * 設計方針:
 * - PutMetricData API を呼ばない。API のレイテンシが処理時間に乗らず、
 *   スロットリングの影響も受けず、追加の IAM 権限も要らない
 * - 上限に達したら例外にせず自動で flush する。メトリクスは副次処理であり、
 *   本処理を落とすほうが害が大きい
 * - 一方で「設定ミス」（空の名前空間・不正な単位など）は即座に例外にする。
 *   CloudWatch は不正な EMF を黙って破棄するため、気づけないまま欠落するほうが有害
 * - NaN / Infinity は受け付けない。JSON.stringify がこれらを null にするため、
 *   メトリクス値が黙って 0 件扱いになる
 * - 高カーディナリティの値は setProperty() で持たせる。ディメンションにすると
 *   値の種類の数だけ課金対象のカスタムメトリクスが作られる
 * - now / sink を差し替え可能にして、テストを決定的に保つ
 *
 * EMF 仕様:
 * https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html
 */

// ── EMF 仕様の上限 ────────────────────────────────────────────

/** 1 つの MetricDirective に入れられるメトリクス定義の数 */
export const MAX_METRICS_PER_DOCUMENT = 100;
/** 1 メトリクスあたりの値配列の長さ */
export const MAX_VALUES_PER_METRIC = 100;
/** 1 つの DimensionSet に入れられるキー数 */
export const MAX_DIMENSION_KEYS = 30;
/** 1 ログイベントのサイズ上限（1 MB） */
export const MAX_EVENT_BYTES = 1024 * 1024;

/** メトリクス名・名前空間の長さ上限 */
export const MAX_NAME_LENGTH = 1024;
/** ディメンションキー名の長さ上限 */
export const MAX_DIMENSION_KEY_LENGTH = 250;
/** ディメンション値の長さ上限 */
export const MAX_DIMENSION_VALUE_LENGTH = 1024;

/** EMF が予約しているルートキー */
export const RESERVED_ROOT_KEY = "_aws";

// ── 単位 ──────────────────────────────────────────────────────

/** CloudWatch が受け付ける単位。大文字小文字を区別する */
export const METRIC_UNITS = [
  "Seconds",
  "Microseconds",
  "Milliseconds",
  "Bytes",
  "Kilobytes",
  "Megabytes",
  "Gigabytes",
  "Terabytes",
  "Bits",
  "Kilobits",
  "Megabits",
  "Gigabits",
  "Terabits",
  "Percent",
  "Count",
  "Bytes/Second",
  "Count/Second",
  "Seconds/Count",
  "None",
] as const;

export type MetricUnit = (typeof METRIC_UNITS)[number];

const VALID_UNITS: ReadonlySet<string> = new Set(METRIC_UNITS);

/** 既定の単位。出力時は省略される */
export const DEFAULT_UNIT: MetricUnit = "None";
/** 標準解像度（秒） */
export const STANDARD_RESOLUTION = 60;
/** 高解像度（秒） */
export const HIGH_RESOLUTION = 1;

// ── 型 ────────────────────────────────────────────────────────

/** 出力先。既定では console.log */
export type MetricsSink = (line: string) => void;

export interface MetricsOptions {
  /** CloudWatch の名前空間。必須 */
  namespace: string;
  /** 全メトリクスに付与する既定のディメンション */
  dimensions?: Record<string, string>;
  /** 出力先。既定では console.log */
  sink?: MetricsSink;
  /** 現在時刻をエポックミリ秒で返す関数。テストで差し替える */
  now?: () => number;
}

export interface PutMetricOptions {
  unit?: MetricUnit;
  /** 高解像度（1秒）メトリクスにする場合は true */
  highResolution?: boolean;
}

export interface Metrics {
  readonly namespace: string;
  putMetric(name: string, value: number, options?: PutMetricOptions): void;
  /** 件数系メトリクス（単位 Count）の糖衣 */
  count(name: string, value?: number): void;
  /** 経過時間をミリ秒で記録する糖衣 */
  duration(name: string, ms: number): void;
  /** 計測を開始し、停止用の関数を返す */
  timer(name: string): () => void;
  setDimensions(dimensions: Record<string, string>): void;
  /** メトリクス化しない付帯情報を載せる */
  setProperty(key: string, value: unknown): void;
  flush(): void;
}

/** 既定のシンク */
export const consoleMetricsSink: MetricsSink = (line) => {
  console.log(line);
};

// ── 検証 ──────────────────────────────────────────────────────

function assertMetricName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("metrics: メトリクス名が空です");
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new RangeError(
      `metrics: メトリクス名が長すぎます（${name.length} 文字・上限 ${MAX_NAME_LENGTH}）`,
    );
  }
  if (name === RESERVED_ROOT_KEY) {
    throw new TypeError(`metrics: "${RESERVED_ROOT_KEY}" は EMF の予約キーです`);
  }
}

function assertDimension(key: string, value: string): void {
  if (key.length === 0 || key.length > MAX_DIMENSION_KEY_LENGTH) {
    throw new RangeError(`metrics: ディメンションキーの長さが不正です: "${key}"`);
  }
  if (key === RESERVED_ROOT_KEY) {
    throw new TypeError(`metrics: "${RESERVED_ROOT_KEY}" は EMF の予約キーです`);
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`metrics: ディメンション値が空です（キー "${key}"）`);
  }
  if (value.length > MAX_DIMENSION_VALUE_LENGTH) {
    throw new RangeError(`metrics: ディメンション値が長すぎます（キー "${key}"）`);
  }
}

function assertValue(name: string, value: number): void {
  if (typeof value !== "number") {
    throw new TypeError(`metrics: メトリクス "${name}" の値が数値ではありません`);
  }
  if (Number.isNaN(value) || !Number.isFinite(value)) {
    // JSON.stringify は NaN / Infinity を null にする。値が黙って欠落するため入口で弾く。
    throw new TypeError(
      `metrics: メトリクス "${name}" の値が NaN または Infinity です`,
    );
  }
}

// ── 本体 ──────────────────────────────────────────────────────

interface MetricDefinition {
  name: string;
  unit: MetricUnit;
  storageResolution: number;
  values: number[];
}

/**
 * EMF メトリクスレコーダを生成する。
 *
 * 使用例:
 *   const metrics = createMetrics({
 *     namespace: "ServerlessApi",
 *     dimensions: { Service: "items", Stage: process.env.STAGE ?? "dev" },
 *   });
 *   const stop = metrics.timer("Latency");
 *   ...
 *   stop();
 *   metrics.count("ItemsCreated");
 *   metrics.setProperty("requestId", requestId);
 *   metrics.flush();
 */
export function createMetrics(options: MetricsOptions): Metrics {
  const namespace = (options.namespace ?? "").trim();
  if (namespace.length === 0) {
    throw new TypeError("metrics: 名前空間が空です");
  }
  if (namespace.length > MAX_NAME_LENGTH) {
    throw new RangeError(
      `metrics: 名前空間が長すぎます（${namespace.length} 文字・上限 ${MAX_NAME_LENGTH}）`,
    );
  }

  const sink = options.sink ?? consoleMetricsSink;
  const now = options.now ?? (() => Date.now());

  let dimensions: Record<string, string> = {};
  const properties = new Map<string, unknown>();
  // 追加順を保ちたいので Map を使う（出力を決定的にするため）
  const definitions = new Map<string, MetricDefinition>();

  function setDimensions(next: Record<string, string>): void {
    const keys = Object.keys(next);
    if (keys.length > MAX_DIMENSION_KEYS) {
      throw new RangeError(
        `metrics: ディメンションのキー数が上限を超えています（${keys.length}・上限 ${MAX_DIMENSION_KEYS}）`,
      );
    }
    for (const key of keys) {
      assertDimension(key, next[key]);
      // メトリクス名とディメンション名は EMF ではどちらもルート直下に載るため、
      // 衝突すると片方が黙って上書きされる。検出して例外にする。
      if (definitions.has(key)) {
        throw new TypeError(
          `metrics: ディメンション名がメトリクス名と衝突しています: "${key}"`,
        );
      }
    }
    dimensions = { ...next };
  }

  function setProperty(key: string, value: unknown): void {
    if (typeof key !== "string" || key.length === 0) {
      throw new TypeError("metrics: プロパティのキーが空です");
    }
    if (key === RESERVED_ROOT_KEY) {
      throw new TypeError(`metrics: "${RESERVED_ROOT_KEY}" は EMF の予約キーです`);
    }
    if (definitions.has(key)) {
      throw new TypeError(
        `metrics: プロパティ名がメトリクス名と衝突しています: "${key}"`,
      );
    }
    if (key in dimensions) {
      throw new TypeError(
        `metrics: プロパティ名がディメンション名と衝突しています: "${key}"`,
      );
    }
    properties.set(key, value);
  }

  function buildDocument(): Record<string, unknown> {
    const doc: Record<string, unknown> = {};
    const metricDefs: Record<string, unknown>[] = [];

    for (const def of definitions.values()) {
      const entry: Record<string, unknown> = { Name: def.name };
      // 既定値は EMF 側の既定と一致するので省略し、1 行を小さく保つ。
      if (def.unit !== DEFAULT_UNIT) entry.Unit = def.unit;
      if (def.storageResolution === HIGH_RESOLUTION) {
        entry.StorageResolution = HIGH_RESOLUTION;
      }
      metricDefs.push(entry);
      doc[def.name] = def.values.length === 1 ? def.values[0] : def.values;
    }

    const dimensionKeys = Object.keys(dimensions).sort();
    for (const key of dimensionKeys) doc[key] = dimensions[key];
    for (const [key, value] of properties) doc[key] = value;

    doc[RESERVED_ROOT_KEY] = {
      // EMF の Timestamp はエポック「ミリ秒」。秒で入れると無効な文書になる。
      Timestamp: now(),
      CloudWatchMetrics: [
        {
          Namespace: namespace,
          // ディメンションが無い場合も空の DimensionSet を 1 つ置く。
          // キーを省略すると CloudWatch 側でメトリクスが抽出されない。
          Dimensions: [dimensionKeys],
          Metrics: metricDefs,
        },
      ],
    };
    return doc;
  }

  function flush(): void {
    if (definitions.size === 0) return;
    const doc = buildDocument();
    definitions.clear();

    const line = JSON.stringify(doc);
    if (line.length > MAX_EVENT_BYTES) {
      throw new RangeError(
        `metrics: EMF ドキュメントが 1 MB を超えました（${line.length} バイト）`,
      );
    }
    sink(line);
  }

  function putMetric(
    name: string,
    value: number,
    opts: PutMetricOptions = {},
  ): void {
    assertMetricName(name);
    assertValue(name, value);

    const unit = opts.unit ?? DEFAULT_UNIT;
    if (!VALID_UNITS.has(unit)) {
      throw new TypeError(
        `metrics: 単位 "${unit}" は CloudWatch がサポートしていません`,
      );
    }
    const storageResolution = opts.highResolution
      ? HIGH_RESOLUTION
      : STANDARD_RESOLUTION;

    if (name in dimensions) {
      throw new TypeError(
        `metrics: メトリクス名がディメンション名と衝突しています: "${name}"`,
      );
    }
    if (properties.has(name)) {
      throw new TypeError(
        `metrics: メトリクス名がプロパティ名と衝突しています: "${name}"`,
      );
    }

    const existing = definitions.get(name);
    // 上限到達は異常ではなく想定内。落とさずに区切って続ける。
    if (existing && existing.values.length >= MAX_VALUES_PER_METRIC) {
      flush();
    } else if (!existing && definitions.size >= MAX_METRICS_PER_DOCUMENT) {
      flush();
    }

    const current = definitions.get(name);
    if (current) {
      current.values.push(value);
      return;
    }
    definitions.set(name, { name, unit, storageResolution, values: [value] });
  }

  if (options.dimensions) setDimensions(options.dimensions);

  return {
    namespace,
    putMetric,
    count(name: string, value = 1) {
      putMetric(name, value, { unit: "Count" });
    },
    duration(name: string, ms: number) {
      putMetric(name, ms, { unit: "Milliseconds" });
    },
    timer(name: string) {
      const start = now();
      return () => {
        putMetric(name, now() - start, { unit: "Milliseconds" });
      };
    },
    setDimensions,
    setProperty,
    flush,
  };
}

// ── リトライ層との結線 ────────────────────────────────────────

/**
 * リトライ発生時にメトリクスを記録するコールバックを返す。
 * logger.ts の retryLogger() と同じシグネチャなので、
 * withRetry の onRetry に同じように渡せる。
 *
 * 操作名はディメンションではなくプロパティとして持たせる。
 * ディメンションにすると呼び出し箇所の数だけ課金対象のメトリクスが増えるため。
 */
export function retryMetrics(
  metrics: Metrics,
  operation: string,
): (attempt: number, delayMs: number, error: unknown) => void {
  return (attempt, delayMs) => {
    // メトリクスは副次処理。ここでの失敗で本処理を止めない。
    try {
      metrics.setProperty("retryOperation", operation);
      metrics.count("RetryAttempt");
      metrics.duration("RetryDelay", Math.round(delayMs));
      metrics.putMetric("RetryAttemptNumber", attempt, { unit: "Count" });
    } catch {
      // 握りつぶす（記録できないこと自体は本処理の失敗ではない）
    }
  };
}

/**
 * AWS API 呼び出し向け リトライユーティリティ（TypeScript 版）
 *
 * SNS の Publish がスロットリング（ThrottlingException）や一時的な 5xx で
 * 失敗したときに、AWS 公式推奨の「指数バックオフ + フルジッター」方式で
 * 自動リトライする。GuardDuty の検知結果を通知する経路なので、1 回の失敗で
 * 通知が落ちると、検知そのものが誰にも気づかれないまま終わってしまう。
 *
 * 同リポジトリの Go 版（lambda_go/guardduty-notifier/retry.go）と同じ設計思想の
 * 並置実装。logger.ts の retryLogger() / metrics.ts の retryMetrics() を
 * onRetry に渡すとリトライ発生を記録できる（どちらも同じシグネチャ）。
 *
 * 設計方針:
 *   - sleep / rand を注入可能にして、テストを決定的かつ実待機ゼロに保つ
 *   - リトライ不能なエラー（ValidationException / GoneException 等）は即座に再スローする
 *   - 最終試行でも失敗した場合は元のエラーをそのままスローする
 *     （呼び出し側の instanceof 判定を壊さないため、独自例外で包まない）
 *   - AbortSignal でリトライ全体を中断できる
 */

// ── リトライ対象の判定基準 ────────────────────────────────────

/** AWS が「時間をおけば成功しうる」と定義するエラーコード群 */
export const RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  // スロットリング系
  "ThrottlingException",
  "Throttling",
  "ThrottledException",
  "TooManyRequestsException",
  "RequestLimitExceeded",
  "ProvisionedThroughputExceededException",
  "SlowDown",
  // サーバ側の一時障害
  "InternalServerException",
  "InternalServerError",
  "InternalFailure",
  "ServiceUnavailable",
  "ServiceUnavailableException",
  // タイムアウト系
  "RequestTimeout",
  "RequestTimeoutException",
  "ModelTimeoutException",
  // Bedrock: モデルのウォームアップ待ち
  "ModelNotReadyException",
  // Node.js のネットワーク層エラー
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EPIPE",
  "EAI_AGAIN",
]);

/** ステータスコードだけで判定できる一時エラー（429 / 5xx） */
export const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([
  429, 500, 502, 503, 504,
]);

// ── 型定義 ────────────────────────────────────────────────────

export interface RetryConfig {
  /** 最大試行回数（初回を含む）。1 ならリトライしない */
  maxAttempts: number;
  /** 1 回目のリトライ前の基準待機ミリ秒 */
  baseDelayMs: number;
  /** 指数バックオフの上限ミリ秒（これ以上は待たない） */
  maxDelayMs: number;
  /** true でフルジッター（0〜上限のランダム待機）を有効化 */
  jitter: boolean;
}

export interface RetryOptions {
  config?: Partial<RetryConfig>;
  /** 待機処理。テストでは即時解決する関数を渡す */
  sleep?: (ms: number) => Promise<void>;
  /** 0 以上 1 未満の乱数を返す関数 */
  rand?: () => number;
  /** リトライ直前に呼ばれるコールバック（ログ出力などに使う） */
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
  /** リトライ全体を中断するシグナル */
  signal?: AbortSignal;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  jitter: true,
};

// ── 設定の検証 ────────────────────────────────────────────────

/**
 * リトライ設定の整合性を検証する。不正な場合は RangeError をスローする。
 */
export function validateRetryConfig(config: RetryConfig): void {
  if (!Number.isInteger(config.maxAttempts) || config.maxAttempts < 1) {
    throw new RangeError("maxAttempts は 1 以上の整数で指定してください");
  }
  if (!(config.baseDelayMs > 0) || !Number.isFinite(config.baseDelayMs)) {
    throw new RangeError("baseDelayMs は 0 より大きい有限の数値で指定してください");
  }
  if (!Number.isFinite(config.maxDelayMs) || config.maxDelayMs < config.baseDelayMs) {
    throw new RangeError("maxDelayMs は baseDelayMs 以上の有限の数値で指定してください");
  }
}

/** 部分指定の設定を既定値で補完し、検証したうえで返す */
export function resolveRetryConfig(partial?: Partial<RetryConfig>): RetryConfig {
  const config: RetryConfig = { ...DEFAULT_RETRY_CONFIG, ...partial };
  validateRetryConfig(config);
  return config;
}

// ── エラー情報の抽出 ──────────────────────────────────────────

/**
 * エラーからエラーコードを取り出す。
 *
 * AWS SDK v3 は `name`、Node.js のネットワークエラーは `code` に入るため両方見る。
 */
export function extractErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const e = error as { name?: unknown; code?: unknown };
  if (typeof e.code === "string" && e.code !== "") return e.code;
  if (typeof e.name === "string" && e.name !== "") return e.name;
  return "";
}

/**
 * エラーから HTTP ステータスコードを取り出す。
 *
 * AWS SDK v3 は `$metadata.httpStatusCode`、fetch 由来は `status` に入る。
 */
export function extractStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const e = error as {
    $metadata?: { httpStatusCode?: unknown };
    status?: unknown;
    statusCode?: unknown;
  };
  const fromMetadata = e.$metadata?.httpStatusCode;
  if (typeof fromMetadata === "number") return fromMetadata;
  if (typeof e.status === "number") return e.status;
  if (typeof e.statusCode === "number") return e.statusCode;
  return undefined;
}

/**
 * エラーがリトライ対象かどうかを判定する。
 *
 * AbortError（中断）は待っても回復しないためリトライ対象外とする。
 */
export function isRetryableError(error: unknown): boolean {
  if (error === null || error === undefined) return false;

  const code = extractErrorCode(error);
  if (code === "AbortError") return false;

  // AWS SDK v3 は $retryable.throttling でスロットリングを明示することがある
  if (typeof error === "object") {
    const retryable = (error as { $retryable?: { throttling?: unknown } }).$retryable;
    if (retryable && typeof retryable === "object") return true;
  }

  if (RETRYABLE_ERROR_CODES.has(code)) return true;

  const status = extractStatusCode(error);
  return status !== undefined && RETRYABLE_STATUS_CODES.has(status);
}

// ── 待機時間の計算 ────────────────────────────────────────────

/**
 * 指定回目のリトライ前に待つミリ秒を計算する。
 *
 * attempt は 1 始まり（1 回目のリトライ = 1）。1 未満は 1 として扱う。
 * 指数バックオフ（baseDelayMs * 2^(attempt-1)）を maxDelayMs で頭打ちにし、
 * jitter が有効なら 0〜その値のランダム値に散らす（フルジッター）。
 * 同時に失敗した複数クライアントがリトライで再衝突するのを防ぐ。
 */
export function computeDelay(
  attempt: number,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  rand: () => number = Math.random,
): number {
  const safeAttempt = attempt < 1 ? 1 : Math.floor(attempt);
  // 2^(attempt-1) は attempt が大きいと Infinity になるため先に頭打ちにする
  const exponent = Math.min(safeAttempt - 1, 32);
  const capped = Math.min(config.baseDelayMs * 2 ** exponent, config.maxDelayMs);
  return config.jitter ? capped * rand() : capped;
}

// ── 待機処理 ──────────────────────────────────────────────────

/** AbortSignal を尊重する既定の待機処理 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(createAbortError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function createAbortError(): Error {
  const error = new Error("リトライが中断されました");
  error.name = "AbortError";
  return error;
}

// ── メイン処理 ────────────────────────────────────────────────

/**
 * fn を実行し、リトライ可能なエラーが出たら指数バックオフで再試行する。
 *
 * リトライ不能なエラー・最終試行での失敗は、元のエラーをそのままスローする。
 */
export async function retryAsync<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const config = resolveRetryConfig(options.config);
  const sleep = options.sleep ?? ((ms: number) => delay(ms, options.signal));
  const rand = options.rand ?? Math.random;

  let lastError: unknown;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    if (options.signal?.aborted) throw createAbortError();

    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // リトライ不能、または試行回数を使い切った場合は諦めてスローする
      if (!isRetryableError(error) || attempt >= config.maxAttempts) throw error;

      const delayMs = computeDelay(attempt, config, rand);
      options.onRetry?.(attempt, delayMs, error);
      await sleep(delayMs);
    }
  }

  // maxAttempts >= 1 のため理論上は到達しないが、型と防御のために残す
  throw lastError;
}

/**
 * retryAsync を適用した関数を返すラッパー。
 *
 * 引数はそのまま元の関数に渡される。
 */
export function withRetry<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: RetryOptions = {},
): (...args: TArgs) => Promise<TResult> {
  return (...args: TArgs) => retryAsync(() => fn(...args), options);
}

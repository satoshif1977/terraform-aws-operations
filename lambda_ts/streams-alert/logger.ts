/**
 * 構造化ロギングユーティリティ（TypeScript 版）
 *
 * CloudWatch Logs Insights で検索・集計できるよう、ログを 1 行の JSON として出力する。
 * あわせて、パスワードやトークンなどの機密情報がログに流出しないようマスキングする。
 *
 * 同リポジトリの Go 版リトライ（lambda_go/guardduty-notifier/retry.go）と同じ
 * 「AWS 呼び出しの運用品質を揃える」方針のユーティリティで、
 * retryLogger() でリトライ層と結線できる。
 *
 * 設計方針:
 *   - now / sink を注入可能にして、テストを決定的に保つ（時刻とバッファを固定できる）
 *   - 機密キーは「キー名の部分一致」で判定する。ログ実装側で列挙漏れがあっても
 *     accessKeyId / x-api-key のような派生名を拾えるようにするため
 *   - 循環参照・巨大オブジェクトでログ出力自体が落ちないよう、深さと配列長に上限を設ける
 *     （ログは失敗してはいけない副次処理なので、欠落させてでも本処理を止めない）
 *   - Error は message / name / stack に展開する。JSON.stringify が Error を
 *     `{}` に潰してしまい、障害調査で最も必要な情報が消えるため
 */

// ── ログレベル ────────────────────────────────────────────────

export const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** レベルの重み。数値が大きいほど深刻で、silent は全出力を止める番人として最大値を持つ */
const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/** 出力先を持つ実レベル（silent は出力しないため除く） */
export type EmittableLevel = Exclude<LogLevel, "silent">;

export const DEFAULT_LOG_LEVEL: LogLevel = "info";

/**
 * 文字列をログレベルに変換する。
 *
 * 未知の値・未設定は fallback にフォールバックする。
 * 環境変数の指定ミスでログが全く出なくなる事故を避けるため、例外は投げない。
 */
export function parseLogLevel(
  value: string | undefined | null,
  fallback: LogLevel = DEFAULT_LOG_LEVEL,
): LogLevel {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  // Lambda の環境変数では WARNING / FATAL といった別名も使われる
  if (normalized === "warning") return "warn";
  if (normalized === "fatal" || normalized === "critical") return "error";
  if (normalized === "trace" || normalized === "verbose") return "debug";
  if (normalized === "none" || normalized === "off") return "silent";
  return (LOG_LEVELS as readonly string[]).includes(normalized)
    ? (normalized as LogLevel)
    : fallback;
}

/** entryLevel のログを currentLevel の設定下で出力すべきか判定する */
export function shouldLog(currentLevel: LogLevel, entryLevel: EmittableLevel): boolean {
  if (currentLevel === "silent") return false;
  return LEVEL_WEIGHT[entryLevel] >= LEVEL_WEIGHT[currentLevel];
}

// ── 機密情報のマスキング ──────────────────────────────────────

/**
 * マスキング対象のキー名（小文字・部分一致で判定する）
 *
 * 例: "secret" は "clientSecret" / "SECRET_KEY" にもマッチする。
 */
export const SENSITIVE_KEY_PATTERNS: readonly string[] = [
  "password",
  "passwd",
  "secret",
  "token",
  "authorization",
  "auth",
  "apikey",
  "api_key",
  "accesskey",
  "access_key",
  "privatekey",
  "private_key",
  "credential",
  "cookie",
  "session",
  "signature",
  "pin",
  "ssn",
  "creditcard",
  "card_number",
];

/** マスク後に表示される文字列 */
export const REDACTED = "[REDACTED]";

/** 循環参照を検出した箇所に入る印 */
export const CIRCULAR = "[Circular]";

/** 深さ・要素数の上限を超えて切り詰めた箇所に入る印 */
export const TRUNCATED = "[Truncated]";

export interface RedactOptions {
  /** 追加のマスキング対象キー（部分一致・大文字小文字は無視） */
  extraKeys?: readonly string[];
  /** ネストをたどる最大深さ */
  maxDepth?: number;
  /** 配列を保持する最大要素数 */
  maxArrayLength?: number;
  /** 文字列を保持する最大文字数 */
  maxStringLength?: number;
}

export const DEFAULT_REDACT_OPTIONS: Required<RedactOptions> = {
  extraKeys: [],
  maxDepth: 8,
  maxArrayLength: 100,
  maxStringLength: 2000,
};

/**
 * キー名が機密情報にあたるか判定する。
 *
 * 記号（_ - 空白）を除いた小文字表現で部分一致を見るため、
 * "access-key" / "access_key" / "AccessKey" をまとめて拾える。
 */
export function isSensitiveKey(key: string, extraKeys: readonly string[] = []): boolean {
  const normalize = (s: string): string => s.toLowerCase().replace(/[-_\s]/g, "");
  const normalizedKey = normalize(key);
  if (normalizedKey === "") return false;
  const patterns = [...SENSITIVE_KEY_PATTERNS, ...extraKeys];
  return patterns.some((pattern) => {
    const normalizedPattern = normalize(pattern);
    return normalizedPattern !== "" && normalizedKey.includes(normalizedPattern);
  });
}

/**
 * ログ出力用に値を安全な形へ変換する。
 *
 * - 機密キーの値を [REDACTED] に置換する
 * - 循環参照・深すぎるネスト・長すぎる配列/文字列を切り詰める
 * - Error / Date / Map / Set / BigInt など JSON.stringify が扱えない値を展開する
 *
 * 入力オブジェクトは変更しない（新しい値を返す）。
 */
export function redact(value: unknown, options: RedactOptions = {}): unknown {
  const opts = { ...DEFAULT_REDACT_OPTIONS, ...options };
  // 「現在たどっている経路」を保持する。経路を抜けるときに削除するため、
  // 兄弟位置で同じオブジェクトを参照しても [Circular] にはならない
  // （本物の循環＝自分の祖先を再訪した場合だけを検出する）。
  const seen = new WeakSet<object>();

  const walk = (input: unknown, depth: number, key?: string): unknown => {
    if (key !== undefined && isSensitiveKey(key, opts.extraKeys)) return REDACTED;

    if (input === null || input === undefined) return input;

    switch (typeof input) {
      case "string":
        return input.length > opts.maxStringLength
          ? `${input.slice(0, opts.maxStringLength)}…${TRUNCATED}`
          : input;
      case "number":
        // NaN / Infinity は JSON.stringify が null にしてしまうため文字列で残す
        return Number.isFinite(input) ? input : String(input);
      case "boolean":
        return input;
      case "bigint":
        return `${input.toString()}n`;
      case "function":
        return `[Function: ${input.name || "anonymous"}]`;
      case "symbol":
        return input.toString();
      default:
        break;
    }

    const obj = input as object;

    if (input instanceof Error) {
      return {
        name: input.name,
        message: input.message,
        ...(input.stack ? { stack: input.stack } : {}),
      };
    }
    if (input instanceof Date) {
      return Number.isNaN(input.getTime()) ? "Invalid Date" : input.toISOString();
    }

    if (seen.has(obj)) return CIRCULAR;
    if (depth >= opts.maxDepth) return TRUNCATED;
    seen.add(obj);

    try {
      if (Array.isArray(input)) {
        const kept = input.slice(0, opts.maxArrayLength).map((item) => walk(item, depth + 1));
        if (input.length > opts.maxArrayLength) {
          kept.push(`${TRUNCATED}（残り ${input.length - opts.maxArrayLength} 件）`);
        }
        return kept;
      }
      if (input instanceof Map) {
        const result: Record<string, unknown> = {};
        for (const [k, v] of input) {
          const name = String(k);
          result[name] = walk(v, depth + 1, name);
        }
        return result;
      }
      if (input instanceof Set) {
        return walk([...input], depth, key);
      }

      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        result[k] = walk(v, depth + 1, k);
      }
      return result;
    } finally {
      // 兄弟要素で同じオブジェクトを再利用できるよう、経路を抜けたら解除する
      seen.delete(obj);
    }
  };

  return walk(value, 0);
}

// ── ログエントリの組み立て ────────────────────────────────────

export interface LogEntry {
  timestamp: string;
  level: EmittableLevel;
  message: string;
  [key: string]: unknown;
}

export interface FormatOptions extends RedactOptions {
  /** 全ログに付与する共通フィールド（requestId / functionName 等） */
  base?: Record<string, unknown>;
  /** タイムスタンプ生成。テストでは固定時刻を返す関数を渡す */
  now?: () => Date;
}

/**
 * ログエントリを組み立てる。
 *
 * timestamp / level / message は予約フィールドで、context 側からは上書きできない。
 * 検索クエリの前提が崩れると Logs Insights の集計が壊れるため。
 */
export function buildLogEntry(
  level: EmittableLevel,
  message: string,
  context: Record<string, unknown> = {},
  options: FormatOptions = {},
): LogEntry {
  const now = options.now ?? (() => new Date());
  const redactOptions: RedactOptions = {
    extraKeys: options.extraKeys,
    maxDepth: options.maxDepth,
    maxArrayLength: options.maxArrayLength,
    maxStringLength: options.maxStringLength,
  };

  const merged = { ...(options.base ?? {}), ...context };
  const safe = redact(merged, redactOptions) as Record<string, unknown>;

  // 予約フィールドは最後に置いて必ず勝たせる
  return {
    ...safe,
    timestamp: now().toISOString(),
    level,
    message,
  };
}

/**
 * ログエントリを 1 行の JSON 文字列にする。
 *
 * 何らかの理由で JSON 化に失敗しても、ログ処理で本処理を落とさないよう
 * 最低限の情報を持つフォールバック行を返す。
 */
export function formatLogEntry(entry: LogEntry): string {
  try {
    return JSON.stringify(entry);
  } catch {
    return JSON.stringify({
      timestamp: entry.timestamp,
      level: entry.level,
      message: entry.message,
      logError: "ログのシリアライズに失敗しました",
    });
  }
}

// ── ロガー本体 ────────────────────────────────────────────────

export type LogSink = (line: string, level: EmittableLevel) => void;

export interface LoggerOptions extends FormatOptions {
  level?: LogLevel;
  /** 出力先。既定では level に応じて console のメソッドを使い分ける */
  sink?: LogSink;
}

export interface Logger {
  readonly level: LogLevel;
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  /** 共通フィールドを追加した子ロガーを作る（元のロガーは変更しない） */
  child(base: Record<string, unknown>): Logger;
}

/** level に応じた console メソッドへ出力する既定のシンク */
export const consoleSink: LogSink = (line, level) => {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

/**
 * 構造化ロガーを生成する。
 *
 * 使用例:
 *   const logger = createLogger({ level: parseLogLevel(process.env.LOG_LEVEL) });
 *   const reqLogger = logger.child({ requestId });
 *   reqLogger.info("item created", { itemId, password: "p@ss" });
 *   // → {"requestId":"...","itemId":"...","password":"[REDACTED]", ... }
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? DEFAULT_LOG_LEVEL;
  const sink = options.sink ?? consoleSink;
  const base = options.base ?? {};

  const emit = (
    entryLevel: EmittableLevel,
    message: string,
    context?: Record<string, unknown>,
  ): void => {
    if (!shouldLog(level, entryLevel)) return;
    const entry = buildLogEntry(entryLevel, message, context ?? {}, { ...options, base });
    sink(formatLogEntry(entry), entryLevel);
  };

  return {
    level,
    debug: (message, context) => emit("debug", message, context),
    info: (message, context) => emit("info", message, context),
    warn: (message, context) => emit("warn", message, context),
    error: (message, context) => emit("error", message, context),
    child: (childBase) =>
      createLogger({ ...options, level, sink, base: { ...base, ...childBase } }),
  };
}

/**
 * 環境変数からロガーを組み立てるショートカット。
 *
 * LOG_LEVEL が未設定なら info で動作する。
 */
export function createLoggerFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: LoggerOptions = {},
): Logger {
  return createLogger({ ...options, level: parseLogLevel(env.LOG_LEVEL, options.level) });
}

// ── リトライとの連携 ──────────────────────────────────────────

/**
 * retry.ts の onRetry に渡せるコールバックを作る。
 *
 * リトライは「起きていること自体は正常だが、頻発したら異常」という事象なので
 * warn で構造化して残し、Logs Insights で件数を追えるようにする。
 */
export function retryLogger(
  logger: Logger,
  operation: string,
): (attempt: number, delayMs: number, error: unknown) => void {
  return (attempt, delayMs, error) => {
    logger.warn("AWS API 呼び出しをリトライします", {
      operation,
      attempt,
      delayMs: Math.round(delayMs),
      error,
    });
  };
}

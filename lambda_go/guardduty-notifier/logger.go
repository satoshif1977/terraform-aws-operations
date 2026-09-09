// logger.go: 構造化ロギングユーティリティ
//
// CloudWatch Logs Insights で検索・集計できるよう、ログを 1 行の JSON として出力する。
// あわせて、パスワードやトークンなどの機密情報がログに流出しないようマスキングする。
//
// 同ディレクトリの retry.go と同じ「AWS 呼び出しの運用品質を揃える」方針で、
// RetryLogHook() を通じてリトライ層と結線できる。
// 同リポジトリの lambda_ts/streams-alert/logger.ts（TypeScript 版）と
// 出力キーを揃えた並置実装。
//
// 設計方針:
//   - 車輪の再発明を避け、標準ライブラリの log/slog を土台にする。
//     マスキングは slog.Handler をラップして実現するので、
//     呼び出し側は素の *slog.Logger をそのまま使える
//   - 出力キーは他言語版（TypeScript / Python）と揃えて timestamp / level / message にする。
//     Logs Insights のクエリを言語をまたいで共通化できるようにするため
//   - Writer / Now を差し替え可能にして、テストを決定的に保つ
//   - 機密キーは「キー名の部分一致」で判定する。列挙漏れがあっても
//     accessKeyId / x-api-key のような派生名を拾えるようにするため
//   - 循環参照・巨大な値でログ出力自体が落ちないよう、深さと要素数に上限を設ける
//     （ログは失敗してはいけない副次処理なので、欠落させてでも本処理を止めない）
package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"reflect"
	"strings"
	"time"
)

// ── ログレベル ────────────────────────────────────────────────

// LogLevel はログレベル。slog.Level に対応づけて使う。
type LogLevel string

// サポートするログレベル。
const (
	LogLevelDebug  LogLevel = "debug"
	LogLevelInfo   LogLevel = "info"
	LogLevelWarn   LogLevel = "warn"
	LogLevelError  LogLevel = "error"
	LogLevelSilent LogLevel = "silent"
)

// DefaultLogLevel は LOG_LEVEL が未設定・不正なときに使うレベル。
const DefaultLogLevel = LogLevelInfo

// logLevelSilent は全出力を止めるための番人。slog の最大レベルより上に置く。
const logLevelSilent = slog.Level(1 << 20)

// slogLevelMap は LogLevel から slog.Level への対応表。
var slogLevelMap = map[LogLevel]slog.Level{
	LogLevelDebug:  slog.LevelDebug,
	LogLevelInfo:   slog.LevelInfo,
	LogLevelWarn:   slog.LevelWarn,
	LogLevelError:  slog.LevelError,
	LogLevelSilent: logLevelSilent,
}

// logLevelAliases は Lambda の環境変数で使われがちな別名。
var logLevelAliases = map[string]LogLevel{
	"warning":  LogLevelWarn,
	"fatal":    LogLevelError,
	"critical": LogLevelError,
	"trace":    LogLevelDebug,
	"verbose":  LogLevelDebug,
	"none":     LogLevelSilent,
	"off":      LogLevelSilent,
}

// ParseLogLevel は文字列をログレベルに変換する。
//
// 未知の値・空文字は fallback を返す。
// 環境変数の指定ミスでログが全く出なくなる事故を避けるため、エラーは返さない。
func ParseLogLevel(value string, fallback LogLevel) LogLevel {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "" {
		return fallback
	}
	if alias, ok := logLevelAliases[normalized]; ok {
		return alias
	}
	if _, ok := slogLevelMap[LogLevel(normalized)]; ok {
		return LogLevel(normalized)
	}
	return fallback
}

// SlogLevel は LogLevel を slog.Level に変換する。未知の値は既定レベルとして扱う。
func (l LogLevel) SlogLevel() slog.Level {
	if level, ok := slogLevelMap[l]; ok {
		return level
	}
	return slogLevelMap[DefaultLogLevel]
}

// ── 機密情報のマスキング ──────────────────────────────────────

// SensitiveKeyPatterns はマスキング対象のキー名（小文字・部分一致で判定する）。
//
// 例: "secret" は "clientSecret" / "SECRET_KEY" にもマッチする。
var SensitiveKeyPatterns = []string{
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
}

// マスク・切り詰めの印。
const (
	// Redacted は機密情報を置き換える文字列。
	Redacted = "[REDACTED]"
	// Circular は循環参照を検出した箇所に入る印。
	Circular = "[Circular]"
	// Truncated は深さ・要素数の上限を超えて切り詰めた箇所に入る印。
	Truncated = "[Truncated]"
)

// keyNormalizer は記号（- _ 空白）を除去する置換器。
var keyNormalizer = strings.NewReplacer("-", "", "_", "", " ", "")

// normalizeKey は記号を除いた小文字表現を返す。
func normalizeKey(key string) string {
	return keyNormalizer.Replace(strings.ToLower(key))
}

// IsSensitiveKey はキー名が機密情報にあたるか判定する。
//
// 記号を除いた小文字表現で部分一致を見るため、
// "access-key" / "access_key" / "AccessKey" をまとめて拾える。
func IsSensitiveKey(key string, extraKeys ...string) bool {
	normalizedKey := normalizeKey(key)
	if normalizedKey == "" {
		return false
	}
	for _, pattern := range SensitiveKeyPatterns {
		if p := normalizeKey(pattern); p != "" && strings.Contains(normalizedKey, p) {
			return true
		}
	}
	for _, pattern := range extraKeys {
		if p := normalizeKey(pattern); p != "" && strings.Contains(normalizedKey, p) {
			return true
		}
	}
	return false
}

// RedactConfig はマスキング・切り詰めの設定。
type RedactConfig struct {
	// ExtraKeys は追加のマスキング対象キー（部分一致・大文字小文字は無視）。
	ExtraKeys []string
	// MaxDepth はネストをたどる最大深さ。
	MaxDepth int
	// MaxItems はマップ/スライスを保持する最大要素数。
	MaxItems int
	// MaxStringLength は文字列を保持する最大文字数（rune 単位）。
	MaxStringLength int
}

// DefaultRedactConfig は既定のマスキング設定を返す。
func DefaultRedactConfig() RedactConfig {
	return RedactConfig{
		MaxDepth:        8,
		MaxItems:        100,
		MaxStringLength: 2000,
	}
}

// withDefaults は 0 値のフィールドを既定値で補う。
func (c RedactConfig) withDefaults() RedactConfig {
	d := DefaultRedactConfig()
	if c.MaxDepth <= 0 {
		c.MaxDepth = d.MaxDepth
	}
	if c.MaxItems <= 0 {
		c.MaxItems = d.MaxItems
	}
	if c.MaxStringLength <= 0 {
		c.MaxStringLength = d.MaxStringLength
	}
	return c
}

// Redact はログ出力用に値を安全な形へ変換する。
//
//   - 機密キーの値を [REDACTED] に置換する
//   - 循環参照・深すぎるネスト・多すぎる要素・長すぎる文字列を切り詰める
//   - error は文字列に、[]byte は長さだけに変換する
//
// 入力値は変更しない（新しい値を返す）。
func Redact(value any, cfg RedactConfig) any {
	c := cfg.withDefaults()
	// 「現在たどっている経路」をポインタで保持する。経路を抜けるときに削除するため、
	// 兄弟位置で同じ値を参照しても [Circular] にはならない
	// （本物の循環＝自分の祖先を再訪した場合だけを検出する）。
	seen := map[uintptr]struct{}{}
	return redactValue(value, "", 0, c, seen)
}

// redactValue は Redact の再帰本体。
func redactValue(value any, key string, depth int, cfg RedactConfig, seen map[uintptr]struct{}) any {
	if key != "" && IsSensitiveKey(key, cfg.ExtraKeys...) {
		return Redacted
	}
	if value == nil {
		return nil
	}

	// error は Error() を優先する。%v だと型情報が失われる実装もあるため明示する
	if err, ok := value.(error); ok {
		return truncateString(err.Error(), cfg.MaxStringLength)
	}
	// time.Time は他言語版と揃えて RFC3339 にする
	if t, ok := value.(time.Time); ok {
		return t.Format(time.RFC3339Nano)
	}
	if b, ok := value.([]byte); ok {
		// 中身は機密の可能性があるため長さだけ残す
		return fmt.Sprintf("[bytes: %d]", len(b))
	}

	rv := reflect.ValueOf(value)
	switch rv.Kind() {
	case reflect.String:
		return truncateString(rv.String(), cfg.MaxStringLength)

	case reflect.Bool,
		reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64,
		reflect.Float32, reflect.Float64:
		return value

	case reflect.Pointer, reflect.Interface:
		if rv.IsNil() {
			return nil
		}
		if rv.Kind() == reflect.Pointer {
			ptr := rv.Pointer()
			if _, dup := seen[ptr]; dup {
				return Circular
			}
			seen[ptr] = struct{}{}
			defer delete(seen, ptr)
		}
		return redactValue(rv.Elem().Interface(), "", depth, cfg, seen)

	case reflect.Map:
		if depth >= cfg.MaxDepth {
			return Truncated
		}
		ptr := rv.Pointer()
		if _, dup := seen[ptr]; dup {
			return Circular
		}
		seen[ptr] = struct{}{}
		defer delete(seen, ptr)
		return redactMap(rv, depth, cfg, seen)

	case reflect.Slice, reflect.Array:
		if depth >= cfg.MaxDepth {
			return Truncated
		}
		if rv.Kind() == reflect.Slice {
			if rv.IsNil() {
				return nil
			}
			ptr := rv.Pointer()
			if _, dup := seen[ptr]; dup {
				return Circular
			}
			seen[ptr] = struct{}{}
			defer delete(seen, ptr)
		}
		return redactSlice(rv, depth, cfg, seen)

	case reflect.Struct:
		if depth >= cfg.MaxDepth {
			return Truncated
		}
		return redactStruct(rv, depth, cfg, seen)

	default:
		// チャネル・関数など JSON にできない型は型名だけ残す
		return fmt.Sprintf("[%s]", rv.Kind())
	}
}

// redactMap はマップを map[string]any に変換する。
func redactMap(rv reflect.Value, depth int, cfg RedactConfig, seen map[uintptr]struct{}) any {
	result := make(map[string]any, min(rv.Len(), cfg.MaxItems)+1)
	count := 0
	for _, mapKey := range rv.MapKeys() {
		if count >= cfg.MaxItems {
			result[Truncated] = fmt.Sprintf("残り %d 件", rv.Len()-cfg.MaxItems)
			break
		}
		name := fmt.Sprint(mapKey.Interface())
		result[name] = redactValue(valueOrNil(rv.MapIndex(mapKey)), name, depth+1, cfg, seen)
		count++
	}
	return result
}

// redactSlice はスライス/配列を []any に変換する。
func redactSlice(rv reflect.Value, depth int, cfg RedactConfig, seen map[uintptr]struct{}) any {
	length := rv.Len()
	kept := length
	if kept > cfg.MaxItems {
		kept = cfg.MaxItems
	}
	result := make([]any, 0, kept+1)
	for i := 0; i < kept; i++ {
		result = append(result, redactValue(valueOrNil(rv.Index(i)), "", depth+1, cfg, seen))
	}
	if length > kept {
		result = append(result, fmt.Sprintf("%s（残り %d 件）", Truncated, length-kept))
	}
	return result
}

// redactStruct は構造体の公開フィールドを map[string]any に変換する。
//
// 非公開フィールドは reflect で値を取り出せないため対象外にする。
func redactStruct(rv reflect.Value, depth int, cfg RedactConfig, seen map[uintptr]struct{}) any {
	rt := rv.Type()
	result := make(map[string]any, rt.NumField())
	for i := 0; i < rt.NumField(); i++ {
		field := rt.Field(i)
		if !field.IsExported() {
			continue
		}
		name := field.Name
		result[name] = redactValue(valueOrNil(rv.Field(i)), name, depth+1, cfg, seen)
	}
	return result
}

// valueOrNil は無効な reflect.Value を nil に落として Interface() の panic を防ぐ。
func valueOrNil(rv reflect.Value) any {
	if !rv.IsValid() || !rv.CanInterface() {
		return nil
	}
	return rv.Interface()
}

// truncateString は rune 単位で文字列を切り詰める。
//
// バイト単位で切るとマルチバイト文字が壊れて JSON が不正になるため rune で数える。
func truncateString(s string, maxLength int) string {
	runes := []rune(s)
	if len(runes) <= maxLength {
		return s
	}
	return string(runes[:maxLength]) + "…" + Truncated
}

// ── slog ハンドラ ─────────────────────────────────────────────

// redactHandler は下位ハンドラに渡す前に属性をマスキングする slog.Handler。
type redactHandler struct {
	inner slog.Handler
	cfg   RedactConfig
}

// Enabled は下位ハンドラの判定をそのまま使う。
func (h redactHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.inner.Enabled(ctx, level)
}

// Handle は属性をマスキングしてから下位ハンドラへ渡す。
func (h redactHandler) Handle(ctx context.Context, record slog.Record) error {
	masked := slog.NewRecord(record.Time, record.Level, record.Message, record.PC)
	record.Attrs(func(attr slog.Attr) bool {
		masked.AddAttrs(h.redactAttr(attr))
		return true
	})
	return h.inner.Handle(ctx, masked)
}

// WithAttrs は追加属性をマスキングしてから下位ハンドラへ渡す。
func (h redactHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	masked := make([]slog.Attr, 0, len(attrs))
	for _, attr := range attrs {
		masked = append(masked, h.redactAttr(attr))
	}
	return redactHandler{inner: h.inner.WithAttrs(masked), cfg: h.cfg}
}

// WithGroup はグループをそのまま下位ハンドラへ渡す。
func (h redactHandler) WithGroup(name string) slog.Handler {
	return redactHandler{inner: h.inner.WithGroup(name), cfg: h.cfg}
}

// redactAttr は 1 つの属性をマスキングする。
func (h redactHandler) redactAttr(attr slog.Attr) slog.Attr {
	if IsSensitiveKey(attr.Key, h.cfg.ExtraKeys...) {
		return slog.String(attr.Key, Redacted)
	}
	if attr.Value.Kind() == slog.KindGroup {
		group := attr.Value.Group()
		masked := make([]any, 0, len(group))
		for _, child := range group {
			masked = append(masked, h.redactAttr(child))
		}
		return slog.Group(attr.Key, masked...)
	}
	return slog.Any(attr.Key, Redact(attr.Value.Any(), h.cfg))
}

// ── ロガーの生成 ──────────────────────────────────────────────

// LoggerOptions はロガーの生成設定。
type LoggerOptions struct {
	// LogLevel は出力する最小レベル。空なら DefaultLogLevel。
	Level LogLevel
	// Writer は出力先。nil なら os.Stdout。
	Writer io.Writer
	// Redact はマスキング設定。0 値のフィールドは既定値で補われる。
	Redact RedactConfig
	// Now はタイムスタンプ生成。テストで固定時刻を渡すために使う。
	Now func() time.Time
	// AddSource を true にすると呼び出し元のファイル・行を含める。
	AddSource bool
}

// 他言語版（TypeScript / Python）と揃えた出力キー。
const (
	keyTimestamp = "timestamp"
	keyMessage   = "message"
)

// NewLogger は構造化ロガーを生成する。
//
// 使用例:
//
//	logger := NewLogger(LoggerOptions{Level: ParseLogLevel(os.Getenv("LOG_LEVEL"), DefaultLogLevel)})
//	reqLogger := logger.With("requestId", requestID)
//	reqLogger.Info("処理を開始しました", "itemId", itemID, "password", "p@ss")
//	// → {"timestamp":"...","level":"info","message":"処理を開始しました","itemId":"...","password":"[REDACTED]"}
func NewLogger(opts LoggerOptions) *slog.Logger {
	writer := opts.Writer
	if writer == nil {
		writer = os.Stdout
	}
	level := opts.Level
	if level == "" {
		level = DefaultLogLevel
	}
	cfg := opts.Redact.withDefaults()
	now := opts.Now

	handlerOpts := &slog.HandlerOptions{
		Level:     level.SlogLevel(),
		AddSource: opts.AddSource,
		ReplaceAttr: func(groups []string, attr slog.Attr) slog.Attr {
			// グループ内の属性は改名しない（トップレベルの予約キーだけを揃える）
			if len(groups) > 0 {
				return attr
			}
			switch attr.Key {
			case slog.TimeKey:
				at := attr.Value.Any()
				t, ok := at.(time.Time)
				if !ok {
					return attr
				}
				if now != nil {
					t = now()
				}
				return slog.String(keyTimestamp, t.Format(time.RFC3339Nano))
			case slog.MessageKey:
				return slog.Attr{Key: keyMessage, Value: attr.Value}
			case slog.LevelKey:
				// 他言語版と揃えて小文字にする
				return slog.String(slog.LevelKey, strings.ToLower(attr.Value.String()))
			default:
				return attr
			}
		},
	}

	return slog.New(redactHandler{
		inner: slog.NewJSONHandler(writer, handlerOpts),
		cfg:   cfg,
	})
}

// NewLoggerFromEnv は環境変数 LOG_LEVEL からロガーを生成する。
//
// 未設定・不正な値なら DefaultLogLevel で動作する。
func NewLoggerFromEnv(opts LoggerOptions) *slog.Logger {
	if opts.Level == "" {
		opts.Level = ParseLogLevel(os.Getenv("LOG_LEVEL"), DefaultLogLevel)
	}
	return NewLogger(opts)
}

// ── リトライとの連携 ──────────────────────────────────────────

// RetryLogHook は awsretry の OnRetry に渡せるコールバックを返す。
//
// リトライは「起きていること自体は正常だが、頻発したら異常」という事象なので
// warn で構造化して残し、Logs Insights で件数を追えるようにする。
func RetryLogHook(logger *slog.Logger, op string) func(attempt int, delay time.Duration, err error) {
	return func(attempt int, delay time.Duration, err error) {
		logger.Warn("AWS API 呼び出しをリトライします",
			"operation", op,
			"attempt", attempt,
			"delayMs", delay.Milliseconds(),
			"error", err,
		)
	}
}

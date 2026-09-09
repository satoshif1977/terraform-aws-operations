package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"
)

// ── テスト用ヘルパー ──────────────────────────────────────────

// logTestFixedTime はテストで使う固定時刻。
var logTestFixedTime = time.Date(2026, 9, 7, 0, 0, 0, 0, time.UTC)

// logTestNewLogger は出力をバッファに溜める決定的なロガーを返す。
func logTestNewLogger(t *testing.T, level LogLevel, cfg RedactConfig) (*slog.Logger, *bytes.Buffer) {
	t.Helper()
	buf := &bytes.Buffer{}
	logger := NewLogger(LoggerOptions{
		Level:  level,
		Writer: buf,
		Redact: cfg,
		Now:    func() time.Time { return logTestFixedTime },
	})
	return logger, buf
}

// logTestDecodeLines はバッファの各行を JSON として読み出す。
func logTestDecodeLines(t *testing.T, buf *bytes.Buffer) []map[string]any {
	t.Helper()
	var entries []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		if line == "" {
			continue
		}
		var entry map[string]any
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatalf("ログ行が JSON として読めない: %v (line=%q)", err, line)
		}
		entries = append(entries, entry)
	}
	return entries
}

// logTestDecodeOne は 1 行だけ出力されていることを確かめてその JSON を返す。
func logTestDecodeOne(t *testing.T, buf *bytes.Buffer) map[string]any {
	t.Helper()
	entries := logTestDecodeLines(t, buf)
	if len(entries) != 1 {
		t.Fatalf("出力行数が 1 ではない: %d", len(entries))
	}
	return entries[0]
}

// ── ParseLogLevel ────────────────────────────────────────────────

func TestParseLevel(t *testing.T) {
	tests := []struct {
		name  string
		value string
		want  LogLevel
	}{
		{"debug をそのまま解釈する", "debug", LogLevelDebug},
		{"info をそのまま解釈する", "info", LogLevelInfo},
		{"warn をそのまま解釈する", "warn", LogLevelWarn},
		{"error をそのまま解釈する", "error", LogLevelError},
		{"silent をそのまま解釈する", "silent", LogLevelSilent},
		{"大文字を正規化する", "DEBUG", LogLevelDebug},
		{"前後の空白を無視する", "  warn  ", LogLevelWarn},
		{"別名 warning を warn にする", "warning", LogLevelWarn},
		{"別名 fatal を error にする", "fatal", LogLevelError},
		{"別名 critical を error にする", "critical", LogLevelError},
		{"別名 trace を debug にする", "trace", LogLevelDebug},
		{"別名 verbose を debug にする", "verbose", LogLevelDebug},
		{"別名 none を silent にする", "none", LogLevelSilent},
		{"別名 off を silent にする", "off", LogLevelSilent},
		{"空文字は既定値にする", "", DefaultLogLevel},
		{"空白だけなら既定値にする", "   ", DefaultLogLevel},
		{"未知の値は既定値にする", "でたらめ", DefaultLogLevel},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ParseLogLevel(tt.value, DefaultLogLevel); got != tt.want {
				t.Errorf("ParseLogLevel(%q) = %q, want %q", tt.value, got, tt.want)
			}
		})
	}
}

func TestParseLevelFallbackを明示指定できる(t *testing.T) {
	if got := ParseLogLevel("でたらめ", LogLevelError); got != LogLevelError {
		t.Errorf("fallback が使われていない: %q", got)
	}
}

func TestSlogLevel(t *testing.T) {
	tests := []struct {
		level LogLevel
		want  slog.Level
	}{
		{LogLevelDebug, slog.LevelDebug},
		{LogLevelInfo, slog.LevelInfo},
		{LogLevelWarn, slog.LevelWarn},
		{LogLevelError, slog.LevelError},
	}
	for _, tt := range tests {
		t.Run(string(tt.level), func(t *testing.T) {
			if got := tt.level.SlogLevel(); got != tt.want {
				t.Errorf("SlogLevel() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestSlogLevelSilentはerrorより上(t *testing.T) {
	if LogLevelSilent.SlogLevel() <= slog.LevelError {
		t.Error("silent は error より高いレベルでなければ全出力を止められない")
	}
}

func TestSlogLevel未知の値は既定レベル(t *testing.T) {
	if got := LogLevel("でたらめ").SlogLevel(); got != slog.LevelInfo {
		t.Errorf("SlogLevel() = %v, want %v", got, slog.LevelInfo)
	}
}

// ── IsSensitiveKey ────────────────────────────────────────────

func TestIsSensitiveKey既定パターン(t *testing.T) {
	for _, pattern := range SensitiveKeyPatterns {
		t.Run(pattern, func(t *testing.T) {
			if !IsSensitiveKey(pattern) {
				t.Errorf("IsSensitiveKey(%q) = false, want true", pattern)
			}
		})
	}
}

func TestIsSensitiveKey(t *testing.T) {
	tests := []struct {
		key  string
		want bool
	}{
		{"password", true},
		{"userPassword", true},
		{"PASSWORD", true},
		{"access-key", true},
		{"access_key", true},
		{"AccessKeyId", true},
		{"x-api-key", true},
		{"clientSecret", true},
		{"Authorization", true},
		{"refreshToken", true},
		{"session_id", true},
		{"Set-Cookie", true},
		{"itemId", false},
		{"name", false},
		{"count", false},
		{"createdAt", false},
		{"message", false},
		{"", false},
	}
	for _, tt := range tests {
		t.Run(tt.key, func(t *testing.T) {
			if got := IsSensitiveKey(tt.key); got != tt.want {
				t.Errorf("IsSensitiveKey(%q) = %v, want %v", tt.key, got, tt.want)
			}
		})
	}
}

func TestIsSensitiveKey追加キー(t *testing.T) {
	if IsSensitiveKey("myCompanyId") {
		t.Error("既定パターンでは機密扱いされないはず")
	}
	if !IsSensitiveKey("myCompanyId", "companyId") {
		t.Error("追加キーが効いていない")
	}
}

func TestIsSensitiveKey空の追加キーは全件マッチしない(t *testing.T) {
	if IsSensitiveKey("itemId", "") {
		t.Error("空文字の追加キーで誤爆している")
	}
}

// ── Redact ────────────────────────────────────────────────────

func TestRedactマップの機密キーをマスクする(t *testing.T) {
	got := Redact(map[string]any{"userId": "u1", "password": "p@ss"}, RedactConfig{})
	want := map[string]any{"userId": "u1", "password": Redacted}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("Redact() = %v, want %v", got, want)
	}
}

func TestRedactネストした機密キーをマスクする(t *testing.T) {
	input := map[string]any{
		"request": map[string]any{
			"headers": map[string]any{"authorization": "Bearer x"},
			"path":    "/items",
		},
	}
	got, ok := Redact(input, RedactConfig{}).(map[string]any)
	if !ok {
		t.Fatalf("map が返らなかった: %T", got)
	}
	request := got["request"].(map[string]any)
	headers := request["headers"].(map[string]any)
	if headers["authorization"] != Redacted {
		t.Errorf("authorization がマスクされていない: %v", headers["authorization"])
	}
	if request["path"] != "/items" {
		t.Errorf("path が変わっている: %v", request["path"])
	}
}

func TestRedact入力を変更しない(t *testing.T) {
	input := map[string]any{"password": "secret"}
	Redact(input, RedactConfig{})
	if input["password"] != "secret" {
		t.Errorf("入力が変更された: %v", input["password"])
	}
}

func TestRedact循環参照を検出する(t *testing.T) {
	node := map[string]any{"name": "root"}
	node["self"] = node
	got := Redact(node, RedactConfig{}).(map[string]any)
	if got["name"] != "root" {
		t.Errorf("name が壊れている: %v", got["name"])
	}
	if got["self"] != Circular {
		t.Errorf("循環が検出されていない: %v", got["self"])
	}
}

func TestRedact兄弟位置の同一参照は循環扱いしない(t *testing.T) {
	shared := map[string]any{"id": 1}
	got := Redact(map[string]any{"a": shared, "b": shared}, RedactConfig{}).(map[string]any)
	for _, key := range []string{"a", "b"} {
		child, ok := got[key].(map[string]any)
		if !ok {
			t.Fatalf("%s が map ではない: %T", key, got[key])
		}
		if fmt.Sprint(child["id"]) != "1" {
			t.Errorf("%s.id = %v, want 1", key, child["id"])
		}
	}
}

func TestRedact深さ上限で切り詰める(t *testing.T) {
	input := map[string]any{"l1": map[string]any{"l2": map[string]any{"l3": "値"}}}
	got := Redact(input, RedactConfig{MaxDepth: 2}).(map[string]any)
	l1 := got["l1"].(map[string]any)
	if l1["l2"] != Truncated {
		t.Errorf("深さ上限で切り詰められていない: %v", l1["l2"])
	}
}

func TestRedactスライスの要素数上限で切り詰める(t *testing.T) {
	got := Redact([]any{1, 2, 3, 4, 5}, RedactConfig{MaxItems: 2}).([]any)
	if len(got) != 3 {
		t.Fatalf("要素数 = %d, want 3", len(got))
	}
	last, ok := got[2].(string)
	if !ok || !strings.Contains(last, "残り 3 件") {
		t.Errorf("残数の表示がない: %v", got[2])
	}
}

func TestRedactマップの要素数上限で切り詰める(t *testing.T) {
	input := map[string]any{}
	for i := 0; i < 5; i++ {
		input[fmt.Sprintf("k%d", i)] = i
	}
	got := Redact(input, RedactConfig{MaxItems: 2}).(map[string]any)
	if len(got) != 3 {
		t.Fatalf("要素数 = %d, want 3（2 件 + 残数表示）", len(got))
	}
	if !strings.Contains(fmt.Sprint(got[Truncated]), "残り 3 件") {
		t.Errorf("残数の表示がない: %v", got[Truncated])
	}
}

func TestRedact文字列の長さ上限で切り詰める(t *testing.T) {
	got := Redact(strings.Repeat("あ", 50), RedactConfig{MaxStringLength: 10}).(string)
	if !strings.HasPrefix(got, strings.Repeat("あ", 10)) {
		t.Errorf("先頭が保持されていない: %q", got)
	}
	if !strings.Contains(got, Truncated) {
		t.Errorf("切り詰めの印がない: %q", got)
	}
}

func TestRedactマルチバイト文字を壊さない(t *testing.T) {
	got := Redact(strings.Repeat("日本語", 10), RedactConfig{MaxStringLength: 4}).(string)
	// rune 単位で切っていれば、先頭 4 文字は「日本語日」になる
	if !strings.HasPrefix(got, "日本語日") {
		t.Errorf("rune 単位で切られていない: %q", got)
	}
}

func TestRedactエラーを文字列にする(t *testing.T) {
	got := Redact(map[string]any{"error": errors.New("失敗しました")}, RedactConfig{}).(map[string]any)
	if got["error"] != "失敗しました" {
		t.Errorf("error = %v, want 失敗しました", got["error"])
	}
}

func TestRedactラップされたエラーも文字列にする(t *testing.T) {
	wrapped := fmt.Errorf("外側: %w", errors.New("内側"))
	got := Redact(map[string]any{"error": wrapped}, RedactConfig{}).(map[string]any)
	if got["error"] != "外側: 内側" {
		t.Errorf("error = %v", got["error"])
	}
}

func TestRedactバイト列は長さだけ残す(t *testing.T) {
	got := Redact(map[string]any{"blob": []byte("binary")}, RedactConfig{}).(map[string]any)
	if got["blob"] != "[bytes: 6]" {
		t.Errorf("blob = %v, want [bytes: 6]", got["blob"])
	}
}

func TestRedact時刻をRFC3339にする(t *testing.T) {
	got := Redact(map[string]any{"at": logTestFixedTime}, RedactConfig{}).(map[string]any)
	if got["at"] != "2026-09-07T00:00:00Z" {
		t.Errorf("at = %v", got["at"])
	}
}

func TestRedactポインタを展開する(t *testing.T) {
	value := "u1"
	got := Redact(map[string]any{"userId": &value}, RedactConfig{}).(map[string]any)
	if got["userId"] != "u1" {
		t.Errorf("userId = %v, want u1", got["userId"])
	}
}

func TestRedactnilポインタはnilにする(t *testing.T) {
	var value *string
	got := Redact(map[string]any{"userId": value}, RedactConfig{}).(map[string]any)
	if got["userId"] != nil {
		t.Errorf("userId = %v, want nil", got["userId"])
	}
}

func TestRedactnilをそのまま返す(t *testing.T) {
	if got := Redact(nil, RedactConfig{}); got != nil {
		t.Errorf("Redact(nil) = %v, want nil", got)
	}
}

func TestRedact構造体の公開フィールドを展開しマスクする(t *testing.T) {
	type credential struct {
		User   string
		Secret string
		hidden string //nolint:unused // 非公開フィールドが除外されることの検証用
	}
	got := Redact(credential{User: "u1", Secret: "s1", hidden: "h"}, RedactConfig{}).(map[string]any)
	if got["User"] != "u1" {
		t.Errorf("User = %v, want u1", got["User"])
	}
	if got["Secret"] != Redacted {
		t.Errorf("Secret = %v, want %v", got["Secret"], Redacted)
	}
	if _, exists := got["hidden"]; exists {
		t.Error("非公開フィールドが含まれている")
	}
}

func TestRedactプリミティブをそのまま返す(t *testing.T) {
	tests := []struct {
		name  string
		value any
	}{
		{"bool", true},
		{"int", 42},
		{"int64", int64(42)},
		{"uint", uint(42)},
		{"float64", 1.5},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Redact(tt.value, RedactConfig{}); fmt.Sprint(got) != fmt.Sprint(tt.value) {
				t.Errorf("Redact(%v) = %v", tt.value, got)
			}
		})
	}
}

func TestRedactJSONにできない型は型名を残す(t *testing.T) {
	got := Redact(map[string]any{"fn": func() {}}, RedactConfig{}).(map[string]any)
	if got["fn"] != "[func]" {
		t.Errorf("fn = %v, want [func]", got["fn"])
	}
}

func TestRedactConfigの0値は既定値で補われる(t *testing.T) {
	cfg := RedactConfig{}.withDefaults()
	d := DefaultRedactConfig()
	if cfg.MaxDepth != d.MaxDepth || cfg.MaxItems != d.MaxItems || cfg.MaxStringLength != d.MaxStringLength {
		t.Errorf("既定値が補われていない: %+v", cfg)
	}
}

// ── ロガー出力 ────────────────────────────────────────────────

func TestNew他言語版と揃えたキーで出力する(t *testing.T) {
	logger, buf := logTestNewLogger(t, LogLevelDebug, RedactConfig{})
	logger.Info("処理を開始しました")

	entry := logTestDecodeOne(t, buf)
	for _, key := range []string{keyTimestamp, "level", keyMessage} {
		if _, exists := entry[key]; !exists {
			t.Errorf("キー %q がない: %v", key, entry)
		}
	}
	if entry[keyMessage] != "処理を開始しました" {
		t.Errorf("message = %v", entry[keyMessage])
	}
	if entry[keyTimestamp] != logTestFixedTime.Format(time.RFC3339Nano) {
		t.Errorf("timestamp が固定時刻ではない: %v", entry[keyTimestamp])
	}
	// slog 既定の time / msg キーは残っていないこと
	if _, exists := entry["msg"]; exists {
		t.Error("slog 既定の msg キーが残っている")
	}
	if _, exists := entry["time"]; exists {
		t.Error("slog 既定の time キーが残っている")
	}
}

func TestNewレベルを小文字で出力する(t *testing.T) {
	tests := []struct {
		name string
		emit func(l *slog.Logger)
		want string
	}{
		{"debug", func(l *slog.Logger) { l.Debug("m") }, "debug"},
		{"info", func(l *slog.Logger) { l.Info("m") }, "info"},
		{"warn", func(l *slog.Logger) { l.Warn("m") }, "warn"},
		{"error", func(l *slog.Logger) { l.Error("m") }, "error"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			logger, buf := logTestNewLogger(t, LogLevelDebug, RedactConfig{})
			tt.emit(logger)
			if got := logTestDecodeOne(t, buf)["level"]; got != tt.want {
				t.Errorf("level = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestNew設定レベル未満を出力しない(t *testing.T) {
	logger, buf := logTestNewLogger(t, LogLevelWarn, RedactConfig{})
	logger.Debug("出ない")
	logger.Info("出ない")
	logger.Warn("出る")
	logger.Error("出る")

	if got := len(logTestDecodeLines(t, buf)); got != 2 {
		t.Errorf("出力行数 = %d, want 2", got)
	}
}

func TestNewSilentは一切出力しない(t *testing.T) {
	logger, buf := logTestNewLogger(t, LogLevelSilent, RedactConfig{})
	logger.Debug("出ない")
	logger.Info("出ない")
	logger.Warn("出ない")
	logger.Error("出ない")

	if buf.Len() != 0 {
		t.Errorf("silent なのに出力された: %q", buf.String())
	}
}

func TestNew既定レベルはinfo(t *testing.T) {
	buf := &bytes.Buffer{}
	logger := NewLogger(LoggerOptions{Writer: buf, Now: func() time.Time { return logTestFixedTime }})
	logger.Debug("出ない")
	if buf.Len() != 0 {
		t.Errorf("既定レベルが info ではない: %q", buf.String())
	}
	logger.Info("出る")
	if buf.Len() == 0 {
		t.Error("info が出力されていない")
	}
}

func TestNew機密属性をマスクする(t *testing.T) {
	logger, buf := logTestNewLogger(t, LogLevelDebug, RedactConfig{})
	logger.Info("ログイン", "userId", "u1", "password", "p@ss", "apiKey", "k1")

	entry := logTestDecodeOne(t, buf)
	if entry["userId"] != "u1" {
		t.Errorf("userId = %v", entry["userId"])
	}
	for _, key := range []string{"password", "apiKey"} {
		if entry[key] != Redacted {
			t.Errorf("%s = %v, want %v", key, entry[key], Redacted)
		}
	}
}

func TestNewネストした値の機密キーもマスクする(t *testing.T) {
	logger, buf := logTestNewLogger(t, LogLevelDebug, RedactConfig{})
	logger.Info("リクエスト", "request", map[string]any{
		"path":          "/items",
		"authorization": "Bearer x",
	})

	entry := logTestDecodeOne(t, buf)
	request := entry["request"].(map[string]any)
	if request["path"] != "/items" {
		t.Errorf("path = %v", request["path"])
	}
	if request["authorization"] != Redacted {
		t.Errorf("authorization = %v, want %v", request["authorization"], Redacted)
	}
}

func TestNewグループ内の機密キーもマスクする(t *testing.T) {
	logger, buf := logTestNewLogger(t, LogLevelDebug, RedactConfig{})
	logger.Info("リクエスト", slog.Group("http", "path", "/items", "token", "t1"))

	entry := logTestDecodeOne(t, buf)
	group := entry["http"].(map[string]any)
	if group["path"] != "/items" {
		t.Errorf("path = %v", group["path"])
	}
	if group["token"] != Redacted {
		t.Errorf("token = %v, want %v", group["token"], Redacted)
	}
}

func TestNewWithで付けた属性もマスクする(t *testing.T) {
	logger, buf := logTestNewLogger(t, LogLevelDebug, RedactConfig{})
	logger.With("requestId", "r1", "sessionToken", "s1").Info("m")

	entry := logTestDecodeOne(t, buf)
	if entry["requestId"] != "r1" {
		t.Errorf("requestId = %v", entry["requestId"])
	}
	if entry["sessionToken"] != Redacted {
		t.Errorf("sessionToken = %v, want %v", entry["sessionToken"], Redacted)
	}
}

func TestNewWithは親ロガーに影響しない(t *testing.T) {
	logger, buf := logTestNewLogger(t, LogLevelDebug, RedactConfig{})
	logger.With("requestId", "r1").Info("子")
	logger.Info("親")

	entries := logTestDecodeLines(t, buf)
	if len(entries) != 2 {
		t.Fatalf("出力行数 = %d, want 2", len(entries))
	}
	if entries[0]["requestId"] != "r1" {
		t.Errorf("子に requestId がない: %v", entries[0])
	}
	if _, exists := entries[1]["requestId"]; exists {
		t.Errorf("親に requestId が漏れている: %v", entries[1])
	}
}

func TestNewExtraKeysが反映される(t *testing.T) {
	logger, buf := logTestNewLogger(t, LogLevelDebug, RedactConfig{ExtraKeys: []string{"companyId"}})
	logger.Info("m", "companyId", "c1")

	if got := logTestDecodeOne(t, buf)["companyId"]; got != Redacted {
		t.Errorf("companyId = %v, want %v", got, Redacted)
	}
}

func TestNewエラーを文字列として出力する(t *testing.T) {
	logger, buf := logTestNewLogger(t, LogLevelDebug, RedactConfig{})
	logger.Error("失敗", "error", errors.New("スロットリング"))

	if got := logTestDecodeOne(t, buf)["error"]; got != "スロットリング" {
		t.Errorf("error = %v", got)
	}
}

func TestNew改行を含むメッセージでも1行になる(t *testing.T) {
	logger, buf := logTestNewLogger(t, LogLevelDebug, RedactConfig{})
	logger.Info("複数\n行")

	if got := len(logTestDecodeLines(t, buf)); got != 1 {
		t.Errorf("出力行数 = %d, want 1", got)
	}
	if got := logTestDecodeOne(t, buf)[keyMessage]; got != "複数\n行" {
		t.Errorf("message = %q", got)
	}
}

func TestNew循環参照でも出力できる(t *testing.T) {
	logger, buf := logTestNewLogger(t, LogLevelDebug, RedactConfig{})
	node := map[string]any{"name": "root"}
	node["self"] = node

	logger.Info("循環", "node", node)

	entry := logTestDecodeOne(t, buf)
	got := entry["node"].(map[string]any)
	if got["self"] != Circular {
		t.Errorf("self = %v, want %v", got["self"], Circular)
	}
}

func TestNewAddSourceで呼び出し元を含める(t *testing.T) {
	buf := &bytes.Buffer{}
	logger := NewLogger(LoggerOptions{
		Level:     LogLevelDebug,
		Writer:    buf,
		AddSource: true,
		Now:       func() time.Time { return logTestFixedTime },
	})
	logger.Info("m")

	if _, exists := logTestDecodeOne(t, buf)["source"]; !exists {
		t.Errorf("source が含まれていない: %v", buf.String())
	}
}

func TestNewFromEnvはLOG_LEVELを読む(t *testing.T) {
	t.Setenv("LOG_LEVEL", "error")
	buf := &bytes.Buffer{}
	logger := NewLoggerFromEnv(LoggerOptions{Writer: buf, Now: func() time.Time { return logTestFixedTime }})

	logger.Warn("出ない")
	if buf.Len() != 0 {
		t.Errorf("LOG_LEVEL=error が効いていない: %q", buf.String())
	}
	logger.Error("出る")
	if buf.Len() == 0 {
		t.Error("error が出力されていない")
	}
}

func TestNewFromEnv未設定なら既定レベル(t *testing.T) {
	t.Setenv("LOG_LEVEL", "")
	buf := &bytes.Buffer{}
	logger := NewLoggerFromEnv(LoggerOptions{Writer: buf, Now: func() time.Time { return logTestFixedTime }})

	logger.Debug("出ない")
	if buf.Len() != 0 {
		t.Errorf("既定レベルが info ではない: %q", buf.String())
	}
}

func TestNewFromEnv明示指定はLOG_LEVELより優先(t *testing.T) {
	t.Setenv("LOG_LEVEL", "error")
	buf := &bytes.Buffer{}
	logger := NewLoggerFromEnv(LoggerOptions{Level: LogLevelDebug, Writer: buf, Now: func() time.Time { return logTestFixedTime }})

	logger.Debug("出る")
	if buf.Len() == 0 {
		t.Error("明示指定した LogLevel が使われていない")
	}
}

// ── RetryLogHook ─────────────────────────────────────────────────

func TestRetryHook(t *testing.T) {
	logger, buf := logTestNewLogger(t, LogLevelDebug, RedactConfig{})
	hook := RetryLogHook(logger, "PutItem")

	hook(2, 512*time.Millisecond, errors.New("ThrottlingException"))

	entry := logTestDecodeOne(t, buf)
	if entry["level"] != "warn" {
		t.Errorf("level = %v, want warn", entry["level"])
	}
	if entry["operation"] != "PutItem" {
		t.Errorf("operation = %v", entry["operation"])
	}
	if fmt.Sprint(entry["attempt"]) != "2" {
		t.Errorf("attempt = %v, want 2", entry["attempt"])
	}
	if fmt.Sprint(entry["delayMs"]) != "512" {
		t.Errorf("delayMs = %v, want 512", entry["delayMs"])
	}
	if entry["error"] != "ThrottlingException" {
		t.Errorf("error = %v", entry["error"])
	}
}

func TestRetryHookSilentなロガーでは記録しない(t *testing.T) {
	logger, buf := logTestNewLogger(t, LogLevelSilent, RedactConfig{})
	RetryLogHook(logger, "PutItem")(1, time.Second, errors.New("x"))

	if buf.Len() != 0 {
		t.Errorf("silent なのに出力された: %q", buf.String())
	}
}

// ── ベンチマーク ──────────────────────────────────────────────

func BenchmarkLoggerInfo(b *testing.B) {
	logger := NewLogger(LoggerOptions{Level: LogLevelInfo, Writer: io.Discard})
	for i := 0; i < b.N; i++ {
		logger.Info("ベンチマーク", "itemId", "i1", "password", "p@ss")
	}
}

func BenchmarkRedactNested(b *testing.B) {
	input := map[string]any{
		"request": map[string]any{
			"headers": map[string]any{"authorization": "Bearer x", "userAgent": "test"},
			"body":    []any{1, 2, 3, 4, 5},
		},
	}
	cfg := DefaultRedactConfig()
	for i := 0; i < b.N; i++ {
		Redact(input, cfg)
	}
}

func BenchmarkIsSensitiveKey(b *testing.B) {
	for i := 0; i < b.N; i++ {
		IsSensitiveKey("accessKeyId")
	}
}

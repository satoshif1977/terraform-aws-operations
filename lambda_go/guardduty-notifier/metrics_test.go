package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"sync"
	"testing"
	"time"
)

// ── テスト用ヘルパー ──────────────────────────────────────────

// metricsTestFixedTime はテストで使う固定時刻。
var metricsTestFixedTime = time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)

// metricsTestNew は出力をバッファに溜める決定的な Metrics を返す。
func metricsTestNew(t *testing.T, dims map[string]string) (*Metrics, *bytes.Buffer) {
	t.Helper()
	buf := &bytes.Buffer{}
	m, err := NewMetrics(MetricsOptions{
		Namespace:  "TestNamespace",
		Sink:       buf,
		Now:        func() time.Time { return metricsTestFixedTime },
		Dimensions: dims,
	})
	if err != nil {
		t.Fatalf("NewMetrics が失敗した: %v", err)
	}
	return m, buf
}

// metricsTestDecodeLines はバッファの各行を JSON として読み出す。
func metricsTestDecodeLines(t *testing.T, buf *bytes.Buffer) []map[string]any {
	t.Helper()
	var docs []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		if line == "" {
			continue
		}
		var doc map[string]any
		if err := json.Unmarshal([]byte(line), &doc); err != nil {
			t.Fatalf("EMF 行が JSON として読めない: %v (line=%q)", err, line)
		}
		docs = append(docs, doc)
	}
	return docs
}

// metricsTestDirective は EMF ドキュメントから MetricDirective を取り出す。
func metricsTestDirective(t *testing.T, doc map[string]any) map[string]any {
	t.Helper()
	aws, ok := doc[reservedRootKey].(map[string]any)
	if !ok {
		t.Fatalf("%s キーが無い: %#v", reservedRootKey, doc)
	}
	list, ok := aws["CloudWatchMetrics"].([]any)
	if !ok || len(list) == 0 {
		t.Fatalf("CloudWatchMetrics が無い: %#v", aws)
	}
	directive, ok := list[0].(map[string]any)
	if !ok {
		t.Fatalf("MetricDirective の形が不正: %#v", list[0])
	}
	return directive
}

// metricsTestNames は MetricDirective からメトリクス名を順に取り出す。
func metricsTestNames(t *testing.T, directive map[string]any) []string {
	t.Helper()
	raw, ok := directive["Metrics"].([]any)
	if !ok {
		t.Fatalf("Metrics が無い: %#v", directive)
	}
	names := make([]string, 0, len(raw))
	for _, e := range raw {
		entry, ok := e.(map[string]any)
		if !ok {
			t.Fatalf("メトリクス定義の形が不正: %#v", e)
		}
		names = append(names, entry["Name"].(string))
	}
	return names
}

// ── 生成 ──────────────────────────────────────────────────────

func TestNewMetricsRejectsEmptyNamespace(t *testing.T) {
	for _, ns := range []string{"", "   ", "\t"} {
		if _, err := NewMetrics(MetricsOptions{Namespace: ns}); err == nil {
			t.Errorf("空の名前空間 %q がエラーにならない", ns)
		}
	}
}

func TestNewMetricsRejectsTooLongNamespace(t *testing.T) {
	if _, err := NewMetrics(MetricsOptions{Namespace: strings.Repeat("a", maxNameLength+1)}); err == nil {
		t.Error("長すぎる名前空間がエラーにならない")
	}
}

func TestNewMetricsAppliesDefaults(t *testing.T) {
	m, err := NewMetrics(MetricsOptions{Namespace: "NS"})
	if err != nil {
		t.Fatalf("NewMetrics が失敗した: %v", err)
	}
	if m.sink == nil {
		t.Error("Sink が既定値で埋まっていない")
	}
	if m.now == nil {
		t.Error("Now が既定値で埋まっていない")
	}
}

func TestNewMetricsRejectsBadDimensions(t *testing.T) {
	_, err := NewMetrics(MetricsOptions{
		Namespace:  "NS",
		Dimensions: map[string]string{"Service": ""},
	})
	if err == nil {
		t.Error("空のディメンション値がエラーにならない")
	}
}

// ── 出力の基本形 ──────────────────────────────────────────────

func TestFlushEmitsEMFDocument(t *testing.T) {
	m, buf := metricsTestNew(t, map[string]string{"Service": "agent"})
	if err := m.PutMetric("Latency", 12.5, WithUnit(UnitMilliseconds)); err != nil {
		t.Fatalf("PutMetric が失敗した: %v", err)
	}
	if err := m.Flush(); err != nil {
		t.Fatalf("Flush が失敗した: %v", err)
	}

	docs := metricsTestDecodeLines(t, buf)
	if len(docs) != 1 {
		t.Fatalf("出力行数が 1 ではない: %d", len(docs))
	}
	doc := docs[0]

	if got := doc["Latency"]; got != 12.5 {
		t.Errorf("メトリクス値が違う: %v", got)
	}
	if got := doc["Service"]; got != "agent" {
		t.Errorf("ディメンション値がルートに載っていない: %v", got)
	}

	directive := metricsTestDirective(t, doc)
	if got := directive["Namespace"]; got != "TestNamespace" {
		t.Errorf("名前空間が違う: %v", got)
	}
}

func TestFlushTimestampIsEpochMillis(t *testing.T) {
	m, buf := metricsTestNew(t, nil)
	_ = m.Count("Requests", 1)
	if err := m.Flush(); err != nil {
		t.Fatalf("Flush が失敗した: %v", err)
	}
	doc := metricsTestDecodeLines(t, buf)[0]
	aws := doc[reservedRootKey].(map[string]any)
	got := int64(aws["Timestamp"].(float64))
	want := metricsTestFixedTime.UnixMilli()
	if got != want {
		t.Errorf("Timestamp がエポックミリ秒でない: got=%d want=%d", got, want)
	}
	// 秒で入れてしまう実装ミスを検出する（桁数で見る）。
	if got == metricsTestFixedTime.Unix() {
		t.Error("Timestamp がエポック秒になっている")
	}
}

func TestFlushOnEmptyDoesNothing(t *testing.T) {
	m, buf := metricsTestNew(t, nil)
	if err := m.Flush(); err != nil {
		t.Fatalf("Flush が失敗した: %v", err)
	}
	if buf.Len() != 0 {
		t.Errorf("メトリクス 0 件で出力されている: %q", buf.String())
	}
}

func TestFlushResetsMetricsButKeepsDimensions(t *testing.T) {
	m, buf := metricsTestNew(t, map[string]string{"Service": "agent"})
	_ = m.Count("A", 1)
	_ = m.Flush()
	_ = m.Count("B", 2)
	_ = m.Flush()

	docs := metricsTestDecodeLines(t, buf)
	if len(docs) != 2 {
		t.Fatalf("出力行数が 2 ではない: %d", len(docs))
	}
	if _, ok := docs[1]["A"]; ok {
		t.Error("Flush 後もメトリクスが残っている")
	}
	if docs[1]["Service"] != "agent" {
		t.Error("Flush 後にディメンションが消えている")
	}
}

// ── 値の積み上げ ──────────────────────────────────────────────

func TestPutMetricAccumulatesValues(t *testing.T) {
	m, buf := metricsTestNew(t, nil)
	for _, v := range []float64{1, 2, 3} {
		if err := m.PutMetric("Latency", v); err != nil {
			t.Fatalf("PutMetric が失敗した: %v", err)
		}
	}
	_ = m.Flush()

	doc := metricsTestDecodeLines(t, buf)[0]
	values, ok := doc["Latency"].([]any)
	if !ok {
		t.Fatalf("複数値が配列になっていない: %#v", doc["Latency"])
	}
	if len(values) != 3 {
		t.Errorf("値の数が違う: %d", len(values))
	}
}

func TestPutMetricSingleValueIsScalar(t *testing.T) {
	m, buf := metricsTestNew(t, nil)
	_ = m.PutMetric("Latency", 42)
	_ = m.Flush()
	doc := metricsTestDecodeLines(t, buf)[0]
	if _, isArray := doc["Latency"].([]any); isArray {
		t.Error("値が 1 件でも配列になっている")
	}
}

func TestPutMetricPreservesOrder(t *testing.T) {
	m, buf := metricsTestNew(t, nil)
	for _, n := range []string{"C", "A", "B"} {
		_ = m.Count(n, 1)
	}
	_ = m.Flush()
	names := metricsTestNames(t, metricsTestDirective(t, metricsTestDecodeLines(t, buf)[0]))
	want := []string{"C", "A", "B"}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("追加順が保たれていない: got=%v want=%v", names, want)
		}
	}
}

// ── バリデーション ────────────────────────────────────────────

func TestPutMetricRejectsInvalidNames(t *testing.T) {
	m, _ := metricsTestNew(t, nil)
	cases := map[string]string{
		"空文字":  "",
		"予約キー": reservedRootKey,
		"長すぎ":  strings.Repeat("a", maxNameLength+1),
	}
	for label, name := range cases {
		if err := m.PutMetric(name, 1); err == nil {
			t.Errorf("%s のメトリクス名がエラーにならない", label)
		}
	}
}

func TestPutMetricRejectsNaNAndInf(t *testing.T) {
	m, _ := metricsTestNew(t, nil)
	for label, v := range map[string]float64{
		"NaN":  math.NaN(),
		"+Inf": math.Inf(1),
		"-Inf": math.Inf(-1),
	} {
		if err := m.PutMetric("X", v); err == nil {
			t.Errorf("%s がエラーにならない", label)
		}
	}
}

func TestPutMetricRejectsUnknownUnit(t *testing.T) {
	m, _ := metricsTestNew(t, nil)
	// 大文字小文字を区別する。"milliseconds" は無効。
	if err := m.PutMetric("X", 1, WithUnit(MetricUnit("milliseconds"))); err == nil {
		t.Error("小文字の単位がエラーにならない")
	}
	if err := m.PutMetric("X", 1, WithUnit(MetricUnit("Furlongs"))); err == nil {
		t.Error("存在しない単位がエラーにならない")
	}
}

func TestPutMetricAcceptsAllValidUnits(t *testing.T) {
	for unit := range validUnits {
		m, _ := metricsTestNew(t, nil)
		if err := m.PutMetric("X", 1, WithUnit(unit)); err != nil {
			t.Errorf("正当な単位 %q が拒否された: %v", unit, err)
		}
	}
}

func TestWithHighResolutionIsEmitted(t *testing.T) {
	m, buf := metricsTestNew(t, nil)
	_ = m.PutMetric("Fast", 1, WithHighResolution())
	_ = m.PutMetric("Normal", 1)
	_ = m.Flush()

	directive := metricsTestDirective(t, metricsTestDecodeLines(t, buf)[0])
	entries := directive["Metrics"].([]any)
	for _, e := range entries {
		entry := e.(map[string]any)
		_, has := entry["StorageResolution"]
		if entry["Name"] == "Fast" && !has {
			t.Error("高解像度メトリクスに StorageResolution が出ていない")
		}
		if entry["Name"] == "Normal" && has {
			t.Error("標準解像度なのに StorageResolution が出力されている")
		}
	}
}

func TestDefaultUnitIsOmitted(t *testing.T) {
	m, buf := metricsTestNew(t, nil)
	_ = m.PutMetric("Plain", 1)
	_ = m.Flush()
	entry := metricsTestDirective(t, metricsTestDecodeLines(t, buf)[0])["Metrics"].([]any)[0].(map[string]any)
	if _, has := entry["Unit"]; has {
		t.Error("既定単位 None が出力から省略されていない")
	}
}

// ── ディメンション ────────────────────────────────────────────

func TestSetDimensionsRejectsTooMany(t *testing.T) {
	m, _ := metricsTestNew(t, nil)
	dims := map[string]string{}
	for i := 0; i <= MaxDimensionKeys; i++ {
		dims[fmt.Sprintf("k%d", i)] = "v"
	}
	if err := m.SetDimensions(dims); err == nil {
		t.Errorf("ディメンションキーが %d 個でもエラーにならない", len(dims))
	}
}

func TestSetDimensionsRejectsReservedKey(t *testing.T) {
	m, _ := metricsTestNew(t, nil)
	if err := m.SetDimensions(map[string]string{reservedRootKey: "x"}); err == nil {
		t.Error("予約キーのディメンションがエラーにならない")
	}
}

func TestSetDimensionsRejectsTooLongValue(t *testing.T) {
	m, _ := metricsTestNew(t, nil)
	err := m.SetDimensions(map[string]string{"k": strings.Repeat("v", maxDimensionValueLength+1)})
	if err == nil {
		t.Error("長すぎるディメンション値がエラーにならない")
	}
}

func TestDimensionKeysAreSorted(t *testing.T) {
	m, buf := metricsTestNew(t, map[string]string{"Z": "1", "A": "2", "M": "3"})
	_ = m.Count("X", 1)
	_ = m.Flush()
	directive := metricsTestDirective(t, metricsTestDecodeLines(t, buf)[0])
	set := directive["Dimensions"].([]any)[0].([]any)
	want := []string{"A", "M", "Z"}
	for i := range want {
		if set[i].(string) != want[i] {
			t.Fatalf("ディメンションキーが辞書順でない: %v", set)
		}
	}
}

func TestEmptyDimensionSetIsEmitted(t *testing.T) {
	m, buf := metricsTestNew(t, nil)
	_ = m.Count("X", 1)
	_ = m.Flush()
	directive := metricsTestDirective(t, metricsTestDecodeLines(t, buf)[0])
	sets, ok := directive["Dimensions"].([]any)
	if !ok || len(sets) != 1 {
		t.Fatalf("Dimensions が 1 セットでない: %#v", directive["Dimensions"])
	}
}

// ── 名前の衝突検出 ────────────────────────────────────────────

func TestMetricNameCollidesWithDimension(t *testing.T) {
	m, _ := metricsTestNew(t, map[string]string{"Service": "agent"})
	if err := m.PutMetric("Service", 1); err == nil {
		t.Error("ディメンション名と同じメトリクス名がエラーにならない")
	}
}

func TestDimensionNameCollidesWithMetric(t *testing.T) {
	m, _ := metricsTestNew(t, nil)
	_ = m.Count("Latency", 1)
	if err := m.SetDimensions(map[string]string{"Latency": "x"}); err == nil {
		t.Error("メトリクス名と同じディメンション名がエラーにならない")
	}
}

func TestPropertyNameCollisions(t *testing.T) {
	m, _ := metricsTestNew(t, map[string]string{"Service": "agent"})
	_ = m.Count("Latency", 1)
	if err := m.SetProperty("Latency", "x"); err == nil {
		t.Error("メトリクス名と同じプロパティ名がエラーにならない")
	}
	if err := m.SetProperty("Service", "x"); err == nil {
		t.Error("ディメンション名と同じプロパティ名がエラーにならない")
	}
}

// ── プロパティ ────────────────────────────────────────────────

func TestSetPropertyIsEmittedButNotAMetric(t *testing.T) {
	m, buf := metricsTestNew(t, nil)
	if err := m.SetProperty("requestId", "abc-123"); err != nil {
		t.Fatalf("SetProperty が失敗した: %v", err)
	}
	_ = m.Count("Requests", 1)
	_ = m.Flush()

	doc := metricsTestDecodeLines(t, buf)[0]
	if doc["requestId"] != "abc-123" {
		t.Errorf("プロパティがルートに載っていない: %v", doc["requestId"])
	}
	for _, n := range metricsTestNames(t, metricsTestDirective(t, doc)) {
		if n == "requestId" {
			t.Error("プロパティがメトリクス定義に混ざっている")
		}
	}
}

func TestSetPropertyRejectsBadKeys(t *testing.T) {
	m, _ := metricsTestNew(t, nil)
	if err := m.SetProperty("", 1); err == nil {
		t.Error("空のプロパティキーがエラーにならない")
	}
	if err := m.SetProperty(reservedRootKey, 1); err == nil {
		t.Error("予約キーのプロパティがエラーにならない")
	}
}

// ── 上限到達時の自動 flush ────────────────────────────────────

func TestAutoFlushOnValueLimit(t *testing.T) {
	m, buf := metricsTestNew(t, nil)
	for i := 0; i < MaxValuesPerMetric+1; i++ {
		if err := m.PutMetric("Latency", float64(i)); err != nil {
			t.Fatalf("%d 件目で失敗した: %v", i, err)
		}
	}
	docs := metricsTestDecodeLines(t, buf)
	if len(docs) != 1 {
		t.Fatalf("上限到達で自動 flush されていない: 出力 %d 行", len(docs))
	}
	if got := len(docs[0]["Latency"].([]any)); got != MaxValuesPerMetric {
		t.Errorf("flush された値の数が違う: %d", got)
	}
}

func TestAutoFlushOnMetricCountLimit(t *testing.T) {
	m, buf := metricsTestNew(t, nil)
	for i := 0; i < MaxMetricsPerDocument+1; i++ {
		if err := m.Count(fmt.Sprintf("M%03d", i), 1); err != nil {
			t.Fatalf("%d 件目で失敗した: %v", i, err)
		}
	}
	docs := metricsTestDecodeLines(t, buf)
	if len(docs) != 1 {
		t.Fatalf("メトリクス定義の上限で自動 flush されていない: 出力 %d 行", len(docs))
	}
	if got := len(metricsTestNames(t, metricsTestDirective(t, docs[0]))); got != MaxMetricsPerDocument {
		t.Errorf("flush されたメトリクス定義の数が違う: %d", got)
	}
}

func TestAutoFlushDoesNotReturnError(t *testing.T) {
	// 上限到達は異常ではない。エラーを返さずに続行できること。
	m, _ := metricsTestNew(t, nil)
	for i := 0; i < MaxValuesPerMetric*2; i++ {
		if err := m.PutMetric("Latency", float64(i)); err != nil {
			t.Fatalf("上限到達がエラーになった: %v", err)
		}
	}
}

// ── 糖衣 ──────────────────────────────────────────────────────

func TestCountUsesCountUnit(t *testing.T) {
	m, buf := metricsTestNew(t, nil)
	_ = m.Count("Requests", 3)
	_ = m.Flush()
	entry := metricsTestDirective(t, metricsTestDecodeLines(t, buf)[0])["Metrics"].([]any)[0].(map[string]any)
	if entry["Unit"] != string(UnitCount) {
		t.Errorf("Count の単位が Count でない: %v", entry["Unit"])
	}
}

func TestDurationUsesMilliseconds(t *testing.T) {
	m, buf := metricsTestNew(t, nil)
	_ = m.Duration("Latency", 1500*time.Millisecond)
	_ = m.Flush()
	doc := metricsTestDecodeLines(t, buf)[0]
	if doc["Latency"] != float64(1500) {
		t.Errorf("ミリ秒に変換されていない: %v", doc["Latency"])
	}
	entry := metricsTestDirective(t, doc)["Metrics"].([]any)[0].(map[string]any)
	if entry["Unit"] != string(UnitMilliseconds) {
		t.Errorf("Duration の単位が Milliseconds でない: %v", entry["Unit"])
	}
}

func TestTimerUsesInjectedClock(t *testing.T) {
	buf := &bytes.Buffer{}
	current := metricsTestFixedTime
	m, err := NewMetrics(MetricsOptions{
		Namespace: "NS",
		Sink:      buf,
		Now:       func() time.Time { return current },
	})
	if err != nil {
		t.Fatalf("NewMetrics が失敗した: %v", err)
	}

	stop := m.Timer("Elapsed")
	current = current.Add(250 * time.Millisecond)
	if err := stop(); err != nil {
		t.Fatalf("Timer の停止が失敗した: %v", err)
	}
	_ = m.Flush()

	doc := metricsTestDecodeLines(t, buf)[0]
	if doc["Elapsed"] != float64(250) {
		t.Errorf("注入した時計で計測されていない: %v", doc["Elapsed"])
	}
}

// ── リトライ層との結線 ────────────────────────────────────────

func TestRetryMetricsHookRecordsAttempt(t *testing.T) {
	m, buf := metricsTestNew(t, nil)
	hook := RetryMetricsHook(m, "PutItem")
	hook(1, 200*time.Millisecond, errors.New("throttled"))
	_ = m.Flush()

	doc := metricsTestDecodeLines(t, buf)[0]
	if doc["RetryAttempt"] != float64(1) {
		t.Errorf("RetryAttempt が記録されていない: %v", doc["RetryAttempt"])
	}
	if doc["RetryDelay"] != float64(200) {
		t.Errorf("RetryDelay がミリ秒で記録されていない: %v", doc["RetryDelay"])
	}
	if doc["retryOperation"] != "PutItem" {
		t.Errorf("操作名がプロパティとして記録されていない: %v", doc["retryOperation"])
	}
	// 操作名はディメンションにしない（課金対象メトリクスが増えるため）。
	directive := metricsTestDirective(t, doc)
	for _, e := range directive["Dimensions"].([]any)[0].([]any) {
		if e.(string) == "retryOperation" {
			t.Error("操作名がディメンションになっている")
		}
	}
}

func TestRetryMetricsHookMatchesRetryLogHookSignature(t *testing.T) {
	// logger.go の RetryLogHook と同じ場所へ差し込めることを型で担保する。
	m, _ := metricsTestNew(t, nil)
	var _ func(attempt int, delay time.Duration, err error) = RetryMetricsHook(m, "op")
	var _ func(attempt int, delay time.Duration, err error) = RetryLogHook(NewLogger(LoggerOptions{}), "op")
}

// ── 並行実行 ──────────────────────────────────────────────────

func TestPutMetricIsGoroutineSafe(t *testing.T) {
	m, _ := metricsTestNew(t, nil)
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_ = m.Count("Concurrent", float64(i))
		}(i)
	}
	wg.Wait()

	m.mu.Lock()
	got := len(m.defs["Concurrent"].values)
	m.mu.Unlock()
	if got != 50 {
		t.Errorf("並行記録で値が落ちている: %d", got)
	}
}

// ── ベンチマーク ──────────────────────────────────────────────

func BenchmarkPutMetric(b *testing.B) {
	m, _ := NewMetrics(MetricsOptions{Namespace: "NS", Sink: &bytes.Buffer{}})
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = m.PutMetric("Latency", float64(i))
	}
}

func BenchmarkFlush(b *testing.B) {
	buf := &bytes.Buffer{}
	m, _ := NewMetrics(MetricsOptions{Namespace: "NS", Sink: buf})
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = m.Count("Requests", 1)
		_ = m.Flush()
		buf.Reset()
	}
}

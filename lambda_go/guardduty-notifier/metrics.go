// metrics.go: CloudWatch EMF（Embedded Metric Format）メトリクスユーティリティ
//
// 標準出力に 1 行の JSON を書くだけで、CloudWatch Logs 側がメトリクスとして
// 抽出してくれる形式（EMF）でメトリクスを出力する。
//
// 同ディレクトリの retry.go / logger.go と同じ「AWS 呼び出しの運用品質を揃える」方針の
// 第 3 弾。RetryMetricsHook() を通じてリトライ層と結線できる（logger.go の
// RetryLogHook() と同じシグネチャ）。
// GuardDuty の検出結果を通知する Lambda は、通知先の障害でリトライが増えやすい。
// 通知の成否と所要時間をメトリクス化しておくと、運用時の切り分けが速くなる。
//
// 設計方針:
//   - PutMetricData API を呼ばない。API のレイテンシが処理時間に乗らず、
//     スロットリングの影響も受けず、追加の IAM 権限も要らない
//   - 上限に達したら例外にせず自動で flush する。メトリクスは副次処理であり、
//     本処理を落とすほうが害が大きい
//   - 一方で「設定ミス」（空の名前空間・不正な単位など）は即座にエラーを返す。
//     CloudWatch は不正な EMF を黙って破棄するため、気づけないまま欠落するほうが有害
//   - NaN / Inf は受け付けない。JSON に非標準トークンが出ると
//     EMF ドキュメント全体が破棄される
//   - 高カーディナリティの値は SetProperty() で持たせる。ディメンションにすると
//     値の種類の数だけ課金対象のカスタムメトリクスが作られる
//   - Now / Sink を差し替え可能にして、テストを決定的に保つ
//   - 複数 goroutine から呼ばれても壊れないよう mutex で保護する
//
// EMF 仕様: https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

// ── EMF 仕様の上限 ────────────────────────────────────────────

const (
	// MaxMetricsPerDocument は 1 つの MetricDirective に入れられるメトリクス定義の数。
	MaxMetricsPerDocument = 100
	// MaxValuesPerMetric は 1 メトリクスあたりの値配列の長さ。
	MaxValuesPerMetric = 100
	// MaxDimensionKeys は 1 つの DimensionSet に入れられるキー数。
	MaxDimensionKeys = 30
	// MaxEventBytes は 1 ログイベントのサイズ上限（1 MB）。
	MaxEventBytes = 1024 * 1024

	// maxNameLength はメトリクス名・名前空間の長さ上限。
	maxNameLength = 1024
	// maxDimensionKeyLength はディメンションキー名の長さ上限。
	maxDimensionKeyLength = 250
	// maxDimensionValueLength はディメンション値の長さ上限。
	maxDimensionValueLength = 1024

	// reservedRootKey は EMF が予約しているルートキー。
	reservedRootKey = "_aws"
)

// ── 単位 ──────────────────────────────────────────────────────

// MetricUnit は CloudWatch がサポートする単位。大文字小文字を区別する。
type MetricUnit string

// CloudWatch が受け付ける単位の列挙。
const (
	UnitSeconds         MetricUnit = "Seconds"
	UnitMicroseconds    MetricUnit = "Microseconds"
	UnitMilliseconds    MetricUnit = "Milliseconds"
	UnitBytes           MetricUnit = "Bytes"
	UnitKilobytes       MetricUnit = "Kilobytes"
	UnitMegabytes       MetricUnit = "Megabytes"
	UnitGigabytes       MetricUnit = "Gigabytes"
	UnitTerabytes       MetricUnit = "Terabytes"
	UnitBits            MetricUnit = "Bits"
	UnitKilobits        MetricUnit = "Kilobits"
	UnitMegabits        MetricUnit = "Megabits"
	UnitGigabits        MetricUnit = "Gigabits"
	UnitTerabits        MetricUnit = "Terabits"
	UnitPercent         MetricUnit = "Percent"
	UnitCount           MetricUnit = "Count"
	UnitBytesPerSecond  MetricUnit = "Bytes/Second"
	UnitCountPerSecond  MetricUnit = "Count/Second"
	UnitSecondsPerCount MetricUnit = "Seconds/Count"
	// UnitNone は既定値。出力時は省略される。
	UnitNone MetricUnit = "None"
)

var validUnits = map[MetricUnit]bool{
	UnitSeconds: true, UnitMicroseconds: true, UnitMilliseconds: true,
	UnitBytes: true, UnitKilobytes: true, UnitMegabytes: true,
	UnitGigabytes: true, UnitTerabytes: true,
	UnitBits: true, UnitKilobits: true, UnitMegabits: true,
	UnitGigabits: true, UnitTerabits: true,
	UnitPercent: true, UnitCount: true,
	UnitBytesPerSecond: true, UnitCountPerSecond: true, UnitSecondsPerCount: true,
	UnitNone: true,
}

// ── オプション ────────────────────────────────────────────────

// MetricsOptions は Metrics の生成オプション。ゼロ値でも動く。
type MetricsOptions struct {
	// Namespace は CloudWatch の名前空間。必須。
	Namespace string
	// Sink は出力先。nil なら os.Stdout。
	Sink io.Writer
	// Now は現在時刻を返す関数。nil なら time.Now。テストで差し替える。
	Now func() time.Time
	// Dimensions は全メトリクスに付与する既定のディメンション。
	Dimensions map[string]string
}

// MetricOption は PutMetric に渡す 1 メトリクス単位の設定。
type MetricOption func(*metricDefinition)

// WithUnit はメトリクスの単位を指定する。
func WithUnit(u MetricUnit) MetricOption {
	return func(d *metricDefinition) { d.Unit = u }
}

// WithHighResolution は高解像度（1 秒）メトリクスとして記録する。
// 指定しない場合は標準解像度（60 秒）。
func WithHighResolution() MetricOption {
	return func(d *metricDefinition) { d.StorageResolution = 1 }
}

// ── 内部表現 ──────────────────────────────────────────────────

type metricDefinition struct {
	Name              string
	Unit              MetricUnit
	StorageResolution int
	values            []float64
}

// Metrics は EMF ドキュメントを組み立てて出力する。
// NewMetrics で生成する。ゼロ値は使えない。
type Metrics struct {
	mu         sync.Mutex
	namespace  string
	sink       io.Writer
	now        func() time.Time
	dimensions map[string]string
	properties map[string]any
	order      []string // メトリクスの追加順（出力を決定的にするため）
	defs       map[string]*metricDefinition
}

// NewMetrics は Metrics を生成する。
//
// 名前空間が空、または既定ディメンションが不正な場合はエラーを返す。
// 「設定ミスは即座に落とす」方針のため、ここでは黙って既定値に倒さない。
func NewMetrics(opts MetricsOptions) (*Metrics, error) {
	ns := strings.TrimSpace(opts.Namespace)
	if ns == "" {
		return nil, fmt.Errorf("metrics: 名前空間が空です")
	}
	if len(ns) > maxNameLength {
		return nil, fmt.Errorf("metrics: 名前空間が長すぎます（%d 文字・上限 %d）", len(ns), maxNameLength)
	}

	m := &Metrics{
		namespace:  ns,
		sink:       opts.Sink,
		now:        opts.Now,
		dimensions: map[string]string{},
		properties: map[string]any{},
		defs:       map[string]*metricDefinition{},
	}
	if m.sink == nil {
		m.sink = os.Stdout
	}
	if m.now == nil {
		m.now = time.Now
	}
	if len(opts.Dimensions) > 0 {
		if err := m.SetDimensions(opts.Dimensions); err != nil {
			return nil, err
		}
	}
	return m, nil
}

// ── ディメンション / プロパティ ────────────────────────────────

// SetDimensions は全メトリクスに付与するディメンションを設定する（既存分は置き換え）。
//
// ディメンションは値の種類ごとに課金対象のカスタムメトリクスを作るため、
// リクエストIDのような高カーディナリティの値は SetProperty を使うこと。
func (m *Metrics) SetDimensions(dims map[string]string) error {
	if len(dims) > MaxDimensionKeys {
		return fmt.Errorf("metrics: ディメンションのキー数が上限を超えています（%d・上限 %d）",
			len(dims), MaxDimensionKeys)
	}
	for k, v := range dims {
		if err := validateDimension(k, v); err != nil {
			return err
		}
	}
	next := make(map[string]string, len(dims))
	for k, v := range dims {
		next[k] = v
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	// メトリクス名とディメンション名は EMF ではどちらもルート直下に載るため、
	// 衝突すると片方が黙って上書きされる。検出してエラーにする。
	for k := range next {
		if _, ok := m.defs[k]; ok {
			return fmt.Errorf("metrics: ディメンション名がメトリクス名と衝突しています: %q", k)
		}
	}
	m.dimensions = next
	return nil
}

func validateDimension(key, value string) error {
	if key == "" || len(key) > maxDimensionKeyLength {
		return fmt.Errorf("metrics: ディメンションキーの長さが不正です: %q", key)
	}
	if key == reservedRootKey {
		return fmt.Errorf("metrics: %q は EMF の予約キーです", reservedRootKey)
	}
	if value == "" || len(value) > maxDimensionValueLength {
		return fmt.Errorf("metrics: ディメンション値の長さが不正です（キー %q）", key)
	}
	return nil
}

// SetProperty はメトリクス化しない付帯情報を EMF ドキュメントに載せる。
//
// リクエストID・ユーザーIDなど、検索には使いたいが
// ディメンションにすると課金が増える値はこちらを使う。
func (m *Metrics) SetProperty(key string, value any) error {
	if key == "" {
		return fmt.Errorf("metrics: プロパティのキーが空です")
	}
	if key == reservedRootKey {
		return fmt.Errorf("metrics: %q は EMF の予約キーです", reservedRootKey)
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.defs[key]; ok {
		return fmt.Errorf("metrics: プロパティ名がメトリクス名と衝突しています: %q", key)
	}
	if _, ok := m.dimensions[key]; ok {
		return fmt.Errorf("metrics: プロパティ名がディメンション名と衝突しています: %q", key)
	}
	m.properties[key] = value
	return nil
}

// ── メトリクスの記録 ──────────────────────────────────────────

// PutMetric はメトリクスの値を 1 つ記録する。
//
// 同じ名前で複数回呼ぶと値配列に追加される（CloudWatch 側で統計値が計算される）。
// 値配列やメトリクス定義が上限に達した場合は、エラーにせず自動で flush してから記録する。
func (m *Metrics) PutMetric(name string, value float64, opts ...MetricOption) error {
	if err := validateMetricName(name); err != nil {
		return err
	}
	if math.IsNaN(value) || math.IsInf(value, 0) {
		// json.Marshal が NaN / Inf でエラーになる。仮に出力できても
		// CloudWatch 側が EMF ドキュメントごと破棄するため、入口で弾く。
		return fmt.Errorf("metrics: メトリクス %q の値が NaN または Inf です", name)
	}

	def := &metricDefinition{Name: name, Unit: UnitNone, StorageResolution: 60}
	for _, opt := range opts {
		opt(def)
	}
	if !validUnits[def.Unit] {
		return fmt.Errorf("metrics: 単位 %q は CloudWatch がサポートしていません", def.Unit)
	}
	if def.StorageResolution != 1 && def.StorageResolution != 60 {
		return fmt.Errorf("metrics: StorageResolution は 1 か 60 のみ有効です（指定値 %d）",
			def.StorageResolution)
	}

	m.mu.Lock()
	if _, ok := m.dimensions[name]; ok {
		m.mu.Unlock()
		return fmt.Errorf("metrics: メトリクス名がディメンション名と衝突しています: %q", name)
	}
	if _, ok := m.properties[name]; ok {
		m.mu.Unlock()
		return fmt.Errorf("metrics: メトリクス名がプロパティ名と衝突しています: %q", name)
	}

	existing, ok := m.defs[name]
	needFlush := false
	switch {
	case ok && len(existing.values) >= MaxValuesPerMetric:
		needFlush = true
	case !ok && len(m.defs) >= MaxMetricsPerDocument:
		needFlush = true
	}
	m.mu.Unlock()

	if needFlush {
		// 上限到達は異常ではなく想定内。落とさずに区切って続ける。
		if err := m.Flush(); err != nil {
			return err
		}
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	cur, ok := m.defs[name]
	if !ok {
		cur = def
		m.defs[name] = cur
		m.order = append(m.order, name)
	}
	cur.values = append(cur.values, value)
	return nil
}

// Count は件数系メトリクス（単位 Count）の糖衣。
func (m *Metrics) Count(name string, value float64) error {
	return m.PutMetric(name, value, WithUnit(UnitCount))
}

// Duration は経過時間をミリ秒で記録する糖衣。
func (m *Metrics) Duration(name string, d time.Duration) error {
	return m.PutMetric(name, float64(d.Milliseconds()), WithUnit(UnitMilliseconds))
}

// Timer は経過時間の計測を開始し、停止用の関数を返す。
//
//	stop := m.Timer("Latency")
//	defer stop()
//
// 時刻取得には Metrics の Now を使うため、テストで決定的にできる。
func (m *Metrics) Timer(name string) func() error {
	start := m.now()
	return func() error {
		return m.Duration(name, m.now().Sub(start))
	}
}

func validateMetricName(name string) error {
	if name == "" {
		return fmt.Errorf("metrics: メトリクス名が空です")
	}
	if len(name) > maxNameLength {
		return fmt.Errorf("metrics: メトリクス名が長すぎます（%d 文字・上限 %d）", len(name), maxNameLength)
	}
	if name == reservedRootKey {
		return fmt.Errorf("metrics: %q は EMF の予約キーです", reservedRootKey)
	}
	return nil
}

// ── 出力 ──────────────────────────────────────────────────────

// Flush は蓄積したメトリクスを EMF ドキュメントとして 1 行の JSON で出力し、
// 内部状態（メトリクス値）をリセットする。
//
// ディメンションとプロパティは次のドキュメントでも使うため保持する。
// 記録されたメトリクスが 0 件のときは何も出力しない。
func (m *Metrics) Flush() error {
	m.mu.Lock()
	if len(m.order) == 0 {
		m.mu.Unlock()
		return nil
	}
	doc, err := m.buildDocument()
	m.defs = map[string]*metricDefinition{}
	m.order = nil
	m.mu.Unlock()
	if err != nil {
		return err
	}

	line, err := json.Marshal(doc)
	if err != nil {
		return fmt.Errorf("metrics: EMF ドキュメントの JSON 化に失敗しました: %w", err)
	}
	if len(line) > MaxEventBytes {
		return fmt.Errorf("metrics: EMF ドキュメントが 1 MB を超えました（%d バイト）", len(line))
	}
	if _, err := fmt.Fprintln(m.sink, string(line)); err != nil {
		return fmt.Errorf("metrics: EMF ドキュメントの出力に失敗しました: %w", err)
	}
	return nil
}

// buildDocument は EMF ドキュメントを組み立てる。呼び出し側で mu を保持していること。
func (m *Metrics) buildDocument() (map[string]any, error) {
	defs := make([]map[string]any, 0, len(m.order))
	doc := make(map[string]any, len(m.order)+len(m.dimensions)+len(m.properties)+1)

	for _, name := range m.order {
		d := m.defs[name]
		entry := map[string]any{"Name": d.Name}
		// 既定値は EMF 側の既定と一致するので省略し、1 行を小さく保つ。
		if d.Unit != UnitNone {
			entry["Unit"] = string(d.Unit)
		}
		if d.StorageResolution == 1 {
			entry["StorageResolution"] = 1
		}
		defs = append(defs, entry)

		if len(d.values) == 1 {
			doc[name] = d.values[0]
		} else {
			doc[name] = d.values
		}
	}

	dimKeys := make([]string, 0, len(m.dimensions))
	for k, v := range m.dimensions {
		dimKeys = append(dimKeys, k)
		doc[k] = v
	}
	sort.Strings(dimKeys) // 出力を決定的にする

	for k, v := range m.properties {
		doc[k] = v
	}

	directive := map[string]any{
		"Namespace": m.namespace,
		"Metrics":   defs,
	}
	// ディメンションが無い場合は空の DimensionSet を 1 つ置く。
	// キーを省略すると CloudWatch 側でメトリクスが抽出されない。
	if len(dimKeys) == 0 {
		directive["Dimensions"] = []any{[]string{}}
	} else {
		directive["Dimensions"] = []any{dimKeys}
	}

	doc[reservedRootKey] = map[string]any{
		// EMF の Timestamp はエポック「ミリ秒」。秒で入れると無効な文書になる。
		"Timestamp":         m.now().UnixMilli(),
		"CloudWatchMetrics": []any{directive},
	}
	return doc, nil
}

// ── リトライ層との結線 ────────────────────────────────────────

// RetryMetricsHook はリトライ発生時にメトリクスを記録するフックを返す。
// logger.go の RetryLogHook と同じシグネチャなので、同じ場所に差し込める。
//
// op はディメンションではなくプロパティとして持たせる。ディメンションにすると
// 呼び出し箇所の数だけ課金対象のメトリクスが増えるため。
func RetryMetricsHook(m *Metrics, op string) func(attempt int, delay time.Duration, err error) {
	return func(attempt int, delay time.Duration, _ error) {
		// メトリクスは副次処理。ここでのエラーで本処理を止めない。
		_ = m.SetProperty("retryOperation", op)
		_ = m.Count("RetryAttempt", 1)
		_ = m.PutMetric("RetryDelay", float64(delay.Milliseconds()), WithUnit(UnitMilliseconds))
		_ = m.PutMetric("RetryAttemptNumber", float64(attempt), WithUnit(UnitCount))
	}
}

// index.ts が logger.ts / metrics.ts に結線されていることを検証するテスト。
//
// logger.ts / metrics.ts 単体の振る舞いは logger.test.ts / metrics.test.ts が
// 網羅している。ここで見るのは「ハンドラーが実際にそれらを通しているか」だけ。

import type { SNSClient } from '@aws-sdk/client-sns';
import {
  DEFAULT_METRICS_NAMESPACE,
  RETRY_OPERATION,
  SNS_RETRY_CONFIG,
  createHandler,
} from './index';
import { createLogger } from './logger';
import { createMetrics } from './metrics';
import type { DynamoDBRecord } from './types';

// ── ヘルパー ──────────────────────────────────────────────────

const makeRecord = (
  incidentId = 'inc-001',
  eventName = 'INSERT',
): DynamoDBRecord => ({
  eventName,
  dynamodb: {
    NewImage: {
      incident_id: { S: incidentId },
      severity: { S: 'CRITICAL' },
      status: { S: 'OPEN' },
      message: { S: 'GuardDuty 検知' },
      resource: { S: 'i-0123456789abcdef0' },
      timestamp: { S: '2026-06-30T00:00:00Z' },
    },
  },
});

/** ログ行とメトリクス行をそれぞれ配列に溜める依存を作る */
const makeDeps = () => {
  const logLines: string[] = [];
  const metricLines: string[] = [];
  return {
    logLines,
    metricLines,
    deps: {
      logger: createLogger({ sink: (line) => void logLines.push(line) }),
      metrics: createMetrics({
        namespace: 'Test/StreamsAlert',
        dimensions: { Handler: 'streams-alert' },
        sink: (line) => void metricLines.push(line),
      }),
    },
  };
};

const noWait = { sleep: async (): Promise<void> => undefined, rand: (): number => 0.5 };

const throttlingError = (): Error => {
  const error = new Error('Rate exceeded');
  error.name = 'ThrottlingException';
  return error;
};

/** 中に機密フィールドを持つエラー（AWS SDK のエラーは付帯情報を抱えることがある） */
const errorWithSecrets = (): Error => {
  const error = new Error('署名エラー') as Error & Record<string, unknown>;
  error.name = 'InvalidSignatureException';
  error.requestHeaders = { authorization: 'AWS4-HMAC-SHA256 Credential=AKIA...', host: 'sns.ap-northeast-1.amazonaws.com' };
  return error;
};

const parseAll = (lines: string[]): Record<string, unknown>[] =>
  lines.map((line) => JSON.parse(line) as Record<string, unknown>);

const findLog = (lines: string[], message: string): Record<string, unknown> | undefined =>
  parseAll(lines).find((entry) => entry['message'] === message);

// ── 構造化ログ ────────────────────────────────────────────────

describe('構造化ログへの結線', () => {
  test('ログは 1 行の JSON で出力される', async () => {
    const { logLines, deps } = makeDeps();
    const send = jest.fn().mockResolvedValue({ MessageId: 'msg-001' });
    const handler = createHandler({ send } as unknown as SNSClient, noWait, deps);

    await handler([makeRecord()]);

    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test('起動ログに recordCount が載る', async () => {
    const { logLines, deps } = makeDeps();
    const send = jest.fn().mockResolvedValue({ MessageId: 'msg-001' });
    const handler = createHandler({ send } as unknown as SNSClient, noWait, deps);

    await handler([makeRecord('inc-001'), makeRecord('inc-002')]);

    expect(findLog(logLines, 'streams-alert handler 起動')?.['recordCount']).toBe(2);
  });

  test('レコード単位のログに incidentId と severity が載る（child ロガー）', async () => {
    const { logLines, deps } = makeDeps();
    const send = jest.fn().mockResolvedValue({ MessageId: 'msg-001' });
    const handler = createHandler({ send } as unknown as SNSClient, noWait, deps);

    await handler([makeRecord('inc-777')]);

    const entry = findLog(logLines, 'SNS 通知成功');
    expect(entry?.['incidentId']).toBe('inc-777');
    expect(entry?.['severity']).toBe('CRITICAL');
    expect(entry?.['messageId']).toBe('msg-001');
  });

  test('処理完了ログに件数が載る', async () => {
    const { logLines, deps } = makeDeps();
    const send = jest.fn().mockResolvedValue({ MessageId: 'msg-001' });
    const handler = createHandler({ send } as unknown as SNSClient, noWait, deps);

    await handler([makeRecord('inc-001'), makeRecord('inc-002', 'REMOVE')]);

    const entry = findLog(logLines, '処理完了');
    expect(entry).toMatchObject({ processed: 1, skipped: 1, errors: 0 });
  });
});

// ── エラーの出力範囲 ──────────────────────────────────────────
//
// logger.ts の redact() は Error を name / message / stack の 3 つだけに展開し、
// 独自プロパティは捨てる。AWS SDK のエラーは署名ヘッダーなどの付帯情報を
// 抱えていることがあるため、それが CloudWatch Logs に残らないことを固定しておく。
// redact() のマスキング（SENSITIVE_KEY_PATTERNS）そのものは logger.test.ts の担当。

describe('エラーの出力範囲', () => {
  test('エラーの付帯プロパティはログに出力されない', async () => {
    const { logLines, deps } = makeDeps();
    const send = jest.fn().mockRejectedValue(errorWithSecrets());
    const handler = createHandler({ send } as unknown as SNSClient, noWait, deps);

    await handler([makeRecord()]);

    const raw = logLines.join('\n');
    // 生の署名ヘッダーが残らないこと
    expect(raw).not.toContain('AWS4-HMAC-SHA256');
    expect(raw).not.toContain('requestHeaders');
  });

  test('展開されるキーは name / message / stack だけ', async () => {
    const { logLines, deps } = makeDeps();
    const send = jest.fn().mockRejectedValue(errorWithSecrets());
    const handler = createHandler({ send } as unknown as SNSClient, noWait, deps);

    await handler([makeRecord()]);

    const entry = findLog(logLines, 'SNS 通知エラー');
    const error = entry?.['error'] as Record<string, unknown>;
    expect(Object.keys(error).sort()).toEqual(['message', 'name', 'stack']);
  });

  test('調査に必要な情報は残る（スタックトレースを含む）', async () => {
    const { logLines, deps } = makeDeps();
    const send = jest.fn().mockRejectedValue(errorWithSecrets());
    const handler = createHandler({ send } as unknown as SNSClient, noWait, deps);

    await handler([makeRecord('inc-555')]);

    const entry = findLog(logLines, 'SNS 通知エラー');
    const error = entry?.['error'] as Record<string, unknown>;
    expect(error['name']).toBe('InvalidSignatureException');
    expect(error['message']).toBe('署名エラー');
    // 旧実装の String(err) では失われていた情報
    expect(typeof error['stack']).toBe('string');
    expect(entry?.['incidentId']).toBe('inc-555');
  });
});

// ── EMF メトリクス ────────────────────────────────────────────

describe('EMF メトリクスへの結線', () => {
  test('flush されて EMF ドキュメントが 1 行出力される', async () => {
    const { metricLines, deps } = makeDeps();
    const send = jest.fn().mockResolvedValue({ MessageId: 'msg-001' });
    const handler = createHandler({ send } as unknown as SNSClient, noWait, deps);

    await handler([makeRecord()]);

    expect(metricLines).toHaveLength(1);
    const doc = JSON.parse(metricLines[0] as string) as Record<string, unknown>;
    const aws = doc['_aws'] as { CloudWatchMetrics: { Namespace: string }[] };
    expect(aws.CloudWatchMetrics[0]?.Namespace).toBe('Test/StreamsAlert');
    expect(doc['Handler']).toBe('streams-alert');
  });

  test('成功時は RecordsReceived / NotificationSuccess / PublishLatency が載る', async () => {
    const { metricLines, deps } = makeDeps();
    const send = jest.fn().mockResolvedValue({ MessageId: 'msg-001' });
    const handler = createHandler({ send } as unknown as SNSClient, noWait, deps);

    await handler([makeRecord()]);

    const doc = JSON.parse(metricLines[0] as string) as Record<string, unknown>;
    expect(doc['RecordsReceived']).toBe(1);
    expect(doc['NotificationSuccess']).toBe(1);
    expect(typeof doc['PublishLatency']).toBe('number');
    expect(doc['NotificationError']).toBeUndefined();
  });

  test('失敗時は NotificationError が載る', async () => {
    const { metricLines, deps } = makeDeps();
    const send = jest.fn().mockRejectedValue(new Error('SNS down'));
    const handler = createHandler({ send } as unknown as SNSClient, noWait, deps);

    await handler([makeRecord()]);

    const doc = JSON.parse(metricLines[0] as string) as Record<string, unknown>;
    expect(doc['NotificationError']).toBe(1);
    expect(doc['NotificationSuccess']).toBeUndefined();
  });

  test('スキップしたレコードは RecordSkipped に計上される', async () => {
    const { metricLines, deps } = makeDeps();
    const send = jest.fn().mockResolvedValue({ MessageId: 'msg-001' });
    const handler = createHandler({ send } as unknown as SNSClient, noWait, deps);

    await handler([makeRecord('inc-001', 'REMOVE'), makeRecord('inc-002', 'REMOVE')]);

    // count() は呼び出しごとに値を積むため、2 回なら値の配列になる
    const doc = JSON.parse(metricLines[0] as string) as Record<string, unknown>;
    expect(doc['RecordSkipped']).toEqual([1, 1]);
  });
});

// ── リトライ層との結線 ────────────────────────────────────────

describe('onRetry が logger と metrics の両方に繋がっている', () => {
  test('リトライで RetryAttempt と retryOperation が記録される', async () => {
    const { metricLines, deps } = makeDeps();
    const send = jest
      .fn()
      .mockRejectedValueOnce(throttlingError())
      .mockResolvedValue({ MessageId: 'msg-001' });
    const handler = createHandler({ send } as unknown as SNSClient, noWait, deps);

    await handler([makeRecord()]);

    const doc = JSON.parse(metricLines[0] as string) as Record<string, unknown>;
    expect(doc['RetryAttempt']).toBe(1);
    expect(doc['RetryAttemptNumber']).toBe(1);
    expect(doc['retryOperation']).toBe(RETRY_OPERATION);
  });

  test('リトライで warn ログが出て incidentId が載る', async () => {
    const { logLines, deps } = makeDeps();
    const send = jest
      .fn()
      .mockRejectedValueOnce(throttlingError())
      .mockResolvedValue({ MessageId: 'msg-001' });
    const handler = createHandler({ send } as unknown as SNSClient, noWait, deps);

    await handler([makeRecord('inc-333')]);

    const warns = parseAll(logLines).filter((e) => e['level'] === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]?.['incidentId']).toBe('inc-333');
    expect(warns[0]?.['operation']).toBe(RETRY_OPERATION);
    expect(warns[0]?.['attempt']).toBe(1);
  });

  test('呼び出し側の onRetry も引き続き呼ばれる', async () => {
    const { deps } = makeDeps();
    const onRetry = jest.fn();
    const send = jest
      .fn()
      .mockRejectedValueOnce(throttlingError())
      .mockResolvedValue({ MessageId: 'msg-001' });
    const handler = createHandler(
      { send } as unknown as SNSClient,
      { ...noWait, onRetry },
      deps,
    );

    await handler([makeRecord()]);

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test('リトライ上限まで失敗すると RetryAttempt が maxAttempts-1 件になる', async () => {
    const { metricLines, deps } = makeDeps();
    const send = jest.fn().mockRejectedValue(throttlingError());
    const handler = createHandler({ send } as unknown as SNSClient, noWait, deps);

    await handler([makeRecord()]);

    const doc = JSON.parse(metricLines[0] as string) as Record<string, unknown>;
    expect(doc['RetryAttempt']).toEqual(
      Array(SNS_RETRY_CONFIG.maxAttempts - 1).fill(1),
    );
  });
});

// ── 既定の組み立て ────────────────────────────────────────────

describe('deps を省略したときの既定', () => {
  const origNamespace = process.env['METRICS_NAMESPACE'];
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    if (origNamespace === undefined) delete process.env['METRICS_NAMESPACE'];
    else process.env['METRICS_NAMESPACE'] = origNamespace;
  });

  test('METRICS_NAMESPACE 未設定なら既定の名前空間を使う', async () => {
    delete process.env['METRICS_NAMESPACE'];
    const send = jest.fn().mockResolvedValue({ MessageId: 'msg-001' });
    const handler = createHandler({ send } as unknown as SNSClient, noWait);

    await handler([makeRecord()]);

    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes(DEFAULT_METRICS_NAMESPACE))).toBe(true);
  });

  test('METRICS_NAMESPACE で名前空間を上書きできる', async () => {
    process.env['METRICS_NAMESPACE'] = 'Custom/Namespace';
    const send = jest.fn().mockResolvedValue({ MessageId: 'msg-001' });
    const handler = createHandler({ send } as unknown as SNSClient, noWait);

    await handler([makeRecord()]);

    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('Custom/Namespace'))).toBe(true);
  });
});

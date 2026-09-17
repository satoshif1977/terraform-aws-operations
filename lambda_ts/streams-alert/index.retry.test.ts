// index.ts と retry.ts の結線を検証するテスト。
//
// retry.ts 単体の振る舞いは retry.test.ts が網羅しているため、ここでは
// 「ハンドラーが SNS Publish をリトライ層に通しているか」だけを対象にする。
// sleep を差し替えて実待機ゼロで回す。

import type { SNSClient } from '@aws-sdk/client-sns';
import { SNS_RETRY_CONFIG, createHandler } from './index';
import type { DynamoDBRecord } from './types';

// ── ヘルパー ──────────────────────────────────────────────────

const makeRecord = (incidentId = 'inc-001'): DynamoDBRecord => ({
  eventName: 'INSERT',
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

/** AWS SDK v3 がスロットリング時に投げる形のエラー */
const throttlingError = (): Error => {
  const error = new Error('Rate exceeded');
  error.name = 'ThrottlingException';
  return error;
};

/** HTTP ステータスだけで判定させるエラー（503） */
const serviceUnavailableError = (): Error => {
  const error = new Error('Service Unavailable') as Error & {
    $metadata: { httpStatusCode: number };
  };
  error.$metadata = { httpStatusCode: 503 };
  return error;
};

/** 実待機せず、決定的な待機時間になるオプション */
const noWait = (onRetry?: (attempt: number, delayMs: number, error: unknown) => void) => ({
  sleep: async (): Promise<void> => undefined,
  rand: (): number => 0.5,
  ...(onRetry ? { onRetry } : {}),
});

// console.warn をテスト出力から隠す（onRetry でログを出しているため）
let warnSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

beforeEach(() => {
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

// ── リトライ設定 ──────────────────────────────────────────────

describe('SNS_RETRY_CONFIG', () => {
  test('Go 版（lambda_go/guardduty-notifier/retry.go）の既定値と揃っている', () => {
    expect(SNS_RETRY_CONFIG).toEqual({
      maxAttempts: 4,
      baseDelayMs: 100,
      maxDelayMs: 5000,
      jitter: true,
    });
  });

  test('共通モジュールの既定値より短い待機になっている', () => {
    // Streams は 1 起動で複数レコードを直列処理するため、待機を短めにしてある
    expect(SNS_RETRY_CONFIG.baseDelayMs).toBeLessThan(500);
    expect(SNS_RETRY_CONFIG.maxDelayMs).toBeLessThan(8000);
  });
});

// ── リトライされるケース ──────────────────────────────────────

describe('SNS Publish のリトライ', () => {
  test('ThrottlingException は再試行され、成功すれば processed に入る', async () => {
    const send = jest
      .fn()
      .mockRejectedValueOnce(throttlingError())
      .mockResolvedValue({ MessageId: 'msg-001' });
    const handler = createHandler({ send } as unknown as SNSClient, noWait());

    const result = await handler([makeRecord()]);

    expect(send).toHaveBeenCalledTimes(2);
    expect(result.processed).toHaveLength(1);
    expect(result.processed[0]?.status).toBe('success');
    expect(result.processed[0]?.message_id).toBe('msg-001');
    expect(result.errors).toHaveLength(0);
  });

  test('HTTP 503 もステータスコードだけで再試行される', async () => {
    const send = jest
      .fn()
      .mockRejectedValueOnce(serviceUnavailableError())
      .mockResolvedValue({ MessageId: 'msg-002' });
    const handler = createHandler({ send } as unknown as SNSClient, noWait());

    const result = await handler([makeRecord()]);

    expect(send).toHaveBeenCalledTimes(2);
    expect(result.processed).toHaveLength(1);
  });

  test('試行回数を使い切ったら errors に記録する', async () => {
    const send = jest.fn().mockRejectedValue(throttlingError());
    const handler = createHandler({ send } as unknown as SNSClient, noWait());

    const result = await handler([makeRecord()]);

    expect(send).toHaveBeenCalledTimes(SNS_RETRY_CONFIG.maxAttempts);
    expect(result.processed).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.reason).toContain('Rate exceeded');
  });

  test('リトライ中もレコードの incident_id / severity は失われない', async () => {
    const send = jest.fn().mockRejectedValue(throttlingError());
    const handler = createHandler({ send } as unknown as SNSClient, noWait());

    const result = await handler([makeRecord('inc-999')]);

    expect(result.errors[0]?.incident_id).toBe('inc-999');
    expect(result.errors[0]?.severity).toBe('CRITICAL');
  });
});

// ── リトライされないケース（既存挙動が壊れていないこと） ────────

describe('リトライ対象外のエラー', () => {
  test('通常の Error は再試行せず 1 回で errors に入る', async () => {
    const send = jest.fn().mockRejectedValue(new Error('SNS 接続エラー'));
    const handler = createHandler({ send } as unknown as SNSClient, noWait());

    const result = await handler([makeRecord()]);

    // ここが 1 であることが「既存テストが実待機で遅くならない」根拠でもある
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.reason).toContain('SNS 接続エラー');
  });

  test('成功するレコードは 1 回の Publish で完了する', async () => {
    const send = jest.fn().mockResolvedValue({ MessageId: 'msg-003' });
    const handler = createHandler({ send } as unknown as SNSClient, noWait());

    await handler([makeRecord()]);

    expect(send).toHaveBeenCalledTimes(1);
  });
});

// ── onRetry の結線 ────────────────────────────────────────────

describe('onRetry', () => {
  test('呼び出し側の onRetry に attempt と delayMs が渡る', async () => {
    const onRetry = jest.fn();
    const send = jest
      .fn()
      .mockRejectedValueOnce(throttlingError())
      .mockResolvedValue({ MessageId: 'msg-004' });
    const handler = createHandler({ send } as unknown as SNSClient, noWait(onRetry));

    await handler([makeRecord()]);

    expect(onRetry).toHaveBeenCalledTimes(1);
    const [attempt, delayMs, error] = onRetry.mock.calls[0] as [number, number, unknown];
    expect(attempt).toBe(1);
    // rand=0.5・baseDelayMs=100 のフルジッターなので 50ms
    expect(delayMs).toBe(50);
    expect((error as Error).name).toBe('ThrottlingException');
  });

  test('待機時間は maxDelayMs を超えない', async () => {
    const delays: number[] = [];
    const send = jest.fn().mockRejectedValue(throttlingError());
    const handler = createHandler(
      { send } as unknown as SNSClient,
      noWait((_attempt, delayMs) => delays.push(delayMs)),
    );

    await handler([makeRecord()]);

    expect(delays).toHaveLength(SNS_RETRY_CONFIG.maxAttempts - 1);
    for (const d of delays) {
      expect(d).toBeLessThanOrEqual(SNS_RETRY_CONFIG.maxDelayMs);
    }
  });

  test('リトライのたびに console.warn へ記録される', async () => {
    const send = jest
      .fn()
      .mockRejectedValueOnce(throttlingError())
      .mockResolvedValue({ MessageId: 'msg-005' });
    const handler = createHandler({ send } as unknown as SNSClient, noWait());

    await handler([makeRecord('inc-777')]);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('inc-777');
  });
});

// ── 複数レコード ──────────────────────────────────────────────

describe('複数レコード', () => {
  test('1 件目がリトライしても 2 件目は独立して処理される', async () => {
    const send = jest
      .fn()
      .mockRejectedValueOnce(throttlingError())
      .mockResolvedValue({ MessageId: 'msg-006' });
    const handler = createHandler({ send } as unknown as SNSClient, noWait());

    const result = await handler([makeRecord('inc-001'), makeRecord('inc-002')]);

    // 1 件目: 失敗 + 成功 = 2 回、2 件目: 成功 = 1 回
    expect(send).toHaveBeenCalledTimes(3);
    expect(result.processed).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
  });

  test('1 件目がリトライ上限に達しても 2 件目は処理される', async () => {
    let calls = 0;
    const send = jest.fn().mockImplementation(() => {
      calls += 1;
      if (calls <= SNS_RETRY_CONFIG.maxAttempts) return Promise.reject(throttlingError());
      return Promise.resolve({ MessageId: 'msg-007' });
    });
    const handler = createHandler({ send } as unknown as SNSClient, noWait());

    const result = await handler([makeRecord('inc-001'), makeRecord('inc-002')]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.incident_id).toBe('inc-001');
    expect(result.processed).toHaveLength(1);
    expect(result.processed[0]?.incident_id).toBe('inc-002');
  });
});

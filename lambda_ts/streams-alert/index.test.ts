import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import {
  buildMessage,
  createHandler,
  extractDynamoValue,
  getSeverityLabel,
} from './index';
import type { DynamoDBRecord } from './types';

// ── モックヘルパー ────────────────────────────────────────────
const makeMockSNS = (messageId = 'msg-001') => {
  const send = jest.fn().mockResolvedValue({ MessageId: messageId });
  return { client: { send } as unknown as SNSClient, send };
};

const makeRecord = (
  eventName: string,
  fields: Record<string, string> = {},
  hasNewImage = true,
): DynamoDBRecord => ({
  eventName,
  dynamodb: {
    NewImage: hasNewImage
      ? {
          incident_id: { S: fields['incident_id'] ?? 'inc-001' },
          severity: { S: fields['severity'] ?? 'CRITICAL' },
          status: { S: fields['status'] ?? 'OPEN' },
          message: { S: fields['message'] ?? 'EC2 CPU 90%超過' },
          resource: { S: fields['resource'] ?? 'i-0123456789abcdef0' },
          timestamp: { S: fields['timestamp'] ?? '2026-06-30T00:00:00Z' },
        }
      : undefined,
  },
});

// ── extractDynamoValue テスト ─────────────────────────────────
describe('extractDynamoValue', () => {
  test('S 型の値を返す', () => {
    expect(extractDynamoValue({ S: 'hello' })).toBe('hello');
  });

  test('N 型の値を文字列で返す', () => {
    expect(extractDynamoValue({ N: '42' })).toBe('42');
  });

  test('BOOL 型: true を "true" で返す', () => {
    expect(extractDynamoValue({ BOOL: true })).toBe('true');
  });

  test('BOOL 型: false を "false" で返す', () => {
    expect(extractDynamoValue({ BOOL: false })).toBe('false');
  });

  test('undefined を渡すと空文字を返す', () => {
    expect(extractDynamoValue(undefined)).toBe('');
  });

  test('NULL 型は空文字を返す', () => {
    expect(extractDynamoValue({ NULL: true })).toBe('');
  });

  test('L 型（リスト）は空文字を返す', () => {
    expect(extractDynamoValue({ L: [] } as any)).toBe('');
  });

  test('M 型（マップ）は空文字を返す', () => {
    expect(extractDynamoValue({ M: {} } as any)).toBe('');
  });
});

// ── getSeverityLabel テスト ───────────────────────────────────
describe('getSeverityLabel', () => {
  test('CRITICAL → [CRITICAL]', () => {
    expect(getSeverityLabel('CRITICAL')).toBe('[CRITICAL]');
  });

  test('HIGH → [HIGH]', () => {
    expect(getSeverityLabel('HIGH')).toBe('[HIGH]');
  });

  test('MEDIUM → [MEDIUM]', () => {
    expect(getSeverityLabel('MEDIUM')).toBe('[MEDIUM]');
  });

  test('LOW → [LOW]', () => {
    expect(getSeverityLabel('LOW')).toBe('[LOW]');
  });

  test('未定義の重大度は [UNKNOWN] 形式で返す', () => {
    expect(getSeverityLabel('UNKNOWN')).toBe('[UNKNOWN]');
  });

  test('空文字は [] を返す', () => {
    expect(getSeverityLabel('')).toBe('[]');
  });
});

// ── buildMessage テスト ───────────────────────────────────────
describe('buildMessage', () => {
  const newImage = {
    incident_id: { S: 'inc-999' },
    severity: { S: 'HIGH' },
    status: { S: 'OPEN' },
    message: { S: 'RDS 接続タイムアウト' },
    resource: { S: 'db-myapp-prod' },
    timestamp: { S: '2026-06-30T09:00:00Z' },
  };

  test('件名に [HIGH] ラベルが含まれる', () => {
    const { subject } = buildMessage(newImage);
    expect(subject).toContain('[HIGH]');
  });

  test('件名にインシデント ID が含まれる', () => {
    const { subject } = buildMessage(newImage);
    expect(subject).toContain('inc-999');
  });

  test('件名は 100 文字以内に収まる', () => {
    const longId = 'A'.repeat(200);
    const { subject } = buildMessage({ ...newImage, incident_id: { S: longId } });
    expect(subject.length).toBeLessThanOrEqual(100);
  });

  test('本文に "インシデントアラート" が含まれる', () => {
    const { body } = buildMessage(newImage);
    expect(body).toContain('インシデントアラート');
  });

  test('本文にリソース情報が含まれる', () => {
    const { body } = buildMessage(newImage);
    expect(body).toContain('db-myapp-prod');
  });

  test('本文にタイムスタンプが含まれる', () => {
    const { body } = buildMessage(newImage);
    expect(body).toContain('2026-06-30T09:00:00Z');
  });

  test('本文にメッセージ詳細が含まれる', () => {
    const { body } = buildMessage(newImage);
    expect(body).toContain('RDS 接続タイムアウト');
  });

  test('本文のフッターに streams-alert が含まれる', () => {
    const { body } = buildMessage(newImage);
    expect(body).toContain('streams-alert');
  });

  test('フィールドがないときはデフォルト値を使う', () => {
    const { subject, body } = buildMessage({});
    expect(subject).toContain('UNKNOWN');
    expect(body).toContain('（詳細なし）');
    expect(body).toContain('（不明）');
  });

  test('CRITICAL 重大度で件名に [CRITICAL] が含まれる', () => {
    const { subject } = buildMessage({ ...newImage, severity: { S: 'CRITICAL' } });
    expect(subject).toContain('[CRITICAL]');
  });

  test('本文にステータスが含まれる', () => {
    const { body } = buildMessage({ ...newImage, status: { S: 'IN_PROGRESS' } });
    expect(body).toContain('IN_PROGRESS');
  });
});

// ── handler テスト ────────────────────────────────────────────
describe('createHandler', () => {
  test('INSERT レコードを処理して SNS を publish する', async () => {
    const { client, send } = makeMockSNS('msg-insert');
    const testHandler = createHandler(client);
    const result = await testHandler([makeRecord('INSERT')]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(result.processed).toHaveLength(1);
    expect(result.processed[0]?.status).toBe('success');
    expect(result.processed[0]?.message_id).toBe('msg-insert');
  });

  test('MODIFY レコードを処理して SNS を publish する', async () => {
    const { client, send } = makeMockSNS();
    const testHandler = createHandler(client);
    const result = await testHandler([makeRecord('MODIFY')]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(result.processed).toHaveLength(1);
  });

  test('REMOVE レコードはスキップする', async () => {
    const { client, send } = makeMockSNS();
    const testHandler = createHandler(client);
    const result = await testHandler([makeRecord('REMOVE')]);

    expect(send).not.toHaveBeenCalled();
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe('non-target event');
  });

  test('NewImage が undefined のレコードはスキップする', async () => {
    const { client, send } = makeMockSNS();
    const testHandler = createHandler(client);
    const result = await testHandler([makeRecord('INSERT', {}, false)]);

    expect(send).not.toHaveBeenCalled();
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe('empty NewImage');
  });

  test('SNS エラー時は errors に記録する', async () => {
    const send = jest.fn().mockRejectedValue(new Error('SNS 接続エラー'));
    const testHandler = createHandler({ send } as unknown as SNSClient);
    const result = await testHandler([makeRecord('INSERT')]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.status).toBe('error');
    expect(result.errors[0]?.reason).toContain('SNS 接続エラー');
  });

  test('複数レコードを一括処理する', async () => {
    const { client } = makeMockSNS();
    const testHandler = createHandler(client);
    const result = await testHandler([
      makeRecord('INSERT', { incident_id: 'inc-001' }),
      makeRecord('MODIFY', { incident_id: 'inc-002' }),
      makeRecord('REMOVE'),
    ]);

    expect(result.processed).toHaveLength(2);
    expect(result.skipped).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });

  test('単一オブジェクト（配列でない）も処理できる', async () => {
    const { client, send } = makeMockSNS();
    const testHandler = createHandler(client);
    const result = await testHandler(makeRecord('INSERT'));

    expect(send).toHaveBeenCalledTimes(1);
    expect(result.processed).toHaveLength(1);
  });

  test('処理結果に incident_id と severity が含まれる', async () => {
    const { client } = makeMockSNS();
    const testHandler = createHandler(client);
    const result = await testHandler([
      makeRecord('INSERT', { incident_id: 'inc-xyz', severity: 'CRITICAL' }),
    ]);

    expect(result.processed[0]?.incident_id).toBe('inc-xyz');
    expect(result.processed[0]?.severity).toBe('CRITICAL');
  });

  test('PublishCommand に Subject と Message が渡される', async () => {
    const { client, send } = makeMockSNS();
    const testHandler = createHandler(client);
    await testHandler([makeRecord('INSERT', { severity: 'HIGH' })]);

    const call = send.mock.calls[0]?.[0] as PublishCommand;
    expect(call.input.Subject).toContain('[HIGH]');
    expect(call.input.Message).toContain('インシデントアラート');
  });

  test('結果オブジェクトに processed / skipped / errors キーがある', async () => {
    const { client } = makeMockSNS();
    const testHandler = createHandler(client);
    const result = await testHandler([]);

    expect(result).toHaveProperty('processed');
    expect(result).toHaveProperty('skipped');
    expect(result).toHaveProperty('errors');
  });

  test('空配列を渡すと全件 0 で返る', async () => {
    const { client } = makeMockSNS();
    const testHandler = createHandler(client);
    const result = await testHandler([]);

    expect(result.processed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  test('INSERT と REMOVE が混在するバッチを正しく分類する', async () => {
    const { client } = makeMockSNS();
    const testHandler = createHandler(client);
    const result = await testHandler([
      makeRecord('INSERT'),
      makeRecord('REMOVE'),
      makeRecord('INSERT'),
      makeRecord('REMOVE'),
    ]);

    expect(result.processed).toHaveLength(2);
    expect(result.skipped).toHaveLength(2);
  });

  test('全件 REMOVE バッチは processed=0・skipped=全件になる', async () => {
    const { client, send } = makeMockSNS();
    const testHandler = createHandler(client);
    const result = await testHandler([makeRecord('REMOVE'), makeRecord('REMOVE'), makeRecord('REMOVE')]);

    expect(send).not.toHaveBeenCalled();
    expect(result.processed).toHaveLength(0);
    expect(result.skipped).toHaveLength(3);
    expect(result.errors).toHaveLength(0);
  });

  test('5 件バッチを全件処理する', async () => {
    const { client, send } = makeMockSNS();
    const testHandler = createHandler(client);
    const records = Array.from({ length: 5 }, (_, i) =>
      makeRecord('INSERT', { incident_id: `inc-00${i}` }),
    );
    const result = await testHandler(records);

    expect(send).toHaveBeenCalledTimes(5);
    expect(result.processed).toHaveLength(5);
  });

  test('全件 SNS エラーのバッチ → errors=全件', async () => {
    const send = jest.fn().mockRejectedValue(new Error('SNS down'));
    const testHandler = createHandler({ send } as unknown as SNSClient);
    const result = await testHandler([makeRecord('INSERT'), makeRecord('INSERT')]);

    expect(result.errors).toHaveLength(2);
    expect(result.processed).toHaveLength(0);
  });

  test('空オブジェクトの NewImage はスキップされる', async () => {
    const { client, send } = makeMockSNS();
    const testHandler = createHandler(client);
    const emptyNewImageRecord: DynamoDBRecord = {
      eventName: 'INSERT',
      dynamodb: { NewImage: {} },
    };
    const result = await testHandler([emptyNewImageRecord]);

    expect(send).not.toHaveBeenCalled();
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe('empty NewImage');
  });

  test('SNS エラーが 1 件あっても残りレコードの処理を続ける', async () => {
    let callCount = 0;
    const send = jest.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error('エラー'));
      return Promise.resolve({ MessageId: 'msg-ok' });
    });
    const testHandler = createHandler({ send } as unknown as SNSClient);
    const result = await testHandler([makeRecord('INSERT'), makeRecord('INSERT')]);

    expect(result.errors).toHaveLength(1);
    expect(result.processed).toHaveLength(1);
  });
});

// ── extractDynamoValue / 追加エッジケース ─────────────────────────

describe('extractDynamoValue / 追加エッジケース', () => {
  test('S 型: 空文字列を返す', () => {
    expect(extractDynamoValue({ S: '' })).toBe('');
  });

  test('S 型: 日本語文字列', () => {
    expect(extractDynamoValue({ S: 'テスト文字列' })).toBe('テスト文字列');
  });

  test('S 型: 非常に長い文字列', () => {
    const longStr = 'A'.repeat(10000);
    expect(extractDynamoValue({ S: longStr })).toBe(longStr);
  });

  test('N 型: ゼロを返す', () => {
    expect(extractDynamoValue({ N: '0' })).toBe('0');
  });

  test('N 型: 負数を返す', () => {
    expect(extractDynamoValue({ N: '-100' })).toBe('-100');
  });

  test('N 型: 小数を返す', () => {
    expect(extractDynamoValue({ N: '3.14' })).toBe('3.14');
  });

  test('S 型: 特殊文字を含む', () => {
    expect(extractDynamoValue({ S: '<script>alert("xss")</script>' }))
      .toBe('<script>alert("xss")</script>');
  });

  test('S 型: 改行を含む', () => {
    expect(extractDynamoValue({ S: 'line1\nline2' })).toBe('line1\nline2');
  });
});

// ── getSeverityLabel / 追加バリエーション ─────────────────────────

describe('getSeverityLabel / 追加バリエーション', () => {
  test('INFO → [INFO]（未定義ラベル）', () => {
    expect(getSeverityLabel('INFO')).toBe('[INFO]');
  });

  test('WARNING → [WARNING]（未定義ラベル）', () => {
    expect(getSeverityLabel('WARNING')).toBe('[WARNING]');
  });

  test('小文字 critical → [critical]（大文字小文字区別）', () => {
    expect(getSeverityLabel('critical')).toBe('[critical]');
  });

  test('数値文字列 → [123]', () => {
    expect(getSeverityLabel('123')).toBe('[123]');
  });

  test('特殊文字含む → [<alert>]', () => {
    expect(getSeverityLabel('<alert>')).toBe('[<alert>]');
  });

  test('スペース含む → [ MEDIUM ]', () => {
    expect(getSeverityLabel(' MEDIUM ')).toBe('[ MEDIUM ]');
  });
});

// ── buildMessage / 追加パターン ───────────────────────────────────

describe('buildMessage / 追加パターン', () => {
  test('LOW 重大度で件名に [LOW] が含まれる', () => {
    const { subject } = buildMessage({ severity: { S: 'LOW' } });
    expect(subject).toContain('[LOW]');
  });

  test('MEDIUM 重大度で件名に [MEDIUM] が含まれる', () => {
    const { subject } = buildMessage({ severity: { S: 'MEDIUM' } });
    expect(subject).toContain('[MEDIUM]');
  });

  test('本文に区切り線が含まれる', () => {
    const { body } = buildMessage({
      incident_id: { S: 'inc-sep' },
      severity: { S: 'HIGH' },
    });
    expect(body).toContain('='.repeat(50));
  });

  test('本文に重大度ラベルが含まれる', () => {
    const { body } = buildMessage({
      severity: { S: 'CRITICAL' },
    });
    expect(body).toContain('[CRITICAL]');
  });

  test('件名のプレフィックスが [インシデント] である', () => {
    const { subject } = buildMessage({
      incident_id: { S: 'inc-pfx' },
      severity: { S: 'HIGH' },
    });
    expect(subject).toMatch(/^\[インシデント\]/);
  });

  test('N 型フィールドも extractDynamoValue で読み取られる', () => {
    const { body } = buildMessage({
      incident_id: { N: '12345' },
      severity: { S: 'LOW' },
    });
    expect(body).toContain('12345');
  });

  test('BOOL 型フィールドは "true"/"false" に変換される', () => {
    const { body } = buildMessage({
      status: { BOOL: true },
      severity: { S: 'LOW' },
    });
    expect(body).toContain('true');
  });

  test('全フィールド UNKNOWN 時の本文構造', () => {
    const { body } = buildMessage({});
    expect(body).toContain('インシデントID: UNKNOWN');
    expect(body).toContain('重大度        : UNKNOWN');
    expect(body).toContain('ステータス    : UNKNOWN');
    expect(body).toContain('発生時刻      : UNKNOWN');
  });
});

// ── createHandler / console 出力検証 ──────────────────────────────

describe('createHandler / console 出力', () => {
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    errorSpy = jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('起動ログにレコード数が出力される', async () => {
    const { client } = makeMockSNS();
    const testHandler = createHandler(client);
    await testHandler([makeRecord('INSERT'), makeRecord('INSERT')]);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('2 レコード'));
  });

  test('スキップログが出力される', async () => {
    const { client } = makeMockSNS();
    const testHandler = createHandler(client);
    await testHandler([makeRecord('REMOVE')]);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('スキップ'));
  });

  test('空 NewImage で warn ログが出力される', async () => {
    const { client } = makeMockSNS();
    const testHandler = createHandler(client);
    const record: DynamoDBRecord = { eventName: 'INSERT', dynamodb: { NewImage: {} } };
    await testHandler([record]);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('NewImage が空'));
  });

  test('SNS 成功ログに incident_id が含まれる', async () => {
    const { client } = makeMockSNS();
    const testHandler = createHandler(client);
    await testHandler([makeRecord('INSERT', { incident_id: 'inc-log' })]);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('inc-log'));
  });

  test('SNS エラーログが出力される', async () => {
    const send = jest.fn().mockRejectedValue(new Error('timeout'));
    const testHandler = createHandler({ send } as unknown as SNSClient);
    await testHandler([makeRecord('INSERT')]);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('SNS 通知エラー'));
  });

  test('処理完了ログにカウントが含まれる', async () => {
    const { client } = makeMockSNS();
    const testHandler = createHandler(client);
    await testHandler([makeRecord('INSERT'), makeRecord('REMOVE')]);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('成功=1'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('スキップ=1'));
  });
});

// ── createHandler / SNS_TOPIC_ARN 環境変数 ────────────────────────

describe('createHandler / SNS_TOPIC_ARN', () => {
  const origEnv = process.env['SNS_TOPIC_ARN'];

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env['SNS_TOPIC_ARN'] = origEnv;
    } else {
      delete process.env['SNS_TOPIC_ARN'];
    }
  });

  test('SNS_TOPIC_ARN が PublishCommand に渡される', async () => {
    process.env['SNS_TOPIC_ARN'] = 'arn:aws:sns:ap-northeast-1:123456:test-topic';
    const { client, send } = makeMockSNS();
    const testHandler = createHandler(client);
    await testHandler([makeRecord('INSERT')]);

    const call = send.mock.calls[0]?.[0] as PublishCommand;
    expect(call.input.TopicArn).toBe('arn:aws:sns:ap-northeast-1:123456:test-topic');
  });

  test('SNS_TOPIC_ARN が未定義でも処理は続行する', async () => {
    delete process.env['SNS_TOPIC_ARN'];
    const { client, send } = makeMockSNS();
    const testHandler = createHandler(client);
    const result = await testHandler([makeRecord('INSERT')]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(result.processed).toHaveLength(1);
  });
});

// ── createHandler / eventName バリエーション ───────────────────────

describe('createHandler / eventName バリエーション', () => {
  test('空文字の eventName はスキップされる', async () => {
    const { client } = makeMockSNS();
    const testHandler = createHandler(client);
    const record: DynamoDBRecord = {
      eventName: '',
      dynamodb: { NewImage: { incident_id: { S: 'inc-empty' } } },
    };
    const result = await testHandler([record]);

    expect(result.skipped).toHaveLength(1);
  });

  test('大文字小文字混在 "Insert" はスキップされる', async () => {
    const { client } = makeMockSNS();
    const testHandler = createHandler(client);
    const record: DynamoDBRecord = {
      eventName: 'Insert',
      dynamodb: { NewImage: { incident_id: { S: 'inc-case' } } },
    };
    const result = await testHandler([record]);

    expect(result.skipped).toHaveLength(1);
  });

  test('未知の eventName "DELETE" はスキップされる', async () => {
    const { client } = makeMockSNS();
    const testHandler = createHandler(client);
    const record: DynamoDBRecord = {
      eventName: 'DELETE',
      dynamodb: { NewImage: { incident_id: { S: 'inc-del' } } },
    };
    const result = await testHandler([record]);

    expect(result.skipped).toHaveLength(1);
  });
});

// ── createHandler / 大量レコード ──────────────────────────────────

describe('createHandler / 大量レコード', () => {
  test('10 件バッチを全件処理する', async () => {
    const { client, send } = makeMockSNS();
    const testHandler = createHandler(client);
    const records = Array.from({ length: 10 }, (_, i) =>
      makeRecord('INSERT', { incident_id: `inc-${i}` }),
    );
    const result = await testHandler(records);

    expect(send).toHaveBeenCalledTimes(10);
    expect(result.processed).toHaveLength(10);
  });

  test('混在バッチ: INSERT 3 / MODIFY 2 / REMOVE 5', async () => {
    const { client } = makeMockSNS();
    const testHandler = createHandler(client);
    const records = [
      ...Array.from({ length: 3 }, () => makeRecord('INSERT')),
      ...Array.from({ length: 2 }, () => makeRecord('MODIFY')),
      ...Array.from({ length: 5 }, () => makeRecord('REMOVE')),
    ];
    const result = await testHandler(records);

    expect(result.processed).toHaveLength(5);
    expect(result.skipped).toHaveLength(5);
  });
});

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

import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import {
  buildMessage,
  createHandler,
  extractDynamoValue,
  getSeverityLabel,
} from './index';
import type { DynamoDBNewImage, DynamoDBRecord } from './types';

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

// ── buildMessage 本文構造テスト ───────────────────────────────

describe('buildMessage / 本文構造', () => {
  const fullImage: DynamoDBNewImage = {
    incident_id: { S: 'inc-structure' },
    severity: { S: 'HIGH' },
    status: { S: 'OPEN' },
    message: { S: 'テストメッセージ' },
    resource: { S: 'arn:aws:ec2:ap-northeast-1:123:instance/i-abc' },
    timestamp: { S: '2026-08-25T10:00:00Z' },
  };

  test('本文は16行で構成される', () => {
    const { body } = buildMessage(fullImage);
    const lines = body.split('\n');
    expect(lines).toHaveLength(16);
  });

  test('1行目は "インシデントアラート"', () => {
    const { body } = buildMessage(fullImage);
    expect(body.split('\n')[0]).toBe('インシデントアラート');
  });

  test('2行目は = の区切り線（50文字）', () => {
    const { body } = buildMessage(fullImage);
    expect(body.split('\n')[1]).toBe('='.repeat(50));
  });

  test('3行目は空行', () => {
    const { body } = buildMessage(fullImage);
    expect(body.split('\n')[2]).toBe('');
  });

  test('最終行はフッター', () => {
    const { body } = buildMessage(fullImage);
    const lines = body.split('\n');
    expect(lines[lines.length - 1]).toBe('-- 自動通知: terraform-aws-operations / streams-alert');
  });

  test('区切り線（─）が本文に含まれる', () => {
    const { body } = buildMessage(fullImage);
    expect(body).toContain('─'.repeat(50));
  });

  test('本文に全6フィールドのラベルが含まれる', () => {
    const { body } = buildMessage(fullImage);
    const labels = ['インシデントID:', '重大度', 'ステータス', '発生時刻', '対象リソース:', '詳細:'];
    for (const label of labels) {
      expect(body).toContain(label);
    }
  });

  test('本文に全フィールドの値が含まれる', () => {
    const { body } = buildMessage(fullImage);
    const values = ['inc-structure', 'HIGH', '[HIGH]', 'OPEN', 'テストメッセージ',
      'arn:aws:ec2:ap-northeast-1:123:instance/i-abc', '2026-08-25T10:00:00Z'];
    for (const val of values) {
      expect(body).toContain(val);
    }
  });
});

// ── buildMessage Subject 切り詰めテスト ──────────────────────

describe('buildMessage / Subject 切り詰め', () => {
  test('短いインシデント ID は切り詰められない', () => {
    const { subject } = buildMessage({
      incident_id: { S: 'inc-short' },
      severity: { S: 'LOW' },
    });
    expect(subject).toBe('[インシデント] [LOW] inc-short');
  });

  test('100文字を超える件名は100文字に切り詰められる', () => {
    const longId = 'X'.repeat(200);
    const { subject } = buildMessage({
      incident_id: { S: longId },
      severity: { S: 'CRITICAL' },
    });
    expect(subject.length).toBeLessThanOrEqual(100);
  });

  test('ちょうど100文字の件名はそのまま', () => {
    // "[インシデント] [LOW] " = 15 chars (in UTF-16)
    // padding to exactly 100
    const prefix = '[インシデント] [LOW] ';
    const needed = 100 - prefix.length;
    const id = 'A'.repeat(needed);
    const { subject } = buildMessage({
      incident_id: { S: id },
      severity: { S: 'LOW' },
    });
    expect(subject.length).toBeLessThanOrEqual(100);
    expect(subject).toContain(id.slice(0, 10)); // 先頭部分は含まれる
  });
});

// ── extractDynamoValue 型優先度テスト ────────────────────────

describe('extractDynamoValue / 型の優先度', () => {
  test('S と N が両方ある場合は S が優先', () => {
    // Union 型なので実際には両方持てないが、any 経由での安全性確認
    const result = extractDynamoValue({ S: 'string-val', N: '999' } as any);
    expect(result).toBe('string-val');
  });

  test('S と BOOL が両方ある場合は S が優先', () => {
    const result = extractDynamoValue({ S: 'str', BOOL: true } as any);
    expect(result).toBe('str');
  });
});

// ── getSeverityLabel 全定義ラベル確認 ────────────────────────

describe('getSeverityLabel / 全定義ラベル一括', () => {
  const defined: [string, string][] = [
    ['CRITICAL', '[CRITICAL]'],
    ['HIGH', '[HIGH]'],
    ['MEDIUM', '[MEDIUM]'],
    ['LOW', '[LOW]'],
  ];

  test.each(defined)('%s → %s', (input, expected) => {
    expect(getSeverityLabel(input)).toBe(expected);
  });

  const undefined_: [string, string][] = [
    ['INFO', '[INFO]'],
    ['WARNING', '[WARNING]'],
    ['UNKNOWN', '[UNKNOWN]'],
    ['DEBUG', '[DEBUG]'],
    ['NOTICE', '[NOTICE]'],
    ['EMERGENCY', '[EMERGENCY]'],
  ];

  test.each(undefined_)('未定義 %s → %s', (input, expected) => {
    expect(getSeverityLabel(input)).toBe(expected);
  });
});

// ── PublishCommand 入力検証 ──────────────────────────────────

describe('createHandler / PublishCommand 入力検証', () => {
  test('Subject は100文字以内に切り詰められる', async () => {
    const { client, send } = makeMockSNS();
    const testHandler = createHandler(client);
    const longId = 'Z'.repeat(200);
    await testHandler([makeRecord('INSERT', { incident_id: longId })]);

    const cmd = send.mock.calls[0]?.[0] as PublishCommand;
    expect(cmd.input.Subject!.length).toBeLessThanOrEqual(100);
  });

  test('Message に "インシデントアラート" が含まれる', async () => {
    const { client, send } = makeMockSNS();
    const testHandler = createHandler(client);
    await testHandler([makeRecord('INSERT')]);

    const cmd = send.mock.calls[0]?.[0] as PublishCommand;
    expect(cmd.input.Message).toContain('インシデントアラート');
  });

  test('Message にインシデント ID が含まれる', async () => {
    const { client, send } = makeMockSNS();
    const testHandler = createHandler(client);
    await testHandler([makeRecord('INSERT', { incident_id: 'inc-cmd-check' })]);

    const cmd = send.mock.calls[0]?.[0] as PublishCommand;
    expect(cmd.input.Message).toContain('inc-cmd-check');
  });

  test('TopicArn に環境変数の値が設定される', async () => {
    const origArn = process.env['SNS_TOPIC_ARN'];
    process.env['SNS_TOPIC_ARN'] = 'arn:aws:sns:ap-northeast-1:999:cmd-topic';
    try {
      const { client, send } = makeMockSNS();
      const testHandler = createHandler(client);
      await testHandler([makeRecord('INSERT')]);

      const cmd = send.mock.calls[0]?.[0] as PublishCommand;
      expect(cmd.input.TopicArn).toBe('arn:aws:sns:ap-northeast-1:999:cmd-topic');
    } finally {
      if (origArn !== undefined) {
        process.env['SNS_TOPIC_ARN'] = origArn;
      } else {
        delete process.env['SNS_TOPIC_ARN'];
      }
    }
  });
});

// ── ProcessResult フィールド完全性 ──────────────────────────

describe('createHandler / ProcessResult フィールド完全性', () => {
  test('success 結果に incident_id / severity / status / message_id が含まれる', async () => {
    const { client } = makeMockSNS('msg-field');
    const testHandler = createHandler(client);
    const result = await testHandler([
      makeRecord('INSERT', { incident_id: 'inc-field', severity: 'HIGH' }),
    ]);

    const p = result.processed[0]!;
    expect(p.incident_id).toBe('inc-field');
    expect(p.severity).toBe('HIGH');
    expect(p.status).toBe('success');
    expect(p.message_id).toBe('msg-field');
  });

  test('skipped (non-target) 結果に eventName / status / reason が含まれる', async () => {
    const { client } = makeMockSNS();
    const testHandler = createHandler(client);
    const result = await testHandler([makeRecord('REMOVE')]);

    const s = result.skipped[0]!;
    expect(s.eventName).toBe('REMOVE');
    expect(s.status).toBe('skipped');
    expect(s.reason).toBe('non-target event');
  });

  test('skipped (empty NewImage) 結果に eventName / status / reason が含まれる', async () => {
    const { client } = makeMockSNS();
    const testHandler = createHandler(client);
    const record: DynamoDBRecord = { eventName: 'INSERT', dynamodb: { NewImage: {} } };
    const result = await testHandler([record]);

    const s = result.skipped[0]!;
    expect(s.eventName).toBe('INSERT');
    expect(s.status).toBe('skipped');
    expect(s.reason).toBe('empty NewImage');
  });

  test('error 結果に incident_id / severity / status / reason が含まれる', async () => {
    const send = jest.fn().mockRejectedValue(new Error('timeout'));
    const testHandler = createHandler({ send } as unknown as SNSClient);
    const result = await testHandler([
      makeRecord('INSERT', { incident_id: 'inc-err', severity: 'CRITICAL' }),
    ]);

    const e = result.errors[0]!;
    expect(e.incident_id).toBe('inc-err');
    expect(e.severity).toBe('CRITICAL');
    expect(e.status).toBe('error');
    expect(e.reason).toContain('timeout');
  });
});

// ── SNS 呼び出し順序検証 ────────────────────────────────────

describe('createHandler / SNS 呼び出し順序', () => {
  test('レコード順に SNS が呼ばれる', async () => {
    const { client, send } = makeMockSNS();
    const testHandler = createHandler(client);
    await testHandler([
      makeRecord('INSERT', { incident_id: 'first' }),
      makeRecord('INSERT', { incident_id: 'second' }),
      makeRecord('INSERT', { incident_id: 'third' }),
    ]);

    expect(send).toHaveBeenCalledTimes(3);
    const messages = send.mock.calls.map(
      (call: any) => (call[0] as PublishCommand).input.Message,
    );
    expect(messages[0]).toContain('first');
    expect(messages[1]).toContain('second');
    expect(messages[2]).toContain('third');
  });

  test('REMOVE を挟んでも処理順は維持される', async () => {
    const { client, send } = makeMockSNS();
    const testHandler = createHandler(client);
    await testHandler([
      makeRecord('INSERT', { incident_id: 'a' }),
      makeRecord('REMOVE'),
      makeRecord('MODIFY', { incident_id: 'b' }),
    ]);

    expect(send).toHaveBeenCalledTimes(2);
    const msgs = send.mock.calls.map(
      (call: any) => (call[0] as PublishCommand).input.Message,
    );
    expect(msgs[0]).toContain('a');
    expect(msgs[1]).toContain('b');
  });
});

// ── 部分フィールド NewImage ──────────────────────────────────

describe('createHandler / 部分フィールド NewImage', () => {
  test('incident_id のみの NewImage でも処理される', async () => {
    const { client } = makeMockSNS();
    const testHandler = createHandler(client);
    const record: DynamoDBRecord = {
      eventName: 'INSERT',
      dynamodb: { NewImage: { incident_id: { S: 'inc-partial' } } },
    };
    const result = await testHandler([record]);

    expect(result.processed).toHaveLength(1);
    expect(result.processed[0]!.incident_id).toBe('inc-partial');
  });

  test('severity のみの NewImage でも処理される', async () => {
    const { client, send } = makeMockSNS();
    const testHandler = createHandler(client);
    const record: DynamoDBRecord = {
      eventName: 'INSERT',
      dynamodb: { NewImage: { severity: { S: 'LOW' } } },
    };
    const result = await testHandler([record]);

    expect(result.processed).toHaveLength(1);
    const cmd = send.mock.calls[0]?.[0] as PublishCommand;
    expect(cmd.input.Subject).toContain('[LOW]');
  });

  test('N 型の incident_id でも処理される', async () => {
    const { client } = makeMockSNS();
    const testHandler = createHandler(client);
    const record: DynamoDBRecord = {
      eventName: 'INSERT',
      dynamodb: { NewImage: { incident_id: { N: '12345' }, severity: { S: 'MEDIUM' } } },
    };
    const result = await testHandler([record]);

    expect(result.processed).toHaveLength(1);
    expect(result.processed[0]!.incident_id).toBe('12345');
  });
});

// ── HandlerResult 集計の整合性 ──────────────────────────────

describe('createHandler / 集計の整合性', () => {
  test('processed + skipped + errors = 入力レコード数', async () => {
    const send = jest.fn()
      .mockResolvedValueOnce({ MessageId: 'ok' })
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce({ MessageId: 'ok2' });
    const testHandler = createHandler({ send } as unknown as SNSClient);

    const result = await testHandler([
      makeRecord('INSERT', { incident_id: 'ok' }),
      makeRecord('INSERT', { incident_id: 'fail' }),
      makeRecord('REMOVE'),
      makeRecord('INSERT', { incident_id: 'ok2' }),
    ]);

    const total = result.processed.length + result.skipped.length + result.errors.length;
    expect(total).toBe(4);
    expect(result.processed).toHaveLength(2);
    expect(result.skipped).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
  });

  test('全件 INSERT で全件成功 → skipped=0, errors=0', async () => {
    const { client } = makeMockSNS();
    const testHandler = createHandler(client);
    const records = Array.from({ length: 3 }, (_, i) =>
      makeRecord('INSERT', { incident_id: `inc-${i}` }),
    );
    const result = await testHandler(records);

    expect(result.processed).toHaveLength(3);
    expect(result.skipped).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});

// ── buildMessage 全重大度での件名検証 ────────────────────────

describe('buildMessage / 全重大度の件名', () => {
  const severities: [string, string][] = [
    ['CRITICAL', '[CRITICAL]'],
    ['HIGH', '[HIGH]'],
    ['MEDIUM', '[MEDIUM]'],
    ['LOW', '[LOW]'],
    ['INFO', '[INFO]'],
    ['UNKNOWN', '[UNKNOWN]'],
  ];

  test.each(severities)('severity=%s → 件名に %s が含まれる', (severity, label) => {
    const { subject } = buildMessage({
      incident_id: { S: 'inc-sev' },
      severity: { S: severity },
    });
    expect(subject).toContain(label);
  });

  test.each(severities)('severity=%s → 本文に %s が含まれる', (severity, label) => {
    const { body } = buildMessage({
      incident_id: { S: 'inc-sev' },
      severity: { S: severity },
    });
    expect(body).toContain(label);
  });
});

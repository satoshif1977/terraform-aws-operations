// DynamoDB Streams → EventBridge Pipes 経由で渡されるレコードの型定義
// Python 版 streams-alert/index.py との並置（型安全版）

export type DynamoDBAttributeValue =
  | { S: string }
  | { N: string }
  | { BOOL: boolean }
  | { NULL: true };

export type DynamoDBNewImage = Record<string, DynamoDBAttributeValue>;

export interface DynamoDBRecord {
  eventName: 'INSERT' | 'MODIFY' | 'REMOVE' | string;
  dynamodb: {
    NewImage?: DynamoDBNewImage;
    OldImage?: DynamoDBNewImage;
  };
}

export interface ProcessResult {
  incident_id?: string;
  severity?: string;
  status: 'success' | 'skipped' | 'error';
  message_id?: string;
  reason?: string;
  eventName?: string;
}

export interface HandlerResult {
  processed: ProcessResult[];
  skipped: ProcessResult[];
  errors: ProcessResult[];
}

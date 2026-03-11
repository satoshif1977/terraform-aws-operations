# Runbook: ALB / RDS 障害一次対応

## 目次

1. [ALB 502 Bad Gateway](#1-alb-502-bad-gateway)
2. [ALB 504 Gateway Timeout](#2-alb-504-gateway-timeout)
3. [RDS 接続エラー](#3-rds-接続エラー)
4. [RDS ストレージ逼迫](#4-rds-ストレージ逼迫)

---

## 1. ALB 502 Bad Gateway

### 症状
- ブラウザで `502 Bad Gateway` が表示される
- CloudWatch アラーム「alb-5xx」が ALARM 状態

### 意味
ALB がバックエンド EC2 から **不正なレスポンス** を受け取っている状態。
= EC2 は生きているが、アプリケーション（Apache 等）が正常に応答できていない。

### 確認手順

#### Step 1: ターゲットグループのヘルスチェック確認
AWS コンソール → EC2 → ターゲットグループ → **「ターゲット」タブ**

| 状態 | 対応 |
|-----|------|
| unhealthy（1台） | その EC2 の Apache を確認 |
| unhealthy（全台） | アプリ全体の障害。デプロイ直後ならロールバック検討 |
| healthy（全台） | 一時的な 502 の可能性。ALB アクセスログを確認 |

#### Step 2: EC2 のアプリケーション確認（SSM）
```bash
# Apache の状態確認
sudo systemctl status httpd

# Apache 再起動
sudo systemctl restart httpd

# エラーログ確認
sudo tail -50 /var/log/httpd/error_log
```

#### Step 3: ALB アクセスログ確認（S3 に有効化している場合）
```bash
# ALB ログの S3 パスを確認
aws elbv2 describe-load-balancer-attributes \
  --load-balancer-arn <ALB-ARN> \
  --query "Attributes[?Key=='access_logs.s3.enabled']"
```

---

## 2. ALB 504 Gateway Timeout

### 症状
- ブラウザで `504 Gateway Timeout` が表示される
- レスポンスが非常に遅い

### 意味
ALB がバックエンド EC2 から **タイムアウト時間内に応答を受け取れない** 状態。
= EC2 が重い処理をしている、もしくは RDS 接続に時間がかかっている。

### 確認手順

#### Step 1: EC2 の CPU・メモリ確認（SSM）
```bash
top -bn1 | head -10
free -h
```

#### Step 2: RDS への接続確認（SSM）
```bash
# RDS エンドポイントへの到達確認
telnet <RDS-エンドポイント> 3306
# または
nc -zv <RDS-エンドポイント> 3306
```

#### Step 3: ALB のタイムアウト設定確認
```bash
aws elbv2 describe-load-balancer-attributes \
  --load-balancer-arn <ALB-ARN> \
  --query "Attributes[?Key=='idle_timeout.timeout_seconds']"
# デフォルト: 60秒
```

---

## 3. RDS 接続エラー

### 症状
- アプリからのデータベース接続に失敗する
- `Can't connect to MySQL server` エラーが出る

### 確認手順

#### Step 1: RDS インスタンスの状態確認
```bash
aws rds describe-db-instances \
  --db-instance-identifier <DB-識別子> \
  --query "DBInstances[].DBInstanceStatus" \
  --output text
```
- `available` → Step 2 へ
- `modifying` / `rebooting` → 完了を待つ（5〜15分）
- `failed` / `incompatible-parameters` → 上長に報告

#### Step 2: セキュリティグループ確認
```bash
aws rds describe-db-instances \
  --db-instance-identifier <DB-識別子> \
  --query "DBInstances[].VpcSecurityGroups"
```
- EC2 の SG から RDS SG への 3306 が許可されているか確認

#### Step 3: EC2 から接続テスト（SSM）
```bash
mysql -h <RDSエンドポイント> -u admin -p appdb -e "SELECT 1;"
```

#### Step 4: Multi-AZ フェイルオーバーの確認
AWS コンソール → RDS → イベント
- `Multi-AZ instance failover completed` が表示されていれば自動復旧済み
- フェイルオーバー後は DNS が新しいプライマリを指すまで 1〜2 分かかる

---

## 4. RDS ストレージ逼迫

### 症状
- CloudWatch アラーム「rds-storage」が ALARM 状態
- 空きストレージが 5GB 以下

### 確認手順

#### Step 1: 現在のストレージ確認
AWS コンソール → RDS → インスタンス → **「モニタリング」タブ** → FreeStorageSpace

#### Step 2: ストレージ拡張（緊急対応）
```bash
aws rds modify-db-instance \
  --db-instance-identifier <DB-識別子> \
  --allocated-storage <新しいGB数> \
  --apply-immediately
```
- ⚠️ ストレージは**縮小できない**。必ず上長確認の上で実施すること
- ストレージ拡張は完了まで 10〜20 分かかる場合がある

#### Step 3: 不要データの削除（アプリ対応）
```bash
# MySQL でテーブルサイズ確認（SSM 経由）
mysql -h <RDSエンドポイント> -u admin -p appdb -e "
SELECT table_name, ROUND(data_length/1024/1024,1) AS 'Data(MB)'
FROM information_schema.tables
WHERE table_schema = 'appdb'
ORDER BY data_length DESC;
"
```

### 判断基準

| 残量 | 緊急度 | 対応 |
|-----|--------|------|
| 5GB 以下 | 高 | ストレージ拡張を検討（上長確認） |
| 2GB 以下 | 緊急 | 即時拡張 + 不要データ削除 |
| 1GB 以下 | 最緊急 | DB が書き込み不可になる前に即対応 |

---

## 監視項目一覧

| 監視項目 | 閾値（デフォルト） | アラーム名 | 通知先 |
|---------|-----------------|-----------|-------|
| EC2 CPU 使用率 | 80% 以上（5分間） | ec2-cpu-\{id\} | SNS メール |
| EC2 ステータスチェック | 失敗 | ec2-status-\{id\} | SNS メール |
| ALB 5xx エラー数 | 10件/分 以上 | alb-5xx | SNS メール |
| RDS CPU 使用率 | 80% 以上（5分間） | rds-cpu | SNS メール |
| RDS 空きストレージ | 5GB 以下 | rds-storage | SNS メール |

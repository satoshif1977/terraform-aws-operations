# CloudFormation 版 監視スタック

`terraform/` ディレクトリの Terraform 版と同等の監視構成を CloudFormation で実装したテンプレートです。
**Terraform と CloudFormation の書き方の違いを比較学習**することを目的としています。

## 構成リソース

| リソース | 説明 |
|---|---|
| `AWS::SNS::Topic` | アラーム通知トピック |
| `AWS::SNS::Subscription` | メールサブスクリプション |
| `AWS::CloudWatch::Alarm` | EC2 CPU / ステータスチェック（最大 2 台） |
| `AWS::CloudWatch::Alarm` | ALB 5xx エラー（オプション） |
| `AWS::CloudWatch::Alarm` | RDS CPU / 空きストレージ（オプション） |
| `AWS::CloudWatch::Alarm` | Lambda エラー / 実行時間 / スロットリング（最大 2 関数） |
| `AWS::CloudWatch::Dashboard` | 監視ダッシュボード |

## Terraform との設計差異

| 機能 | Terraform | CloudFormation |
|---|---|---|
| 複数リソースのループ | `for_each = toset(var.list)` | 個別パラメータ + `Conditions` で代替 |
| 条件付きリソース作成 | `count = var.xxx != "" ? 1 : 0` | `Conditions` + `Condition:` キー |
| 数値演算 | `var.gb * 1024 * 1024 * 1024` | 演算非対応 → バイト値を直接パラメータで指定 |
| 状態管理 | S3 + DynamoDB（tfstate） | CloudFormation スタック（マネージド） |
| ドリフト検知 | `terraform plan` | CloudFormation ドリフト検出 |

## デプロイ方法

### 前提条件

- AWS CLI 設定済み（`aws configure` または aws-vault）
- デプロイ先リージョン: `ap-northeast-1`（東京）

### 1. テンプレートの検証

```bash
aws cloudformation validate-template \
  --template-body file://template.yaml
```

### 2. スタックの作成

```bash
aws cloudformation create-stack \
  --stack-name ops-dev-monitoring \
  --template-body file://template.yaml \
  --parameters \
    ParameterKey=AlertEmail,ParameterValue=your@email.com \
    ParameterKey=EC2InstanceId1,ParameterValue=i-0abc123def456 \
    ParameterKey=LambdaFunctionName1,ParameterValue=my-function
```

EC2・ALB・RDS・Lambda はすべて省略可能です（空白 = 監視しない）。

### 3. メール確認（重要）

デプロイ後、指定メールアドレスに **AWS Notification - Subscription Confirmation** が届きます。
**必ず「Confirm subscription」をクリック**してください（クリックしないとアラームが届きません）。

### 4. スタックの更新

```bash
aws cloudformation update-stack \
  --stack-name ops-dev-monitoring \
  --template-body file://template.yaml \
  --parameters \
    ParameterKey=AlertEmail,UsePreviousValue=true \
    ParameterKey=EC2InstanceId1,ParameterValue=i-0newinstance
```

### 5. スタックの削除

```bash
aws cloudformation delete-stack \
  --stack-name ops-dev-monitoring
```

## パラメータ一覧

| パラメータ | デフォルト | 説明 |
|---|---|---|
| `ProjectName` | `ops` | リソース命名プレフィックス |
| `Environment` | `dev` | 環境名（dev / stg / prod） |
| `AlertEmail` | （必須） | アラーム通知先メールアドレス |
| `EC2InstanceId1` | `""` | EC2 インスタンス ID 1つ目 |
| `EC2InstanceId2` | `""` | EC2 インスタンス ID 2つ目 |
| `AlbArnSuffix` | `""` | ALB ARN サフィックス |
| `RdsInstanceIdentifier` | `""` | RDS インスタンス識別子 |
| `LambdaFunctionName1` | `""` | Lambda 関数名 1つ目 |
| `LambdaFunctionName2` | `""` | Lambda 関数名 2つ目 |
| `EC2CpuThreshold` | `80` | EC2 CPU アラーム閾値（%） |
| `RdsCpuThreshold` | `80` | RDS CPU アラーム閾値（%） |
| `RdsStorageThresholdBytes` | `5368709120` | RDS 空きストレージ閾値（バイト）。デフォルト = 5 GB |
| `Alb5xxThreshold` | `10` | ALB 5xx エラー閾値（件/分） |
| `LambdaErrorThreshold` | `1` | Lambda エラー閾値（件/5分） |
| `LambdaDurationThresholdMs` | `10000` | Lambda 実行時間閾値（ms）。デフォルト = 10秒 |
| `LambdaThrottleThreshold` | `1` | Lambda スロットリング閾値（件/5分） |

## トラブルシューティング

### アラームメールが届かない

SNS サブスクリプションが `PendingConfirmation` 状態になっています。
メールボックスで "AWS Notification - Subscription Confirmation" を探し、確認リンクをクリックしてください。

```bash
# サブスクリプション状態の確認
aws sns list-subscriptions-by-topic \
  --topic-arn <SNS_TOPIC_ARN>
```

### `ROLLBACK_COMPLETE` でスタック作成が失敗した

スタックが `ROLLBACK_COMPLETE` 状態の場合、そのまま更新はできません。
一度削除してから再作成してください。

```bash
aws cloudformation delete-stack --stack-name ops-dev-monitoring
aws cloudformation wait stack-delete-complete --stack-name ops-dev-monitoring
# → create-stack を再実行
```

### パラメータ値の確認

```bash
aws cloudformation describe-stacks \
  --stack-name ops-dev-monitoring \
  --query 'Stacks[0].Parameters'
```

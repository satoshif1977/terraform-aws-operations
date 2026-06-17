# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [2.0.0] - 2026-06-17

### Added
- **Go 版 guardduty-notifier 並置実装**（`lambda_go/guardduty-notifier/`）
  - Python 版と同じロジックを Go 1.21 で実装（aws-lambda-go / aws-sdk-go-v2）
  - `SNSPublisher` インターフェースによるモック可能設計
  - Go ユニットテスト 10 件（FindingType / Severity / SNS エラー / 件名 100 文字制限 等）
- **Python pytest CI ジョブ追加**（`terraform-ci.yml`）
  - `pytest lambda/guardduty-notifier/` 24 件 + `pytest lambda/streams-alert/` 11 件
  - push / PR で自動実行（CI 合計テスト: Python 35 件 + Go 10 件 + Terraform test 17 件）
- **Go Test ワークフロー追加**（`.github/workflows/go-test.yml`）
  - `lambda_go/**` 変更時に `go test ./... -v` を自動実行
- **`actions/setup-go` v5 → v6 更新**（Dependabot PR#8）

### Fixed
- **Terraform test mock 修正**: `aws_dynamodb_table`（`stream_arn`）・`aws_pipes_pipe`（`arn`）を
  全 3 テストファイルに追加（EventBridge Pipes の source ARN バリデーションエラーを解消）
- **Checkov CKV_AWS_119 スキップ追加**（DynamoDB KMS CMK - dev/PoC は AWS 管理キーで十分）
- **Checkov CKV_AWS_300 スキップ追加**（Checkov 3.x バグ - S3 チェックが DynamoDB に誤適用）

## [1.9.0] - 2026-06-04

### Added
- **DynamoDB Streams → EventBridge Pipes → アラート Lambda パイプライン**（`terraform/streams.tf`）
  - `aws_dynamodb_table.incidents`: インシデント記録テーブル（PITR・SSE・Streams 有効）
    - PK: `incident_id`（String）/ SK: `timestamp`（String）
    - `stream_view_type = "NEW_AND_OLD_IMAGES"` でソース変更前後の値を取得
  - `aws_pipes_pipe.streams_alert`: DynamoDB Streams → Lambda のパイプライン
    - フィルター: `severity IN [HIGH, CRITICAL] AND status = OPEN` のレコードのみ Lambda を起動
    - `batch_size=1` / `maximum_retry_attempts=2`（失敗時のリトライ制御）
  - `aws_lambda_function.streams_alert`: フィルター通過レコードを整形して SNS へ通知
  - IAM: Pipes 用（DynamoDB Streams 読み取り + Lambda 呼び出し）・Lambda 用（SNS Publish）を最小権限で作成
- **インシデントアラート Lambda**（`lambda/streams-alert/index.py`）
  - DynamoDB NewImage の AttributeValue（`{"S": "..."}` 形式）を自動デコード
  - INSERT / MODIFY のみ処理・REMOVE はスキップ（変更理由なし通知を防止）
  - 処理結果を `processed` / `skipped` / `errors` に分類して返却
- **ユニットテスト追加**（`lambda/streams-alert/test_index.py`・11 件・全パス）
  - CRITICAL INSERT 成功 / HIGH MODIFY 成功 / REMOVE スキップ / NewImage 空スキップ /
    SNS エラー格納 / dict 形式 invoke 対応 / AttributeValue デコード / メッセージ生成
- **outputs 追加**: `incidents_table_name` / `incidents_stream_arn` /
  `streams_alert_function_name` / `streams_pipe_name`
- **variables 追加**: `streams_pipe_enabled`（bool, default=true）
- **`.gitignore` 更新**: `__pycache__/` / `*.pyc` / `.pytest_cache/` / `lambda/**/*.zip` / `.*.bkp` を追加

## [1.8.0] - 2026-06-03

### Security
- **S3 バケットポリシー強化**（`terraform/security.tf`）
  - config_logs バケットポリシーに `DenyNonSSL` ステートメントを追加
  - HTTP（非 SSL）リクエストを全プリンシパルに対して Deny（CKV_AWS_54 対応）
  - データ転送の暗号化を強制し、中間者攻撃を防止

## [1.7.0] - 2026-06-03

### Added
- **Security Hub 連携強化**（`terraform/security.tf`）
  - GuardDuty findings を Security Hub に集約（`aws_securityhub_product_subscription.guardduty`）
  - AWS Config findings を Security Hub に集約（`aws_securityhub_product_subscription.config`）
  - Security Hub HIGH / CRITICAL findings → EventBridge → SNS 通知パイプライン追加
    - フィルター: `Severity.Label = HIGH | CRITICAL` / `RecordState = ACTIVE` / `Workflow.Status = NEW`
    - GuardDuty・Config・その他すべてのサービスの findings を一元通知
- **SNS トピックポリシー更新**（`terraform/main.tf`）
  - `events.amazonaws.com` からの Publish を許可（EventBridge → SNS 通知に必要）

## [1.6.0] - 2026-06-02

### Added
- **セキュリティ監視レイヤー追加**（`terraform/security.tf`）
  - **Amazon GuardDuty**: 脅威検知器・S3 アクセス異常検知（S3_DATA_EVENTS）・EBS マルウェアスキャン（EBS_MALWARE_PROTECTION）
  - **GuardDuty Finding 通知パイプライン**: EventBridge ルール（severity ≥ 4.0）→ Lambda → SNS メール通知
  - **Python Lambda（guardduty-notifier）**: Finding を日本語整形し重大度ラベル（CRITICAL / HIGH / MEDIUM）付きで通知（`lambda/guardduty-notifier/index.py`）
  - **AWS Security Hub**: CIS AWS Foundations Benchmark v1.4.0 + AWS Foundational Security Best Practices v1.0.0 購読
  - **AWS Config**: Configuration Recorder（全リソース記録）+ S3 Delivery Channel + コンプライアンスルール 4件
    - `required-tags`: 必須タグ（Environment / Project / ManagedBy）未付与リソース検出
    - `s3-encryption`: SSE 未設定 S3 バケット検出
    - `root-mfa`: ルートアカウント MFA 未設定検出
    - `vpc-flow-logs`: VPC フローログ無効検出
- セキュリティ関連変数追加: `guardduty_enabled` / `guardduty_severity_threshold` / `securityhub_enabled` / `config_enabled`
- セキュリティ関連 outputs 追加: `guardduty_detector_id` / `guardduty_notifier_function_name` / `security_hub_enabled` / `config_s3_bucket`
- `hashicorp/archive` プロバイダー追加（Lambda ZIP パッケージ自動生成）
- terraform test mock 拡充: `aws_iam_role` / `aws_cloudwatch_event_rule` / `aws_lambda_function` / `aws_caller_identity` を追加し全 17 テスト通過

## [1.5.0] - 2026-05-27

### Fixed
- terraform test: mock_provider に aws_ce_anomaly_monitor を追加（CI test 修正）

### Changed
- CI アクション更新: actions/checkout v4→v6 / aws-actions/configure-aws-credentials v4→v6 / actions/github-script v7→v9 / hashicorp/setup-terraform v3→v4
- hashicorp/aws プロバイダーを v5.0 → v6.46 に更新

## [1.4.0] - 2026-05-25

### Added
- **Cost Anomaly Detection 追加**（コスト異常自動検知）
  - `aws_ce_anomaly_monitor`：AWSサービス別にコスト異常を監視
  - `aws_ce_anomaly_subscription`：前日比 20% 以上の増加で SNS 通知（日次）
  - `aws_sns_topic_policy`：Cost Explorer → SNS Publish 許可ポリシー追加
  - `var.cost_anomaly_impact_percentage`：閾値を変数化（デフォルト 20%）
  - outputs: `cost_anomaly_monitor_arn` / `cost_anomaly_subscription_arn`

## [1.3.0] - 2026-05-19

### Added
- CONTRIBUTING.md 追加（PR プロセス・スタイルガイド）

## [1.2.0] - 2026-05-13

### Added
- CloudFormation 版監視スタック追加（Terraform との比較学習用）
- Terraform Test 追加（17 テスト・`mock_provider` 使用）
- Runbook 更新手順セクションを README に追加
- SECURITY.md 追加
- Dependabot 設定追加（2026-05-11）
- CloudWatch アラーム発火デモ GIF 追加（2026-05-11）
- README にトラブルシューティング・ローカル開発テスト方法セクション追加

## [1.1.0] - 2026-04-14

### Added
- GitHub Actions CI 追加（Terraform fmt / validate / plan）
- Lambda 監視アラーム追加（エラー率・実行時間・スロットリング）
- MIT License 追加

## [1.0.0] - 2026-03-11

### Added
- 初回実装：CloudWatch 監視・SNS 通知・障害対応 Runbook
  - EC2 / ALB / RDS の CloudWatch アラーム設定
  - SNS トピック → メール通知連携
  - 障害対応 Runbook（Markdown）
- Terraform IaC（CloudWatch / SNS / IAM）
- アーキテクチャ構成図（draw.io + PNG）

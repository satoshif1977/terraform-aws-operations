# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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

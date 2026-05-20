# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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

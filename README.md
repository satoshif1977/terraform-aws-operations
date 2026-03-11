# terraform-aws-operations

AWS インフラの監視・アラート設定と障害対応 Runbook をまとめたポートフォリオです。
CloudWatch + SNS を Terraform でコード化し、実際の運用補助業務で使える形を目指しています。

## 目的
- CloudWatch アラームで EC2 / ALB / RDS を監視する
- 異常検知時に SNS でメール通知する
- 障害一次対応の手順（Runbook）をドキュメント化する
- 副業での AWS 運用補助業務に即使える形を作る

## 使用技術
| カテゴリ | 技術・サービス |
|---------|--------------|
| IaC | Terraform |
| 監視 | Amazon CloudWatch（アラーム・ダッシュボード） |
| 通知 | Amazon SNS（メール通知） |
| 対象 | EC2 / ALB / RDS |

## 監視項目
| リソース | 監視内容 | デフォルト閾値 |
|---------|---------|--------------|
| EC2 | CPU 使用率 | 80% 以上（5分間） |
| EC2 | ステータスチェック失敗 | 1回以上 |
| ALB | 5xx エラー数 | 10件/分 以上 |
| RDS | CPU 使用率 | 80% 以上（5分間） |
| RDS | 空きストレージ | 5GB 以下 |

## セットアップ手順
```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
# terraform.tfvars を編集して alert_email を設定
terraform init && terraform plan && terraform apply
```
apply 後、指定メールに確認メールが届きます。**必ず「Confirm subscription」をクリック**してください。

## Runbook（障害対応手順書）
| ファイル | 内容 |
|---------|------|
| [01_ec2_troubleshooting.md](docs/runbook/01_ec2_troubleshooting.md) | EC2 接続不可・CPU 高負荷・ステータスチェック失敗 |
| [02_alb_rds_troubleshooting.md](docs/runbook/02_alb_rds_troubleshooting.md) | ALB 502/504・RDS 接続エラー・ストレージ逼迫 |

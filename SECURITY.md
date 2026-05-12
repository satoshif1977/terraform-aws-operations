# Security Policy

## Reporting a Vulnerability

このリポジトリはポートフォリオ・学習目的のため、本番環境での使用を想定していません。

セキュリティ上の問題を発見した場合は、GitHub Issues ではなく以下の方法でご連絡ください：

- GitHub: [@satoshif1977](https://github.com/satoshif1977)

## Supported Versions

| Version | Supported |
|---------|-----------|
| latest  | ✅        |

## Security Best Practices

このリポジトリのコードを参考にする場合は、以下を必ず実施してください：

- IAM ロールは最小権限の原則を適用する
- シークレット・認証情報をコードにハードコードしない
- AWS Secrets Manager または SSM Parameter Store を使用する

# ── セキュリティ監視構成 ───────────────────────────────────
# このファイルでは以下を構築する:
#   1. GuardDuty（脅威検知）
#   2. Security Hub（コンプライアンス統合ダッシュボード）
#   3. AWS Config（リソース設定コンプライアンス評価）
#   4. GuardDuty Finding 通知 Lambda（Python）
# ──────────────────────────────────────────────────────────

data "aws_caller_identity" "current" {}

# ── 1. GuardDuty ─────────────────────────────────────────

resource "aws_guardduty_detector" "main" {
  # checkov:skip=CKV2_AWS_3: スタンドアロンアカウントのため組織レベルの GuardDuty は不要
  enable = var.guardduty_enabled

  tags = {
    Environment = var.environment
    Project     = var.project_name
    ManagedBy   = "Terraform"
  }
}

# S3 アクセス異常を検知（公開設定変更・不審な API 呼び出し）
resource "aws_guardduty_detector_feature" "s3_logs" {
  detector_id = aws_guardduty_detector.main.id
  name        = "S3_DATA_EVENTS"
  status      = "ENABLED"
}

# EC2 Finding 検知時に EBS をマルウェアスキャン
resource "aws_guardduty_detector_feature" "malware_protection" {
  detector_id = aws_guardduty_detector.main.id
  name        = "EBS_MALWARE_PROTECTION"
  status      = "ENABLED"
}

# ── 2. GuardDuty Finding → Lambda 通知パイプライン ────────

# Lambda 実行ロール
resource "aws_iam_role" "guardduty_notifier" {
  name = "${var.project_name}-${var.environment}-guardduty-notifier-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = {
    Environment = var.environment
    Project     = var.project_name
    ManagedBy   = "Terraform"
  }
}

resource "aws_iam_role_policy_attachment" "guardduty_notifier_basic" {
  role       = aws_iam_role.guardduty_notifier.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "guardduty_notifier_sns" {
  name = "${var.project_name}-${var.environment}-guardduty-notifier-sns"
  role = aws_iam_role.guardduty_notifier.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "sns:Publish"
      Resource = aws_sns_topic.alert.arn
    }]
  })
}

# Lambda デプロイパッケージ（Python ソースを ZIP 化）
data "archive_file" "guardduty_notifier" {
  type        = "zip"
  source_file = "${path.module}/../lambda/guardduty-notifier/index.py"
  output_path = "${path.module}/../lambda/guardduty-notifier/index.zip"
}

resource "aws_cloudwatch_log_group" "guardduty_notifier" {
  # checkov:skip=CKV_AWS_158: dev/PoC 環境のため AWS 管理キーで十分（KMS CMK は本番のみ）
  name              = "/aws/lambda/${var.project_name}-${var.environment}-guardduty-notifier"
  retention_in_days = 30

  tags = {
    Environment = var.environment
    Project     = var.project_name
    ManagedBy   = "Terraform"
  }
}

resource "aws_lambda_function" "guardduty_notifier" {
  # checkov:skip=CKV_AWS_116: dev/PoC のため DLQ は不要
  # checkov:skip=CKV_AWS_173: 環境変数は SNS ARN のみで機密情報なし・KMS 不要
  # checkov:skip=CKV_AWS_115: dev/PoC のため同時実行数制限は不要
  # checkov:skip=CKV_AWS_117: dev/PoC のためパブリック Lambda で十分（VPC 配置不要）
  # checkov:skip=CKV_AWS_272: dev/PoC のためコード署名は不要
  function_name = "${var.project_name}-${var.environment}-guardduty-notifier"
  role          = aws_iam_role.guardduty_notifier.arn
  runtime       = "python3.13"
  handler       = "index.lambda_handler"

  filename         = data.archive_file.guardduty_notifier.output_path
  source_code_hash = data.archive_file.guardduty_notifier.output_base64sha256

  environment {
    variables = {
      SNS_TOPIC_ARN = aws_sns_topic.alert.arn
    }
  }

  # X-Ray: dev/PoC は PassThrough（Active にするとコスト発生）
  tracing_config {
    mode = "PassThrough"
  }

  depends_on = [
    aws_cloudwatch_log_group.guardduty_notifier,
    aws_iam_role_policy_attachment.guardduty_notifier_basic,
  ]

  tags = {
    Environment = var.environment
    Project     = var.project_name
    ManagedBy   = "Terraform"
  }
}

# Lambda リソースベースポリシー（EventBridge からの呼び出し許可）
resource "aws_lambda_permission" "allow_eventbridge" {
  statement_id  = "AllowExecutionFromEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.guardduty_notifier.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.guardduty_findings.arn
}

# EventBridge ルール（MEDIUM 以上の Finding を Lambda へ転送）
resource "aws_cloudwatch_event_rule" "guardduty_findings" {
  name        = "${var.project_name}-${var.environment}-guardduty-findings"
  description = "GuardDuty MEDIUM 以上の Finding を notifier Lambda へ転送"

  event_pattern = jsonencode({
    source      = ["aws.guardduty"]
    detail-type = ["GuardDuty Finding"]
    detail = {
      # severity: 4.0 以上（MEDIUM / HIGH / CRITICAL）を対象とする
      severity = [{ numeric = [">=", var.guardduty_severity_threshold] }]
    }
  })

  tags = {
    Environment = var.environment
    Project     = var.project_name
    ManagedBy   = "Terraform"
  }
}

resource "aws_cloudwatch_event_target" "guardduty_lambda" {
  rule      = aws_cloudwatch_event_rule.guardduty_findings.name
  target_id = "guardduty-notifier-lambda"
  arn       = aws_lambda_function.guardduty_notifier.arn
}

# ── 3. Security Hub ───────────────────────────────────────

resource "aws_securityhub_account" "main" {
  count = var.securityhub_enabled ? 1 : 0

  # auto_enable_controls: 新規スタンダード追加時にコントロールを自動有効化
  auto_enable_controls = true
}

# CIS AWS Foundations Benchmark v1.4.0
# ルートアカウント MFA・CloudTrail・IAM パスワードポリシー等を評価
resource "aws_securityhub_standards_subscription" "cis" {
  count = var.securityhub_enabled ? 1 : 0

  depends_on    = [aws_securityhub_account.main]
  standards_arn = "arn:aws:securityhub:${var.aws_region}::standards/cis-aws-foundations-benchmark/v/1.4.0"
}

# AWS Foundational Security Best Practices
# S3 暗号化・KMS 設定・GuardDuty 有効化等のベストプラクティスを評価
resource "aws_securityhub_standards_subscription" "fsbp" {
  count = var.securityhub_enabled ? 1 : 0

  depends_on    = [aws_securityhub_account.main]
  standards_arn = "arn:aws:securityhub:${var.aws_region}::standards/aws-foundational-security-best-practices/v/1.0.0"
}

# ── Security Hub 製品統合（GuardDuty / Config findings を Hub に集約）──

# GuardDuty findings を Security Hub に集約
# GuardDuty が検知した脅威を Security Hub のダッシュボードで一元管理できる
resource "aws_securityhub_product_subscription" "guardduty" {
  count = var.securityhub_enabled && var.guardduty_enabled ? 1 : 0

  depends_on  = [aws_securityhub_account.main]
  product_arn = "arn:aws:securityhub:${var.aws_region}::product/aws/guardduty"
}

# AWS Config findings を Security Hub に集約
# Config のコンプライアンス違反を Security Hub で一元管理できる
resource "aws_securityhub_product_subscription" "config" {
  count = var.securityhub_enabled && var.config_enabled ? 1 : 0

  depends_on  = [aws_securityhub_account.main]
  product_arn = "arn:aws:securityhub:${var.aws_region}::product/aws/config"
}

# ── Security Hub Findings → EventBridge → SNS 通知パイプライン ──
# GuardDuty・Config・その他すべての HIGH / CRITICAL findings を一元通知
# （既存の GuardDuty 直接パイプラインとの違い: Hub 経由で全サービスの findings を統合通知）

resource "aws_cloudwatch_event_rule" "securityhub_findings" {
  count = var.securityhub_enabled ? 1 : 0

  name        = "${var.project_name}-${var.environment}-securityhub-findings"
  description = "Security Hub の HIGH / CRITICAL findings を SNS で通知"

  event_pattern = jsonencode({
    source      = ["aws.securityhub"]
    detail-type = ["Security Hub Findings - Imported"]
    detail = {
      findings = {
        Severity = {
          Label = ["HIGH", "CRITICAL"]
        }
        RecordState = ["ACTIVE"]
        Workflow = {
          Status = ["NEW"]
        }
      }
    }
  })

  tags = {
    Environment = var.environment
    Project     = var.project_name
    ManagedBy   = "Terraform"
  }
}

resource "aws_cloudwatch_event_target" "securityhub_sns" {
  count = var.securityhub_enabled ? 1 : 0

  rule      = aws_cloudwatch_event_rule.securityhub_findings[0].name
  target_id = "securityhub-alert-sns"
  arn       = aws_sns_topic.alert.arn
}

# ── 4. AWS Config ─────────────────────────────────────────

# Config ログ保存用 S3 バケット
resource "aws_s3_bucket" "config_logs" {
  count = var.config_enabled ? 1 : 0

  # checkov:skip=CKV_AWS_21: バージョニングは aws_s3_bucket_versioning リソースで別途設定済み
  # checkov:skip=CKV_AWS_144: dev/PoC のためクロスリージョンレプリケーションは不要
  # checkov:skip=CKV2_AWS_6: パブリックアクセスブロックは aws_s3_bucket_public_access_block で別途設定済み
  # checkov:skip=CKV2_AWS_61: ライフサイクルは aws_s3_bucket_lifecycle_configuration で別途設定済み
  # checkov:skip=CKV_AWS_18: dev/PoC のためアクセスログは不要
  # checkov:skip=CKV2_AWS_62: dev/PoC のためイベント通知は不要
  # checkov:skip=CKV_AWS_145: dev/PoC のため AES256 で十分（KMS CMK は本番のみ）

  # アカウント ID をサフィックスに付けてグローバルユニークにする
  bucket        = "${var.project_name}-${var.environment}-config-logs-${data.aws_caller_identity.current.account_id}"
  force_destroy = true # dev 環境での destroy を容易にするため true

  tags = {
    Environment = var.environment
    Project     = var.project_name
    ManagedBy   = "Terraform"
  }
}

resource "aws_s3_bucket_versioning" "config_logs" {
  count = var.config_enabled ? 1 : 0

  bucket = aws_s3_bucket.config_logs[0].id
  versioning_configuration {
    status = "Enabled"
  }
}

# CKV2_AWS_61: ライフサイクル設定（マルチパートアップロードの自動中断）
resource "aws_s3_bucket_lifecycle_configuration" "config_logs" {
  count = var.config_enabled ? 1 : 0

  bucket = aws_s3_bucket.config_logs[0].id

  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "config_logs" {
  count = var.config_enabled ? 1 : 0

  bucket = aws_s3_bucket.config_logs[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "config_logs" {
  count = var.config_enabled ? 1 : 0

  bucket                  = aws_s3_bucket.config_logs[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Config が S3 へ書き込むためのバケットポリシー（+ SSL 強制）
resource "aws_s3_bucket_policy" "config_logs" {
  count = var.config_enabled ? 1 : 0

  bucket = aws_s3_bucket.config_logs[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AWSConfigBucketPermissionsCheck"
        Effect    = "Allow"
        Principal = { Service = "config.amazonaws.com" }
        Action    = "s3:GetBucketAcl"
        Resource  = aws_s3_bucket.config_logs[0].arn
        Condition = {
          StringEquals = {
            "AWS:SourceAccount" = data.aws_caller_identity.current.account_id
          }
        }
      },
      {
        Sid       = "AWSConfigBucketDelivery"
        Effect    = "Allow"
        Principal = { Service = "config.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.config_logs[0].arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/Config/*"
        Condition = {
          StringEquals = {
            "s3:x-amz-acl"      = "bucket-owner-full-control"
            "AWS:SourceAccount" = data.aws_caller_identity.current.account_id
          }
        }
      },
      {
        # CKV_AWS_54: HTTP（非 SSL）リクエストを拒否してデータ転送を暗号化
        Sid       = "DenyNonSSL"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource = [
          aws_s3_bucket.config_logs[0].arn,
          "${aws_s3_bucket.config_logs[0].arn}/*"
        ]
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      }
    ]
  })
}

# Config 記録用 IAM ロール
resource "aws_iam_role" "config" {
  count = var.config_enabled ? 1 : 0

  name = "${var.project_name}-${var.environment}-config-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "config.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = {
    Environment = var.environment
    Project     = var.project_name
    ManagedBy   = "Terraform"
  }
}

resource "aws_iam_role_policy_attachment" "config" {
  count = var.config_enabled ? 1 : 0

  role       = aws_iam_role.config[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWS_ConfigRole"
}

# Configuration Recorder（全リソース種別を記録）
resource "aws_config_configuration_recorder" "main" {
  count = var.config_enabled ? 1 : 0

  name     = "${var.project_name}-${var.environment}-config-recorder"
  role_arn = aws_iam_role.config[0].arn

  recording_group {
    all_supported                 = true
    include_global_resource_types = true
  }
}

# Delivery Channel（S3 バケットへ記録を配信）
resource "aws_config_delivery_channel" "main" {
  count = var.config_enabled ? 1 : 0

  name           = "${var.project_name}-${var.environment}-config-channel"
  s3_bucket_name = aws_s3_bucket.config_logs[0].id

  depends_on = [aws_config_configuration_recorder.main]
}

# Recorder を有効化（Delivery Channel 設定後）
resource "aws_config_configuration_recorder_status" "main" {
  # checkov:skip=CKV2_AWS_45: コスト最適化のため必要なリソースのみ記録（全リソース記録は除外）
  count = var.config_enabled ? 1 : 0

  name       = aws_config_configuration_recorder.main[0].name
  is_enabled = true

  depends_on = [aws_config_delivery_channel.main]
}

# ── AWS Config ルール ─────────────────────────────────────

# 必須タグ未付与リソースを検出（Environment / Project / ManagedBy）
resource "aws_config_config_rule" "required_tags" {
  count = var.config_enabled ? 1 : 0

  name        = "${var.project_name}-${var.environment}-required-tags"
  description = "必須タグ（Environment / Project / ManagedBy）が付与されていないリソースを検出"

  source {
    owner             = "AWS"
    source_identifier = "REQUIRED_TAGS"
  }

  input_parameters = jsonencode({
    tag1Key = "Environment"
    tag2Key = "Project"
    tag3Key = "ManagedBy"
  })

  depends_on = [aws_config_configuration_recorder_status.main]
}

# S3 バケットの暗号化が無効なものを検出
resource "aws_config_config_rule" "s3_encryption" {
  count = var.config_enabled ? 1 : 0

  name        = "${var.project_name}-${var.environment}-s3-encryption"
  description = "SSE 未設定の S3 バケットを検出（CKV_AWS_19 相当）"

  source {
    owner             = "AWS"
    source_identifier = "S3_BUCKET_SERVER_SIDE_ENCRYPTION_ENABLED"
  }

  depends_on = [aws_config_configuration_recorder_status.main]
}

# ルートアカウントへの MFA 未設定を検出
resource "aws_config_config_rule" "root_mfa" {
  count = var.config_enabled ? 1 : 0

  name        = "${var.project_name}-${var.environment}-root-mfa"
  description = "ルートアカウントに MFA が設定されていない場合に検出"

  source {
    owner             = "AWS"
    source_identifier = "ROOT_ACCOUNT_MFA_ENABLED"
  }

  depends_on = [aws_config_configuration_recorder_status.main]
}

# VPC フローログが無効な VPC を検出
resource "aws_config_config_rule" "vpc_flow_logs" {
  count = var.config_enabled ? 1 : 0

  name        = "${var.project_name}-${var.environment}-vpc-flow-logs"
  description = "フローログが有効になっていない VPC を検出"

  source {
    owner             = "AWS"
    source_identifier = "VPC_FLOW_LOGS_ENABLED"
  }

  depends_on = [aws_config_configuration_recorder_status.main]
}

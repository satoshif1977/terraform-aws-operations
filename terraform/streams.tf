# ── DynamoDB Streams → EventBridge Pipes → アラート Lambda ────────────
# このファイルでは以下を構築する:
#   1. DynamoDB テーブル（インシデント記録）+ Streams 有効化
#   2. Pipes 用 IAM ロール（DynamoDB Streams 読み取り + Lambda 呼び出し）
#   3. アラート Lambda 用 IAM ロール（SNS Publish）
#   4. CloudWatch Logs グループ（Lambda ログ）
#   5. アラート Lambda 関数（streams-alert）
#   6. EventBridge Pipes（Streams → フィルター → Lambda）
# ──────────────────────────────────────────────────────────────────────

# ── 1. DynamoDB インシデントテーブル ─────────────────────────────────
resource "aws_dynamodb_table" "incidents" {
  count = var.streams_pipe_enabled ? 1 : 0

  # checkov:skip=CKV_AWS_47: dev 環境のため削除保護は無効（terraform destroy を容易にするため）
  name         = "${var.project_name}-${var.environment}-incidents"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "incident_id"
  range_key    = "timestamp"

  attribute {
    name = "incident_id"
    type = "S"
  }

  attribute {
    name = "timestamp"
    type = "S"
  }

  # CKV_AWS_28: PITR（ポイントインタイムリカバリ）有効化
  point_in_time_recovery {
    enabled = true
  }

  # CKV_AWS_119: SSE 有効化（AWS マネージドキー）
  server_side_encryption {
    enabled = true
  }

  # DynamoDB Streams: Pipes のソースとして使用
  # NEW_AND_OLD_IMAGES で更新前後の値も取得できる
  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  tags = {
    Environment = var.environment
    Project     = var.project_name
    ManagedBy   = "Terraform"
  }
}

# ── 2. EventBridge Pipes 用 IAM ─────────────────────────────────────

resource "aws_iam_role" "pipes_streams" {
  count = var.streams_pipe_enabled ? 1 : 0

  name = "${var.project_name}-${var.environment}-pipes-streams-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "pipes.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = {
    Environment = var.environment
    Project     = var.project_name
    ManagedBy   = "Terraform"
  }
}

# ソース権限: DynamoDB Streams の読み取り
resource "aws_iam_role_policy" "pipes_streams_source" {
  count = var.streams_pipe_enabled ? 1 : 0

  name = "${var.project_name}-${var.environment}-pipes-streams-source"
  role = aws_iam_role.pipes_streams[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "dynamodb:DescribeStream",
        "dynamodb:GetRecords",
        "dynamodb:GetShardIterator",
        "dynamodb:ListStreams",
      ]
      Resource = aws_dynamodb_table.incidents[0].stream_arn
    }]
  })
}

# ターゲット権限: Lambda の呼び出し
resource "aws_iam_role_policy" "pipes_streams_target" {
  count = var.streams_pipe_enabled ? 1 : 0

  name = "${var.project_name}-${var.environment}-pipes-streams-target"
  role = aws_iam_role.pipes_streams[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = aws_lambda_function.streams_alert[0].arn
    }]
  })
}

# ── 3. アラート Lambda 用 IAM ────────────────────────────────────────

resource "aws_iam_role" "streams_alert" {
  count = var.streams_pipe_enabled ? 1 : 0

  name = "${var.project_name}-${var.environment}-streams-alert-role"

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

resource "aws_iam_role_policy_attachment" "streams_alert_basic" {
  count = var.streams_pipe_enabled ? 1 : 0

  role       = aws_iam_role.streams_alert[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "streams_alert_sns" {
  count = var.streams_pipe_enabled ? 1 : 0

  name = "${var.project_name}-${var.environment}-streams-alert-sns"
  role = aws_iam_role.streams_alert[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "sns:Publish"
      Resource = aws_sns_topic.alert.arn
    }]
  })
}

# ── 4. CloudWatch Logs グループ ──────────────────────────────────────

resource "aws_cloudwatch_log_group" "streams_alert" {
  count = var.streams_pipe_enabled ? 1 : 0

  # checkov:skip=CKV_AWS_158: dev/PoC 環境のため AWS 管理キーで十分（KMS CMK は本番のみ）
  name              = "/aws/lambda/${var.project_name}-${var.environment}-streams-alert"
  retention_in_days = 30

  tags = {
    Environment = var.environment
    Project     = var.project_name
    ManagedBy   = "Terraform"
  }
}

# ── 5. アラート Lambda 関数 ──────────────────────────────────────────

# Lambda デプロイパッケージ（Python ソースを ZIP 化）
data "archive_file" "streams_alert" {
  count = var.streams_pipe_enabled ? 1 : 0

  type        = "zip"
  source_file = "${path.module}/../lambda/streams-alert/index.py"
  output_path = "${path.module}/../lambda/streams-alert/index.zip"
}

resource "aws_lambda_function" "streams_alert" {
  count = var.streams_pipe_enabled ? 1 : 0

  # checkov:skip=CKV_AWS_116: EventBridge Pipes 側に DLQ を設定するため Lambda DLQ は不要
  # checkov:skip=CKV_AWS_173: 環境変数は SNS ARN のみで機密情報なし・KMS 不要
  # checkov:skip=CKV_AWS_115: dev/PoC のため同時実行数制限は不要
  # checkov:skip=CKV_AWS_117: dev/PoC のためパブリック Lambda で十分（VPC 配置不要）
  # checkov:skip=CKV_AWS_272: dev/PoC のためコード署名は不要
  function_name = "${var.project_name}-${var.environment}-streams-alert"
  role          = aws_iam_role.streams_alert[0].arn
  runtime       = "python3.13"
  handler       = "index.handler"

  filename         = data.archive_file.streams_alert[0].output_path
  source_code_hash = data.archive_file.streams_alert[0].output_base64sha256

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
    aws_cloudwatch_log_group.streams_alert,
    aws_iam_role_policy_attachment.streams_alert_basic,
  ]

  tags = {
    Environment = var.environment
    Project     = var.project_name
    ManagedBy   = "Terraform"
  }
}

# Lambda リソースベースポリシー（EventBridge Pipes からの呼び出し許可）
resource "aws_lambda_permission" "allow_pipes_streams" {
  count = var.streams_pipe_enabled ? 1 : 0

  statement_id  = "AllowExecutionFromPipes"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.streams_alert[0].function_name
  principal     = "pipes.amazonaws.com"
  source_arn    = aws_pipes_pipe.streams_alert[0].arn
}

# ── 6. EventBridge Pipes ─────────────────────────────────────────────

resource "aws_pipes_pipe" "streams_alert" {
  count = var.streams_pipe_enabled ? 1 : 0

  name     = "${var.project_name}-${var.environment}-streams-alert"
  role_arn = aws_iam_role.pipes_streams[0].arn

  # ソース: DynamoDB Streams（incidents テーブル）
  source = aws_dynamodb_table.incidents[0].stream_arn

  source_parameters {
    dynamodb_stream_parameters {
      # LATEST: Pipes 有効化後に追加されたレコードのみ処理（既存レコードはスキップ）
      starting_position = "LATEST"
      batch_size        = 1
      # 処理失敗時: 最大 2 回リトライ（3回失敗で REMOVE）
      maximum_retry_attempts = 2
    }

    # フィルター: severity が HIGH または CRITICAL かつ status が OPEN のレコードのみ通過
    # Pipes フィルターはソース側で評価されるため、不要な Lambda 起動を防いでコストを抑える
    filter_criteria {
      filter {
        pattern = jsonencode({
          dynamodb = {
            NewImage = {
              severity = {
                S = ["HIGH", "CRITICAL"]
              }
              status = {
                S = ["OPEN"]
              }
            }
          }
        })
      }
    }
  }

  # ターゲット: アラート Lambda
  target = aws_lambda_function.streams_alert[0].arn

  tags = {
    Environment = var.environment
    Project     = var.project_name
    ManagedBy   = "Terraform"
  }
}

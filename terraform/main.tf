# ── 監視・アラート構成 ─────────────────────────────────────
# このファイルでは以下を構築する:
#   1. SNS トピック（アラーム通知先）
#   2. CloudWatch アラーム（EC2 / ALB / RDS）
#   3. IAM ロール（CloudWatch → SNS への通知権限）
# ──────────────────────────────────────────────────────────

# ── 1. SNS トピック ────────────────────────────────────────
resource "aws_sns_topic" "alert" {
  name = "${var.project_name}-${var.environment}-alert"
}

# メールサブスクリプション
# NOTE: Terraform apply 後、指定メールアドレスに確認メールが届く。
#       必ずメール内の「Confirm subscription」をクリックすること。
resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alert.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# ── 2. EC2 監視 ───────────────────────────────────────────
# EC2 CPU 使用率が閾値を超えたらアラーム
resource "aws_cloudwatch_metric_alarm" "ec2_cpu" {
  for_each = toset(var.ec2_instance_ids)

  alarm_name          = "${var.project_name}-${var.environment}-ec2-cpu-${each.key}"
  alarm_description   = "EC2 CPU 使用率が ${var.ec2_cpu_threshold}% を超過"
  namespace           = "AWS/EC2"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 300 # 5分
  evaluation_periods  = 2   # 2回連続で閾値超えたらアラーム
  threshold           = var.ec2_cpu_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"

  dimensions = {
    InstanceId = each.key
  }

  alarm_actions = [aws_sns_topic.alert.arn]
  ok_actions    = [aws_sns_topic.alert.arn]

  # TODO: StatusCheckFailed アラームも追加する（EC2 のハードウェア障害検知）
  # TODO: evaluation_periods を本番では 3 以上にして誤検知を減らす
}

# EC2 ステータスチェック失敗アラーム
resource "aws_cloudwatch_metric_alarm" "ec2_status_check" {
  for_each = toset(var.ec2_instance_ids)

  alarm_name          = "${var.project_name}-${var.environment}-ec2-status-${each.key}"
  alarm_description   = "EC2 ステータスチェック失敗（インスタンス障害の可能性）"
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"

  dimensions = {
    InstanceId = each.key
  }

  alarm_actions = [aws_sns_topic.alert.arn]
}

# ── 3. ALB 監視 ───────────────────────────────────────────
# ALB 5xx エラー数アラーム
resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  count = var.alb_arn_suffix != "" ? 1 : 0

  alarm_name          = "${var.project_name}-${var.environment}-alb-5xx"
  alarm_description   = "ALB 5xx エラーが ${var.alb_5xx_threshold} 件/分 を超過（アプリ障害の疑い）"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_ELB_5XX_Count"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 2
  threshold           = var.alb_5xx_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching" # データなし = 正常とみなす

  dimensions = {
    LoadBalancer = var.alb_arn_suffix
  }

  alarm_actions = [aws_sns_topic.alert.arn]

  # TODO: TargetResponseTime アラームも追加してレスポンス遅延を検知する
  # TODO: HealthyHostCount が 0 になったらアラームを追加する（全台ダウン検知）
}

# ── 4. RDS 監視 ───────────────────────────────────────────
# RDS CPU 使用率アラーム
resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  count = var.rds_instance_identifier != "" ? 1 : 0

  alarm_name          = "${var.project_name}-${var.environment}-rds-cpu"
  alarm_description   = "RDS CPU 使用率が ${var.rds_cpu_threshold}% を超過"
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = var.rds_cpu_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"

  dimensions = {
    DBInstanceIdentifier = var.rds_instance_identifier
  }

  alarm_actions = [aws_sns_topic.alert.arn]

  # TODO: DatabaseConnections（接続数）アラームも追加する
}

# RDS 空きストレージアラーム
resource "aws_cloudwatch_metric_alarm" "rds_storage" {
  count = var.rds_instance_identifier != "" ? 1 : 0

  alarm_name          = "${var.project_name}-${var.environment}-rds-storage"
  alarm_description   = "RDS 空きストレージが ${var.rds_storage_threshold_gb}GB 以下（ディスク枯渇の危険）"
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.rds_storage_threshold_gb * 1024 * 1024 * 1024 # GB → バイト変換
  comparison_operator = "LessThanOrEqualToThreshold"

  dimensions = {
    DBInstanceIdentifier = var.rds_instance_identifier
  }

  alarm_actions = [aws_sns_topic.alert.arn]
}

# ── 5. Lambda 監視 ────────────────────────────────────────
# Lambda エラー数アラーム（エラー発生を即時検知）
resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each = toset(var.lambda_function_names)

  alarm_name          = "${var.project_name}-${var.environment}-lambda-errors-${each.key}"
  alarm_description   = "Lambda 関数 ${each.key} でエラーが発生（${var.lambda_error_threshold} 件以上/5分）"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 300 # 5分
  evaluation_periods  = 1
  threshold           = var.lambda_error_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching" # 実行なし = 正常とみなす

  dimensions = {
    FunctionName = each.key
  }

  alarm_actions = [aws_sns_topic.alert.arn]
  ok_actions    = [aws_sns_topic.alert.arn]
}

# Lambda 実行時間アラーム（タイムアウト予兆を検知）
resource "aws_cloudwatch_metric_alarm" "lambda_duration" {
  for_each = toset(var.lambda_function_names)

  alarm_name          = "${var.project_name}-${var.environment}-lambda-duration-${each.key}"
  alarm_description   = "Lambda 関数 ${each.key} の実行時間が ${var.lambda_duration_threshold_ms}ms を超過（タイムアウト予兆）"
  namespace           = "AWS/Lambda"
  metric_name         = "Duration"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = var.lambda_duration_threshold_ms
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = each.key
  }

  alarm_actions = [aws_sns_topic.alert.arn]
}

# Lambda スロットリングアラーム（同時実行数の上限到達を検知）
resource "aws_cloudwatch_metric_alarm" "lambda_throttles" {
  for_each = toset(var.lambda_function_names)

  alarm_name          = "${var.project_name}-${var.environment}-lambda-throttles-${each.key}"
  alarm_description   = "Lambda 関数 ${each.key} でスロットリングが発生（同時実行数が上限に到達）"
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.lambda_throttle_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = each.key
  }

  alarm_actions = [aws_sns_topic.alert.arn]
}

# ── 6. CloudWatch ダッシュボード ───────────────────────────
resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "${var.project_name}-${var.environment}-dashboard"

  dashboard_body = jsonencode({
    widgets = [
      {
        type = "text"
        properties = {
          markdown = "# ${var.project_name}-${var.environment} 監視ダッシュボード\n\n監視対象: EC2 / ALB / RDS"
        }
      }
      # TODO: EC2 CPU グラフウィジェットを追加する
      # TODO: ALB リクエスト数・5xx グラフを追加する
      # TODO: RDS CPU・接続数グラフを追加する
    ]
  })
}

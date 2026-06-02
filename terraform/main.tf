# ── 監視・アラート構成 ─────────────────────────────────────
# このファイルでは以下を構築する:
#   1. SNS トピック（アラーム通知先）
#   2. CloudWatch アラーム（EC2 / ALB / RDS）
#   3. IAM ロール（CloudWatch → SNS への通知権限）
#   4. Cost Anomaly Detection（コスト異常検知）
# ──────────────────────────────────────────────────────────

# ── 0. ダッシュボードウィジェット定義 ─────────────────────
locals {
  # EC2 CPU ウィジェット（監視対象インスタンスごとに 1 つ生成）
  ec2_cpu_widgets = [for id in var.ec2_instance_ids : {
    type   = "metric"
    width  = 12
    height = 6
    properties = {
      title  = "EC2 CPU使用率 - ${id}"
      region = var.aws_region
      metrics = [["AWS/EC2", "CPUUtilization", "InstanceId", id,
        { stat = "Average", period = 300 }
      ]]
      yAxis = { left = { min = 0, max = 100 } }
      annotations = {
        horizontal = [{
          value = var.ec2_cpu_threshold
          label = "閾値 ${var.ec2_cpu_threshold}%"
          color = "#ff6961"
        }]
      }
    }
  }]

  # ALB 5xx ウィジェット（alb_arn_suffix が空の場合はスキップ）
  alb_widgets = var.alb_arn_suffix != "" ? [{
    type   = "metric"
    width  = 12
    height = 6
    properties = {
      title  = "ALB 5xxエラー数"
      region = var.aws_region
      metrics = [["AWS/ApplicationELB", "HTTPCode_ELB_5XX_Count",
        "LoadBalancer", var.alb_arn_suffix,
        { stat = "Sum", period = 60 }
      ]]
      yAxis = { left = { min = 0 } }
      annotations = {
        horizontal = [{
          value = var.alb_5xx_threshold
          label = "閾値 ${var.alb_5xx_threshold}件/分"
          color = "#ff6961"
        }]
      }
    }
  }] : []

  # RDS CPU ウィジェット（rds_instance_identifier が空の場合はスキップ）
  rds_widgets = var.rds_instance_identifier != "" ? [{
    type   = "metric"
    width  = 12
    height = 6
    properties = {
      title  = "RDS CPU使用率 - ${var.rds_instance_identifier}"
      region = var.aws_region
      metrics = [["AWS/RDS", "CPUUtilization",
        "DBInstanceIdentifier", var.rds_instance_identifier,
        { stat = "Average", period = 300 }
      ]]
      yAxis = { left = { min = 0, max = 100 } }
      annotations = {
        horizontal = [{
          value = var.rds_cpu_threshold
          label = "閾値 ${var.rds_cpu_threshold}%"
          color = "#ff6961"
        }]
      }
    }
  }] : []

  # 全ウィジェットを結合（テキストヘッダー + EC2 + ALB + RDS）
  dashboard_widgets = concat(
    [{
      type   = "text"
      width  = 24
      height = 3
      properties = {
        markdown = "# ${var.project_name}-${var.environment} 監視ダッシュボード\n\n監視対象: EC2 / ALB / RDS"
      }
    }],
    local.ec2_cpu_widgets,
    local.alb_widgets,
    local.rds_widgets,
  )
}

# ── 1. SNS トピック ────────────────────────────────────────
resource "aws_sns_topic" "alert" {
  name = "${var.project_name}-${var.environment}-alert"
  # AWS マネージドキーで保存データを暗号化（CKV_AWS_26 / 追加コストなし）
  kms_master_key_id = "alias/aws/sns"
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

# ── 6. Cost Anomaly Detection ─────────────────────────────
# AWS の課金異常を自動検知して SNS 通知する
# サービス別の支出を監視し、急激なコスト増加をアラート

# SNS トピックポリシー（Cost Explorer からの Publish を許可）
resource "aws_sns_topic_policy" "cost_anomaly" {
  arn = aws_sns_topic.alert.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCostAnomalyDetection"
      Effect    = "Allow"
      Principal = { Service = "costalerts.amazonaws.com" }
      Action    = "SNS:Publish"
      Resource  = aws_sns_topic.alert.arn
    }]
  })
}

# コスト異常モニター（AWSサービス別に監視）
resource "aws_ce_anomaly_monitor" "service" {
  name              = "${var.project_name}-${var.environment}-cost-monitor"
  monitor_type      = "DIMENSIONAL"
  monitor_dimension = "SERVICE"

  tags = {
    Environment = var.environment
    Project     = var.project_name
    ManagedBy   = "Terraform"
  }
}

# 異常検知サブスクリプション（日次・影響金額 20% 以上で通知）
resource "aws_ce_anomaly_subscription" "daily" {
  name      = "${var.project_name}-${var.environment}-cost-alert"
  frequency = "DAILY"

  monitor_arn_list = [aws_ce_anomaly_monitor.service.arn]

  # 閾値: 前日比でコストが var.cost_anomaly_impact_percentage % 以上増加した場合に通知
  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_PERCENTAGE"
      values        = [tostring(var.cost_anomaly_impact_percentage)]
      match_options = ["GREATER_THAN_OR_EQUAL"]
    }
  }

  subscriber {
    address = aws_sns_topic.alert.arn
    type    = "SNS"
  }

  tags = {
    Environment = var.environment
    Project     = var.project_name
    ManagedBy   = "Terraform"
  }
}

# ── 7. CloudWatch ダッシュボード ───────────────────────────
resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "${var.project_name}-${var.environment}-dashboard"

  dashboard_body = jsonencode({
    widgets = local.dashboard_widgets
  })
}

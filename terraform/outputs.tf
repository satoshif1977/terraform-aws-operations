output "sns_topic_arn" {
  description = "アラーム通知用 SNS トピック ARN"
  value       = aws_sns_topic.alert.arn
}

output "dashboard_url" {
  description = "CloudWatch ダッシュボード URL"
  value       = "https://${var.aws_region}.console.aws.amazon.com/cloudwatch/home?region=${var.aws_region}#dashboards:name=${aws_cloudwatch_dashboard.main.dashboard_name}"
}

output "alarm_names" {
  description = "作成された CloudWatch アラーム名一覧"
  value = concat(
    [for k, v in aws_cloudwatch_metric_alarm.ec2_cpu : v.alarm_name],
    [for k, v in aws_cloudwatch_metric_alarm.ec2_status_check : v.alarm_name],
    aws_cloudwatch_metric_alarm.alb_5xx[*].alarm_name,
    aws_cloudwatch_metric_alarm.rds_cpu[*].alarm_name,
    aws_cloudwatch_metric_alarm.rds_storage[*].alarm_name,
  )
}

output "cost_anomaly_monitor_arn" {
  description = "Cost Anomaly Detection モニター ARN"
  value       = aws_ce_anomaly_monitor.service.arn
}

output "cost_anomaly_subscription_arn" {
  description = "Cost Anomaly Detection サブスクリプション ARN"
  value       = aws_ce_anomaly_subscription.daily.arn
}

# ── セキュリティ監視 Outputs ──────────────────────────────

output "guardduty_detector_id" {
  description = "GuardDuty 検知器 ID"
  value       = aws_guardduty_detector.main.id
}

output "guardduty_notifier_function_name" {
  description = "GuardDuty Finding 通知 Lambda 関数名"
  value       = aws_lambda_function.guardduty_notifier.function_name
}

output "security_hub_enabled" {
  description = "Security Hub 有効化状態"
  value       = var.securityhub_enabled
}

output "config_s3_bucket" {
  description = "AWS Config ログ保存 S3 バケット名"
  value       = var.config_enabled ? aws_s3_bucket.config_logs[0].bucket : null
}

# ── DynamoDB Streams Outputs ──────────────────────────────

output "incidents_table_name" {
  description = "インシデント記録 DynamoDB テーブル名"
  value       = var.streams_pipe_enabled ? aws_dynamodb_table.incidents[0].name : null
}

output "incidents_stream_arn" {
  description = "インシデントテーブル DynamoDB Stream ARN"
  value       = var.streams_pipe_enabled ? aws_dynamodb_table.incidents[0].stream_arn : null
}

output "streams_alert_function_name" {
  description = "DynamoDB Streams アラート Lambda 関数名"
  value       = var.streams_pipe_enabled ? aws_lambda_function.streams_alert[0].function_name : null
}

output "streams_pipe_name" {
  description = "DynamoDB Streams → Lambda EventBridge Pipes 名"
  value       = var.streams_pipe_enabled ? aws_pipes_pipe.streams_alert[0].name : null
}

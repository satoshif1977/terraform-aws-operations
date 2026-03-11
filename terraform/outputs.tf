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

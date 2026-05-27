# ── 命名規則テスト ─────────────────────────────────────────
# SNS トピック・CloudWatch リソースが {project}-{env}-{suffix} の命名規則に
# 従っていることを AWS 接続なしで検証する。

mock_provider "aws" {
  mock_resource "aws_sns_topic" {
    defaults = {
      arn = "arn:aws:sns:ap-northeast-1:123456789012:mock-alert-topic"
    }
  }
  mock_resource "aws_ce_anomaly_monitor" {
    defaults = {
      arn = "arn:aws:ce::123456789012:anomalymonitor/mock-monitor"
    }
  }
}

# ── SNS トピック命名規則の確認 ─────────────────────────────

run "sns_topic_naming" {
  variables {
    project_name = "myapp"
    environment  = "dev"
    alert_email  = "test@example.com"
  }

  assert {
    condition     = aws_sns_topic.alert.name == "myapp-dev-alert"
    error_message = "SNS トピック名が {project}-{env}-alert 形式でない: ${aws_sns_topic.alert.name}"
  }
}

# ── ダッシュボード命名規則の確認 ──────────────────────────

run "dashboard_naming" {
  variables {
    project_name = "myapp"
    environment  = "prod"
    alert_email  = "test@example.com"
  }

  assert {
    condition     = aws_cloudwatch_dashboard.main.dashboard_name == "myapp-prod-dashboard"
    error_message = "ダッシュボード名が {project}-{env}-dashboard 形式でない: ${aws_cloudwatch_dashboard.main.dashboard_name}"
  }
}

# ── EC2 アラーム命名規則の確認 ────────────────────────────

run "ec2_alarm_naming" {
  variables {
    project_name     = "myapp"
    environment      = "stg"
    alert_email      = "test@example.com"
    ec2_instance_ids = ["i-0123456789abcdef0"]
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.ec2_cpu["i-0123456789abcdef0"].alarm_name == "myapp-stg-ec2-cpu-i-0123456789abcdef0"
    error_message = "EC2 CPU アラーム名が期待値と異なる: ${aws_cloudwatch_metric_alarm.ec2_cpu["i-0123456789abcdef0"].alarm_name}"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.ec2_status_check["i-0123456789abcdef0"].alarm_name == "myapp-stg-ec2-status-i-0123456789abcdef0"
    error_message = "EC2 ステータスチェック アラーム名が期待値と異なる: ${aws_cloudwatch_metric_alarm.ec2_status_check["i-0123456789abcdef0"].alarm_name}"
  }
}

# ── デフォルト値・閾値テスト ───────────────────────────────
# 変数のデフォルト値と CloudWatch アラームのメトリクス設定を検証する。
# ※ number 型の threshold/period は mock_provider が上書きするため var で検証する。

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
  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/mock-role"
    }
  }
  mock_resource "aws_cloudwatch_event_rule" {
    defaults = {
      arn = "arn:aws:events:ap-northeast-1:123456789012:rule/mock-rule"
    }
  }
  mock_resource "aws_lambda_function" {
    defaults = {
      arn           = "arn:aws:lambda:ap-northeast-1:123456789012:function:mock-function"
      invoke_arn    = "arn:aws:apigateway:ap-northeast-1:lambda:path/2015-03-31/functions/arn:aws:lambda:ap-northeast-1:123456789012:function:mock-function/invocations"
      qualified_arn = "arn:aws:lambda:ap-northeast-1:123456789012:function:mock-function:$LATEST"
    }
  }
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
      arn        = "arn:aws:iam::123456789012:user/mock-user"
      user_id    = "AIDAMOCKUSERID"
    }
  }
}

# ── EC2 変数デフォルト値の確認 ──────────────────────────

run "ec2_cpu_threshold_custom_value" {
  # terraform.tfvars の ec2_cpu_threshold=1 をテスト内で上書きして検証する
  variables {
    alert_email       = "test@example.com"
    ec2_cpu_threshold = 90
  }

  assert {
    condition     = var.ec2_cpu_threshold == 90
    error_message = "EC2 CPU 閾値の変数上書きが機能していない: ${var.ec2_cpu_threshold}"
  }
}

run "rds_cpu_threshold_default_is_80" {
  variables {
    alert_email = "test@example.com"
  }

  assert {
    condition     = var.rds_cpu_threshold == 80
    error_message = "RDS CPU 閾値のデフォルトが 80 でない: ${var.rds_cpu_threshold}"
  }
}

run "rds_storage_threshold_default_is_5gb" {
  variables {
    alert_email = "test@example.com"
  }

  assert {
    condition     = var.rds_storage_threshold_gb == 5
    error_message = "RDS ストレージ閾値のデフォルトが 5GB でない: ${var.rds_storage_threshold_gb}"
  }
}

run "lambda_error_threshold_default_is_1" {
  variables {
    alert_email = "test@example.com"
  }

  assert {
    condition     = var.lambda_error_threshold == 1
    error_message = "Lambda エラー閾値のデフォルトが 1 でない: ${var.lambda_error_threshold}"
  }
}

run "lambda_duration_threshold_default_is_10s" {
  variables {
    alert_email = "test@example.com"
  }

  assert {
    condition     = var.lambda_duration_threshold_ms == 10000
    error_message = "Lambda 実行時間閾値のデフォルトが 10000ms でない: ${var.lambda_duration_threshold_ms}"
  }
}

# ── メトリクス設定（namespace / metric_name）の確認 ────────

run "ec2_cpu_metric_config" {
  variables {
    alert_email      = "test@example.com"
    ec2_instance_ids = ["i-0123456789abcdef0"]
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.ec2_cpu["i-0123456789abcdef0"].namespace == "AWS/EC2"
    error_message = "EC2 CPU アラームの namespace が AWS/EC2 でない"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.ec2_cpu["i-0123456789abcdef0"].metric_name == "CPUUtilization"
    error_message = "EC2 CPU アラームの metric_name が CPUUtilization でない"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.ec2_cpu["i-0123456789abcdef0"].statistic == "Average"
    error_message = "EC2 CPU アラームの statistic が Average でない"
  }
}

# ── treat_missing_data の設定確認 ─────────────────────────

run "alb_treat_missing_data_not_breaching" {
  variables {
    alert_email    = "test@example.com"
    alb_arn_suffix = "app/my-alb/50dc6c495c0c9188"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.alb_5xx[0].treat_missing_data == "notBreaching"
    error_message = "ALB アラームの treat_missing_data が notBreaching でない"
  }
}

run "lambda_treat_missing_data_not_breaching" {
  variables {
    alert_email           = "test@example.com"
    lambda_function_names = ["my-function"]
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.lambda_errors["my-function"].treat_missing_data == "notBreaching"
    error_message = "Lambda エラーアラームの treat_missing_data が notBreaching でない"
  }
}

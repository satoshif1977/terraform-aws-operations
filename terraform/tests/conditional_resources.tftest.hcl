# ── 条件付きリソース生成テスト ─────────────────────────────
# ALB / RDS の監視リソースが変数の有無によって正しく制御されることを検証する。

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
  mock_resource "aws_dynamodb_table" {
    defaults = {
      arn        = "arn:aws:dynamodb:ap-northeast-1:123456789012:table/mock-incidents"
      stream_arn = "arn:aws:dynamodb:ap-northeast-1:123456789012:table/mock-incidents/stream/2026-01-01T00:00:00.000"
    }
  }
  mock_resource "aws_pipes_pipe" {
    defaults = {
      arn = "arn:aws:pipes:ap-northeast-1:123456789012:pipe/mock-streams-alert"
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

# ── ALB リソースの条件生成 ─────────────────────────────────

run "alb_alarm_not_created_when_empty" {
  variables {
    alert_email    = "test@example.com"
    alb_arn_suffix = "" # 空 = ALB なし
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.alb_5xx) == 0
    error_message = "alb_arn_suffix が空のとき ALB アラームは作成されないはず"
  }
}

run "alb_alarm_created_when_provided" {
  variables {
    alert_email    = "test@example.com"
    alb_arn_suffix = "app/my-alb/50dc6c495c0c9188"
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.alb_5xx) == 1
    error_message = "alb_arn_suffix が指定されているとき ALB アラームは 1件作成されるはず"
  }
}

# ── RDS リソースの条件生成 ─────────────────────────────────

run "rds_alarms_not_created_when_empty" {
  variables {
    alert_email             = "test@example.com"
    rds_instance_identifier = "" # 空 = RDS なし
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.rds_cpu) == 0
    error_message = "rds_instance_identifier が空のとき RDS CPU アラームは作成されないはず"
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.rds_storage) == 0
    error_message = "rds_instance_identifier が空のとき RDS ストレージアラームは作成されないはず"
  }
}

run "rds_alarms_created_when_provided" {
  variables {
    alert_email             = "test@example.com"
    rds_instance_identifier = "myapp-dev-db"
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.rds_cpu) == 1
    error_message = "rds_instance_identifier が指定されているとき RDS CPU アラームは 1件作成されるはず"
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.rds_storage) == 1
    error_message = "rds_instance_identifier が指定されているとき RDS ストレージアラームは 1件作成されるはず"
  }
}

# ── EC2 複数インスタンスの for_each 生成 ───────────────────

run "multiple_ec2_instances_create_multiple_alarms" {
  variables {
    alert_email = "test@example.com"
    ec2_instance_ids = [
      "i-0000000000000001",
      "i-0000000000000002",
      "i-0000000000000003",
    ]
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.ec2_cpu) == 3
    error_message = "EC2 インスタンス 3件に対して CPU アラームが 3件作成されるはず: ${length(aws_cloudwatch_metric_alarm.ec2_cpu)}"
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.ec2_status_check) == 3
    error_message = "EC2 インスタンス 3件に対してステータスチェックアラームが 3件作成されるはず"
  }
}

# ── EC2 なし（デフォルト）= アラームなし ──────────────────

run "no_ec2_instances_no_alarms" {
  variables {
    alert_email      = "test@example.com"
    ec2_instance_ids = []
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.ec2_cpu) == 0
    error_message = "ec2_instance_ids が空のとき EC2 アラームは作成されないはず"
  }
}

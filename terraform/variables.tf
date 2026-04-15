variable "project_name" {
  description = "プロジェクト名（リソース命名に使用）"
  type        = string
  default     = "ops"
}

variable "environment" {
  description = "環境名（dev / stg / prod）"
  type        = string
  default     = "dev"
}

variable "aws_region" {
  description = "デプロイ先 AWS リージョン"
  type        = string
  default     = "ap-northeast-1"
}

# ── アラーム通知先 ────────────────────────────────────────
variable "alert_email" {
  description = "CloudWatch アラーム通知先メールアドレス"
  type        = string
  # default は設定しない。terraform.tfvars に記載すること
}

# ── EC2 監視対象 ──────────────────────────────────────────
variable "ec2_instance_ids" {
  description = "監視対象の EC2 インスタンス ID リスト"
  type        = list(string)
  default     = []
  # TODO: 実際の EC2 インスタンス ID を terraform.tfvars に記載する
}

# ── ALB 監視対象 ──────────────────────────────────────────
variable "alb_arn_suffix" {
  description = "監視対象 ALB の ARN サフィックス（例: app/my-alb/xxx）"
  type        = string
  default     = ""
  # TODO: terraform output で interview-challenge の ALB ARN を取得して設定する
}

# ── RDS 監視対象 ──────────────────────────────────────────
variable "rds_instance_identifier" {
  description = "監視対象 RDS インスタンス識別子"
  type        = string
  default     = ""
  # TODO: interview-challenge の RDS 識別子を設定する
}

# ── アラーム閾値 ──────────────────────────────────────────
variable "ec2_cpu_threshold" {
  description = "EC2 CPU 使用率アラーム閾値（%）"
  type        = number
  default     = 80
}

variable "rds_cpu_threshold" {
  description = "RDS CPU 使用率アラーム閾値（%）"
  type        = number
  default     = 80
}

variable "rds_storage_threshold_gb" {
  description = "RDS 空きストレージアラーム閾値（GB）"
  type        = number
  default     = 5
}

variable "alb_5xx_threshold" {
  description = "ALB 5xx エラー数アラーム閾値（1分間）"
  type        = number
  default     = 10
}

# ── Lambda 監視対象 ───────────────────────────────────────
variable "lambda_function_names" {
  description = "監視対象の Lambda 関数名リスト"
  type        = list(string)
  default     = []
}

# ── Lambda アラーム閾値 ───────────────────────────────────
variable "lambda_error_threshold" {
  description = "Lambda エラー数アラーム閾値（5分間）"
  type        = number
  default     = 1
}

variable "lambda_duration_threshold_ms" {
  description = "Lambda 実行時間アラーム閾値（ミリ秒）"
  type        = number
  default     = 10000 # 10秒
}

variable "lambda_throttle_threshold" {
  description = "Lambda スロットリング数アラーム閾値（5分間）"
  type        = number
  default     = 1
}

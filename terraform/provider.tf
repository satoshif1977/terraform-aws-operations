terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # TODO: 本番運用時は S3 バックエンドに切り替える
  # backend "s3" {
  #   bucket         = "<your-bucket>"
  #   key            = "terraform-aws-operations/terraform.tfstate"
  #   region         = "ap-northeast-1"
  #   dynamodb_table = "<your-lock-table>"
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "Terraform"
    }
  }
}

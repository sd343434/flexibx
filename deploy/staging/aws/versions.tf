# Flexibx staging on AWS (Pass 15): one Docker host running deploy/staging/compose.yaml,
# a private PostgreSQL 16, a private bucket, image repositories and a secret container.
# Nothing here has been applied: README.md lists what the owner decides and provides first.
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.69"
    }
  }
  # State holds resource ids, not secrets (RDS keeps its own password; the env secret is
  # filled outside Terraform). Use a private, versioned state bucket for a shared setup.
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project     = "flexibx"
      Environment = "staging"
      ManagedBy   = "terraform"
    }
  }
}

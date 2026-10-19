output "public_ip" {
  description = "DNS A record of app_domain → this address."
  value       = aws_eip.host.public_ip
}

output "host_instance_id" {
  description = "aws ssm start-session --target <id>"
  value       = aws_instance.host.id
}

output "db_endpoint" {
  value = aws_db_instance.db.address
}

output "db_master_secret_arn" {
  description = "RDS-managed master password (Secrets Manager); used only to create the app roles."
  value       = aws_db_instance.db.master_user_secret[0].secret_arn
}

output "bucket" {
  value = aws_s3_bucket.media.bucket
}

output "env_secret_arn" {
  value = aws_secretsmanager_secret.env.arn
}

output "storage_user" {
  description = "Create its access key, then put it in the env secret as S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY."
  value       = aws_iam_user.storage.name
}

output "image_repositories" {
  value = { for key, repository in aws_ecr_repository.image : key => repository.repository_url }
}

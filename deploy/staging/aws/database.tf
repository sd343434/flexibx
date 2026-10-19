# PostgreSQL 16 for staging only. RDS generates and keeps the master password in Secrets
# Manager (manage_master_user_password): it never appears in Terraform state or the repo.
# The application connects with the roles of docs/runbooks/DATABASE_ROLES.md, created by
# the owner after the first apply; then the database is marked:
#   scripts/ops/db-environment.sh mark staging --confirm-database flexibx_staging
resource "aws_db_subnet_group" "db" {
  name       = "${var.name}-db"
  subnet_ids = data.aws_subnets.default.ids
}

resource "aws_db_instance" "db" {
  identifier                  = "${var.name}-db"
  engine                      = "postgres"
  engine_version              = "16"
  instance_class              = var.db_instance_class
  allocated_storage           = var.db_storage_gb
  storage_type                = "gp3"
  storage_encrypted           = true
  db_name                     = "flexibx_staging"
  username                    = "flexibx_admin"
  manage_master_user_password = true
  db_subnet_group_name        = aws_db_subnet_group.db.name
  vpc_security_group_ids      = [aws_security_group.db.id]
  publicly_accessible         = false
  multi_az                    = false
  backup_retention_period     = var.db_backup_retention_days
  # Keep the automated backups (and so point-in-time recovery) after an accidental
  # instance deletion, until their retention ends (Pass 16 audit; AWS default: delete).
  delete_automated_backups   = false
  copy_tags_to_snapshot      = true
  deletion_protection        = true
  skip_final_snapshot        = false
  final_snapshot_identifier  = "${var.name}-db-final"
  auto_minor_version_upgrade = true
  # PostgreSQL 15+ on RDS already requires TLS (rds.force_ssl = 1); DATABASE_URL must use
  # sslmode=require (staging.env.example).
}

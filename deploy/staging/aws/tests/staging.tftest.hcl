# Security properties of the staging infrastructure, checked by `terraform test` with a
# mocked AWS provider (Pass 16): the whole configuration is planned or "applied" against
# the mock (values made up in memory) — no credentials, no AWS call, nothing created. A passing test proves what the configuration ASKS for, not
# that AWS accepts it — only a real plan and apply in the owner's account show that.
#
#   cd deploy/staging/aws && terraform init -backend=false && terraform test

mock_provider "aws" {
  mock_data "aws_vpc" {
    defaults = { id = "vpc-0mock" }
  }
  mock_data "aws_subnets" {
    defaults = { ids = ["subnet-0mocka", "subnet-0mockb"] }
  }
  mock_data "aws_ssm_parameter" {
    defaults = { value = "ami-0mock", insecure_value = "ami-0mock" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::flexibx-staging-media-mock", id = "flexibx-staging-media-mock" }
  }
  mock_resource "aws_db_instance" {
    defaults = { master_user_secret = [{ secret_arn = "arn:aws:secretsmanager:mock", kms_key_id = "", secret_status = "active" }] }
  }
}

variables {
  region     = "me-central-1"
  app_domain = "staging.example.com"
}

run "database_is_private_encrypted_and_recoverable" {
  command = plan

  assert {
    condition     = aws_db_instance.db.publicly_accessible == false
    error_message = "the database must not be publicly accessible"
  }
  assert {
    condition     = aws_db_instance.db.storage_encrypted && aws_db_instance.db.deletion_protection
    error_message = "the database must be encrypted and protected from deletion"
  }
  assert {
    condition     = aws_db_instance.db.backup_retention_period >= 1 && aws_db_instance.db.delete_automated_backups == false
    error_message = "automated backups (PITR) must be on and survive an instance deletion"
  }
  assert {
    condition     = aws_db_instance.db.manage_master_user_password && aws_db_instance.db.skip_final_snapshot == false
    error_message = "RDS keeps the master password; a final snapshot is taken on deletion"
  }
  assert {
    condition     = aws_db_instance.db.engine == "postgres" && aws_db_instance.db.engine_version == "16"
    error_message = "PostgreSQL 16 (the major the backup tools and CI use)"
  }
}

run "database_reachable_only_from_the_host" {
  command = apply # against the mock only

  assert {
    condition     = aws_vpc_security_group_ingress_rule.db_from_host.from_port == 5432 && aws_vpc_security_group_ingress_rule.db_from_host.cidr_ipv4 == null
    error_message = "PostgreSQL may be reached only from the host's security group, never from an address range"
  }
  assert {
    condition = alltrue([
      for rule in [aws_vpc_security_group_ingress_rule.https, aws_vpc_security_group_ingress_rule.http] :
      contains([80, 443], rule.from_port)
    ])
    error_message = "the host accepts only HTTP(S) from outside (no SSH: SSM)"
  }
}

run "bucket_is_private_and_tls_only" {
  command = apply # against the mock only

  assert {
    condition = (aws_s3_bucket_public_access_block.media.block_public_acls
      && aws_s3_bucket_public_access_block.media.block_public_policy
      && aws_s3_bucket_public_access_block.media.ignore_public_acls
    && aws_s3_bucket_public_access_block.media.restrict_public_buckets)
    error_message = "every public-access block must be on"
  }
  assert {
    condition     = jsondecode(aws_s3_bucket_policy.media_tls_only.policy).Statement[0].Effect == "Deny" && jsondecode(aws_s3_bucket_policy.media_tls_only.policy).Statement[0].Condition.Bool["aws:SecureTransport"] == "false"
    error_message = "requests without TLS must be denied"
  }
  assert {
    condition     = one(aws_s3_bucket_ownership_controls.media.rule).object_ownership == "BucketOwnerEnforced"
    error_message = "ACLs disabled (bucket owner enforced)"
  }
  assert {
    condition     = one(one(aws_s3_bucket_server_side_encryption_configuration.media.rule).apply_server_side_encryption_by_default).sse_algorithm == "AES256"
    error_message = "objects are encrypted at rest"
  }
  assert {
    condition     = one(aws_s3_bucket_cors_configuration.media.cors_rule).allowed_origins == toset(["https://staging.example.com"]) || one(aws_s3_bucket_cors_configuration.media.cors_rule).allowed_origins == tolist(["https://staging.example.com"])
    error_message = "CORS allows only the app's own HTTPS origin"
  }
}

run "images_are_immutable_and_scanned" {
  command = plan

  assert {
    condition = alltrue([
      for repository in aws_ecr_repository.image :
      repository.image_tag_mutability == "IMMUTABLE" && one(repository.image_scanning_configuration).scan_on_push
    ])
    error_message = "every repository: immutable tags and scan on push"
  }
  assert {
    condition     = length(aws_ecr_repository.image) == 3
    error_message = "app, worker and ops"
  }
}

run "host_hardening" {
  command = apply # against the mock only

  assert {
    condition     = one(aws_instance.host.metadata_options).http_tokens == "required" && one(aws_instance.host.metadata_options).http_put_response_hop_limit == 1
    error_message = "IMDSv2 only, one hop (containers cannot borrow the host role)"
  }
  assert {
    condition     = one(aws_instance.host.root_block_device).encrypted
    error_message = "the host disk is encrypted"
  }
  assert {
    condition     = strcontains(templatefile("${path.module}/user-data.sh.tftpl", { app_domain = "staging.example.com" }), "\"max-size\": \"10m\"")
    error_message = "the host rotates container logs"
  }
  assert {
    condition     = strcontains(templatefile("${path.module}/user-data.sh.tftpl", { app_domain = "staging.example.com" }), "snap install aws-cli --classic")
    error_message = "the host has the AWS CLI to read the env secret (scripts/ops/render-staging-env.sh)"
  }
}

run "no_secret_is_created_by_terraform" {
  command = plan

  # The env secret is an empty container (the owner writes its value); there is no
  # aws_secretsmanager_secret_version and no aws_iam_access_key in this configuration.
  assert {
    condition     = aws_secretsmanager_secret.env.name == "flexibx-staging/env"
    error_message = "the env secret container exists"
  }
}

run "backup_retention_cannot_disable_pitr" {
  command = plan
  variables {
    db_backup_retention_days = 0
  }
  expect_failures = [var.db_backup_retention_days]
}

run "app_domain_must_be_a_plain_host" {
  command = plan
  variables {
    app_domain = "https://staging.example.com/"
  }
  expect_failures = [var.app_domain]
}

run "host_exposes_only_the_web_ports" {
  command = plan

  # No SSH: the host is reached through Session Manager only. Caddy needs 443 (and 80 for
  # the ACME challenge and the redirect).
  assert {
    condition = (
      aws_vpc_security_group_ingress_rule.https.from_port == 443 &&
      aws_vpc_security_group_ingress_rule.https.to_port == 443 &&
      aws_vpc_security_group_ingress_rule.http.from_port == 80 &&
      aws_vpc_security_group_ingress_rule.http.to_port == 80
    )
    error_message = "the host accepts 443 and 80 only"
  }
  assert {
    condition     = aws_vpc_security_group_ingress_rule.db_from_host.from_port == 5432 && aws_vpc_security_group_ingress_rule.db_from_host.to_port == 5432
    error_message = "the database accepts PostgreSQL only"
  }
}

run "nothing_is_deleted_with_its_data" {
  command = plan

  assert {
    condition     = aws_s3_bucket.media.force_destroy == false
    error_message = "the media bucket is never destroyed with its objects"
  }
  assert {
    condition     = alltrue([for repository in aws_ecr_repository.image : repository.force_delete == false])
    error_message = "image repositories are never deleted with their images"
  }
  assert {
    condition     = aws_secretsmanager_secret.env.recovery_window_in_days == 30
    error_message = "a deleted env secret stays recoverable for 30 days"
  }
  assert {
    condition     = aws_db_instance.db.deletion_protection && !aws_db_instance.db.skip_final_snapshot
    error_message = "the database has deletion protection and a final snapshot"
  }
}

run "iam_is_least_privilege" {
  command = apply # against the mock only

  # The storage user (the app's S3 key): named S3 actions only, on the media bucket only.
  assert {
    condition = alltrue(flatten([
      for statement in data.aws_iam_policy_document.storage.statement : [
        for action in statement.actions : startswith(action, "s3:") && !strcontains(action, "*")
      ]
    ]))
    error_message = "the storage user may use named S3 actions only"
  }
  assert {
    condition = alltrue(flatten([
      for statement in data.aws_iam_policy_document.storage.statement : [
        for resource in statement.resources : startswith(resource, aws_s3_bucket.media.arn)
      ]
    ]))
    error_message = "the storage user may touch the media bucket only"
  }
  # The host: read its one env secret, pull images; a wildcard resource only where AWS
  # allows nothing else (ecr:GetAuthorizationToken); no wildcard action anywhere.
  assert {
    condition = alltrue(flatten([
      for statement in data.aws_iam_policy_document.host.statement : [
        for action in statement.actions : !strcontains(action, "*")
      ]
    ]))
    error_message = "no wildcard action in the host policy"
  }
  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.host.statement :
      !contains(statement.resources, "*") || statement.actions == toset(["ecr:GetAuthorizationToken"])
    ])
    error_message = "a wildcard resource only for ecr:GetAuthorizationToken"
  }
  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.host.statement :
      statement.resources == toset([aws_secretsmanager_secret.env.arn])
      if contains(statement.actions, "secretsmanager:GetSecretValue")
    ])
    error_message = "the host reads the env secret and no other"
  }
  assert {
    condition     = aws_iam_role_policy_attachment.host_ssm.policy_arn == "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
    error_message = "the host's only managed policy is Session Manager's"
  }
}

# The staging bucket: private, encrypted, no versioning (a deleted project's objects must
# really go — docs/runbooks/CREATOR_STUDIO.md), CORS for the app's origin (browser PUT of
# upload parts) and the abort of incomplete multipart uploads that `creator:preflight`
# checks.
resource "aws_s3_bucket" "media" {
  bucket_prefix = "${var.name}-media-"
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket                  = aws_s3_bucket.media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Requests without TLS are refused, whoever signs them (Pass 16 audit).
resource "aws_s3_bucket_policy" "media_tls_only" {
  bucket = aws_s3_bucket.media.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.media.arn, "${aws_s3_bucket.media.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
  # The public-access block must exist first (it does not block a Deny statement).
  depends_on = [aws_s3_bucket_public_access_block.media]
}

resource "aws_s3_bucket_ownership_controls" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_cors_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  cors_rule {
    allowed_origins = ["https://${var.app_domain}"]
    allowed_methods = ["PUT"]
    allowed_headers = ["content-type"]
    expose_headers  = ["ETag"]
    max_age_seconds = 600
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"
    filter {
      prefix = "workspaces/"
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 3
    }
  }
}

# Immutable image tags: a release tag always names the same image (compose.yaml requires
# FLEXIBX_TAG); images are scanned on push.
resource "aws_ecr_repository" "image" {
  for_each             = toset(["app", "worker", "ops"])
  name                 = "${var.name}/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "AES256"
  }
}

# The environment of deploy/staging/staging.env, filled by the owner (never by Terraform:
# no secret value in state). The host reads it at boot into a mode-600 file.
resource "aws_secretsmanager_secret" "env" {
  name        = "${var.name}/env"
  description = "Flexibx staging environment (KEY=value lines, staging.env.example)."
}

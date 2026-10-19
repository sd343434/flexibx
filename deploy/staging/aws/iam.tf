# Two identities, each with only what it needs.
#
# 1. The storage user: the app and worker sign S3 requests with S3_ACCESS_KEY_ID /
#    S3_SECRET_ACCESS_KEY. Its access key is created by the owner (console or CLI) and
#    put into the env secret — not here, so the key never enters Terraform state.
resource "aws_iam_user" "storage" {
  name = "${var.name}-storage"
}

data "aws_iam_policy_document" "storage" {
  statement {
    sid = "Objects"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
    ]
    # Every object the application writes is under workspaces/ (src/server/storage).
    resources = ["${aws_s3_bucket.media.arn}/workspaces/*"]
  }
  statement {
    sid = "Bucket"
    actions = [
      "s3:ListBucket",
      "s3:ListBucketMultipartUploads",
      "s3:GetBucketCors",
      "s3:GetLifecycleConfiguration",
    ]
    resources = [aws_s3_bucket.media.arn]
  }
}

resource "aws_iam_user_policy" "storage" {
  name   = "bucket-only"
  user   = aws_iam_user.storage.name
  policy = data.aws_iam_policy_document.storage.json
}

# 2. The host: Session Manager (no SSH key, no port 22), read the env secret, pull images.
data "aws_iam_policy_document" "host_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "host" {
  name               = "${var.name}-host"
  assume_role_policy = data.aws_iam_policy_document.host_assume.json
}

resource "aws_iam_role_policy_attachment" "host_ssm" {
  role       = aws_iam_role.host.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "host" {
  statement {
    sid       = "EnvSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.env.arn]
  }
  statement {
    sid       = "PullImages"
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
    resources = [for repository in aws_ecr_repository.image : repository.arn]
  }
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "host" {
  name   = "staging-host"
  role   = aws_iam_role.host.id
  policy = data.aws_iam_policy_document.host.json
}

resource "aws_iam_instance_profile" "host" {
  name = "${var.name}-host"
  role = aws_iam_role.host.name
}

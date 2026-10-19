# The Docker host: Ubuntu 24.04 (Canonical's current AMI, from SSM), IMDSv2 only, an
# encrypted disk, a fixed public address for the DNS record. user-data installs Docker,
# Compose and Caddy (TLS for app_domain) from Ubuntu's archive and writes the Caddyfile;
# the release itself is deployed by the owner (README.md), not at boot.
data "aws_ssm_parameter" "ubuntu" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

resource "aws_instance" "host" {
  ami                    = data.aws_ssm_parameter.ubuntu.value
  instance_type          = var.host_instance_type
  subnet_id              = data.aws_subnets.default.ids[0]
  vpc_security_group_ids = [aws_security_group.host.id]
  iam_instance_profile   = aws_iam_instance_profile.host.name
  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    app_domain = var.app_domain
  })
  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size = var.host_disk_gb
    volume_type = "gp3"
    encrypted   = true
  }
  lifecycle {
    # A new AMI must not replace the host by itself.
    ignore_changes = [ami, user_data]
  }
  tags = {
    Name = "${var.name}-host"
  }
}

resource "aws_eip" "host" {
  instance = aws_instance.host.id
  domain   = "vpc"
}

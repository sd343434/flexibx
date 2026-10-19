# The account's default VPC: staging needs no network of its own. The database is not
# publicly accessible and only the host's security group may reach it.
data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

resource "aws_security_group" "host" {
  name        = "${var.name}-host"
  description = "Flexibx staging host: HTTPS in (Caddy), everything out. No SSH: use SSM."
  vpc_id      = data.aws_vpc.default.id
}

resource "aws_vpc_security_group_ingress_rule" "https" {
  security_group_id = aws_security_group.host.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

# Port 80 only for the ACME HTTP challenge and the redirect to HTTPS (Caddy).
resource "aws_vpc_security_group_ingress_rule" "http" {
  security_group_id = aws_security_group.host.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "host_all" {
  security_group_id = aws_security_group.host.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_security_group" "db" {
  name        = "${var.name}-db"
  description = "Flexibx staging database: PostgreSQL from the host only."
  vpc_id      = data.aws_vpc.default.id
}

resource "aws_vpc_security_group_ingress_rule" "db_from_host" {
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = aws_security_group.host.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

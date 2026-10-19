variable "region" {
  description = "AWS region. No default: data residency (decision D-1) decides it."
  type        = string
}

variable "app_domain" {
  description = "Public host name of staging, e.g. staging.example.com (DNS A record → the output public_ip)."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9.-]+\\.[a-z]{2,}$", var.app_domain))
    error_message = "app_domain must be a plain host name, without scheme or path."
  }
}

variable "name" {
  description = "Prefix of every resource name."
  type        = string
  default     = "flexibx-staging"
}

variable "host_instance_type" {
  description = "Docker host: app + worker (2 vCPU, 2 GiB) + scheduler. 2 vCPU / 8 GiB."
  type        = string
  default     = "t3.large"
}

variable "host_disk_gb" {
  description = "Root volume: images, logs and the worker's /work (≥ 3× the largest upload)."
  type        = number
  default     = 80
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.small"
}

variable "db_storage_gb" {
  type    = number
  default = 20
}

variable "db_backup_retention_days" {
  description = "Automated backups; > 0 also enables point-in-time recovery."
  type        = number
  default     = 7
}

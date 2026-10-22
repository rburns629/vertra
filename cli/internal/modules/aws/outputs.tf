# SPDX-License-Identifier: MIT
# What vertra turns into Helm values and kubectl access.

output "cluster" {
  value = {
    name    = aws_eks_cluster.this.name
    region  = var.region
    issuer  = aws_eks_cluster.this.identity[0].oidc[0].issuer
    mode    = var.mode
    version = var.kubernetes_version
  }
}

output "account" {
  value = local.account
}

output "task_registry" {
  value = "${local.registry}/${var.task_registry}"
}

output "platform_registry" {
  value = var.platform_registry == "" ? "" : "${local.registry}/${var.platform_registry}"
}

output "audit" {
  value = var.audit_export ? { bucket = aws_s3_bucket.audit[0].bucket, region = var.region } : null
}

output "logs" {
  value = var.logs ? {
    bucket = aws_s3_bucket.logs[0].bucket
    region = var.region
  } : null
}

output "backup" {
  value = var.backups ? {
    bucket = aws_s3_bucket.backups[0].bucket
    region = var.region
  } : null
}

# Where steps run: the node pool vertra adds to Auto Mode
# (vertra-steps), or standard mode's steps group; the same label and taint.
output "step_placement" {
  value = {
    nodeSelector = { "vertra.dev/pool" = "steps" }
    tolerations  = [{ key = "vertra.dev/steps", operator = "Equal", value = "true", effect = "NoSchedule" }]
  }
}

output "spot" {
  value = local.spot
}

output "catalog" {
  value = var.catalog_repository != "" ? {
    role_arn = aws_iam_role.publish[0].arn
  } : null
}

output "console_address" {
  value = var.console_zone != "" ? {
    host            = local.console_host
    zone_id         = aws_route53_zone.console[0].zone_id
    name_servers    = aws_route53_zone.console[0].name_servers
    certificate_arn = aws_acm_certificate.console[0].arn
    vpc_cidr        = aws_vpc.this.cidr_block
  } : null
}

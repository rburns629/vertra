# SPDX-License-Identifier: MIT
# What vertra turns into Helm values and kubectl access.

output "cluster" {
  value = {
    name     = google_container_cluster.this.name
    location = google_container_cluster.this.location
    issuer   = "https://container.googleapis.com/v1/projects/${var.project}/locations/${google_container_cluster.this.location}/clusters/${google_container_cluster.this.name}"
  }
}

output "workload_identity_pool" {
  value = local.workload_pool
}

output "task_registry" {
  value = "${var.region}-docker.pkg.dev/${var.project}/${var.task_registry}"
}

output "platform_registry" {
  value = var.platform_registry == "" ? "" : "${var.region}-docker.pkg.dev/${var.project}/${var.platform_registry}"
}

output "console_service_account" {
  value = google_service_account.console.email
}

output "audit" {
  value = var.audit_export ? { bucket = google_storage_bucket.audit[0].name } : null
}

output "logs" {
  value = var.logs ? {
    bucket          = google_storage_bucket.logs[0].name
    service_account = google_service_account.logs[0].email
  } : null
}

output "backup" {
  value = var.backups ? {
    bucket          = google_storage_bucket.backups[0].name
    service_account = google_service_account.backup[0].email
  } : null
}

# Standard mode: where steps run (the chart's scheduler.taskPlacement).
output "step_placement" {
  value = local.standard ? {
    nodeSelector = { "vertra.dev/pool" = "steps" }
    tolerations  = [{ key = "vertra.dev/steps", operator = "Equal", value = "true", effect = "NoSchedule" }]
    } : {
    # Autopilot: Spot Pods, except at `scaled` (on-demand).
    nodeSelector = local.pools.spot ? { "cloud.google.com/gke-spot" = "true" } : {}
    tolerations  = []
  }
}

output "console_address" {
  value = var.console_public ? {
    name = google_compute_global_address.console[0].name
    ip   = google_compute_global_address.console[0].address
  } : null
}

# The catalog repository's variables: GCP_WORKLOAD_IDENTITY_PROVIDER and
# PUBLISH_GCP_SERVICE_ACCOUNT.
output "catalog" {
  value = var.catalog_repository != "" ? {
    workload_identity_provider = google_iam_workload_identity_pool_provider.github[0].name
    service_account            = google_service_account.publish[0].email
  } : null
}

output "signing" {
  description = "The catalog's signing key as cosign names it (kms), and the account policy-controller reads signatures as."
  value = {
    key      = var.signing == "kms" ? "gcpkms://${google_kms_crypto_key.signing[0].id}" : ""
    verifier = var.signing != "none" ? google_service_account.verifier[0].email : ""
  }
}


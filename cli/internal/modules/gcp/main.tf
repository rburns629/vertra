# SPDX-License-Identifier: MIT

data "google_project" "this" {}

locals {
  standard = var.mode == "standard"
  # Standard mode's pools by size: the platform's (always one node, for the
  # console, kernel and Postgres) and the steps' (from zero, Spot except at
  # `scaled`, which runs on-demand).
  pools = {
    minimal   = { platform_type = "e2-medium", platform_max = 2, steps_type = "e2-standard-2", steps_max = 2, spot = true }
    resilient = { platform_type = "e2-standard-2", platform_max = 3, steps_type = "e2-standard-4", steps_max = 8, spot = true }
    scaled    = { platform_type = "e2-standard-2", platform_max = 4, steps_type = "e2-standard-4", steps_max = 30, spot = false }
    auto      = { platform_type = "e2-standard-2", platform_max = 3, steps_type = "e2-standard-4", steps_max = 8, spot = true }
  }[var.size]
  workload_pool = "${var.project}.svc.id.goog"
  ksa           = "serviceAccount:${local.workload_pool}[${var.namespace}"
}

resource "google_project_service" "apis" {
  for_each = toset([
    "artifactregistry.googleapis.com",
    "cloudbilling.googleapis.com", # prices on the approval screen
    "compute.googleapis.com",
    "container.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "storage.googleapis.com",
  ])
  service = each.value
  # Other things in the project may use them.
  disable_on_destroy = false
}

# --- network ---------------------------------------------------------------

resource "google_compute_network" "this" {
  name                    = var.name
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

resource "google_compute_subnetwork" "this" {
  name                     = var.name
  network                  = google_compute_network.this.id
  ip_cidr_range            = "10.10.0.0/20"
  private_ip_google_access = true
  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = "10.20.0.0/14"
  }
  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = "10.30.0.0/20"
  }
}

# --- the nodes' own identity: logs, metrics, pulling images; nothing else --

resource "google_service_account" "nodes" {
  account_id   = "${var.name}-nodes"
  display_name = "Vertra ${var.name}: GKE nodes"
  depends_on   = [google_project_service.apis]
}

resource "google_project_iam_member" "nodes" {
  for_each = toset([
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
    "roles/monitoring.viewer",
    "roles/stackdriver.resourceMetadata.writer",
    "roles/autoscaling.metricsWriter",
  ])
  project = var.project
  role    = each.value
  member  = google_service_account.nodes.member
}

# --- the cluster -------------------------------------------------------------

resource "google_container_cluster" "this" {
  name     = var.name
  location = local.standard ? "${var.region}-a" : var.region

  network    = google_compute_network.this.id
  subnetwork = google_compute_subnetwork.this.id
  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }

  release_channel {
    channel = "REGULAR"
  }
  # vertra destroy asks before deleting anything.
  deletion_protection = false

  enable_autopilot = local.standard ? null : true

  # Standard: Dataplane V2 (enforces the charts' NetworkPolicies; Autopilot
  # always has it), Workload Identity, and the node pools below.
  datapath_provider        = local.standard ? "ADVANCED_DATAPATH" : null
  remove_default_node_pool = local.standard ? true : null
  initial_node_count       = local.standard ? 1 : null
  dynamic "workload_identity_config" {
    for_each = local.standard ? [1] : []
    content {
      workload_pool = local.workload_pool
    }
  }

  # Autopilot: its nodes run as the nodes' identity above, not the
  # project's default (often an Editor).
  dynamic "cluster_autoscaling" {
    for_each = local.standard ? [] : [1]
    content {
      auto_provisioning_defaults {
        service_account = google_service_account.nodes.email
        oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]
      }
    }
  }

  depends_on = [google_project_iam_member.nodes]
}

resource "google_container_node_pool" "platform" {
  count    = local.standard ? 1 : 0
  name     = "platform"
  cluster  = google_container_cluster.this.id
  location = google_container_cluster.this.location
  autoscaling {
    min_node_count = 1
    max_node_count = local.pools.platform_max
  }
  node_config {
    machine_type    = local.pools.platform_type
    service_account = google_service_account.nodes.email
    oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]
    disk_size_gb    = 50
    workload_metadata_config {
      mode = "GKE_METADATA"
    }
  }
}

# Steps run here (the chart's scheduler.taskPlacement selects and tolerates
# it): scaled from zero, so it costs nothing while nothing runs.
resource "google_container_node_pool" "steps" {
  count    = local.standard ? 1 : 0
  name     = "steps"
  cluster  = google_container_cluster.this.id
  location = google_container_cluster.this.location
  autoscaling {
    min_node_count = var.step_headroom > 0 ? 1 : 0
    max_node_count = local.pools.steps_max
  }
  node_config {
    machine_type    = local.pools.steps_type
    spot            = local.pools.spot
    service_account = google_service_account.nodes.email
    oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]
    disk_size_gb    = 50
    labels = {
      "vertra.dev/pool" = "steps"
    }
    taint {
      key    = "vertra.dev/steps"
      value  = "true"
      effect = "NO_SCHEDULE"
    }
    workload_metadata_config {
      mode = "GKE_METADATA"
    }
  }
}

# --- registries --------------------------------------------------------------

resource "google_artifact_registry_repository" "tasks" {
  count         = var.create_task_registry ? 1 : 0
  repository_id = var.task_registry
  location      = var.region
  format        = "DOCKER"
  description   = "Vertra ${var.name}: the catalog's product images."
  depends_on    = [google_project_service.apis]
}

resource "google_artifact_registry_repository" "platform" {
  count         = var.platform_registry != "" ? 1 : 0
  repository_id = var.platform_registry
  location      = var.region
  format        = "DOCKER"
  description   = "Vertra ${var.name}: the platform's images, built from source."
  depends_on    = [google_project_service.apis]
}

# The nodes pull both.
resource "google_artifact_registry_repository_iam_member" "nodes_pull" {
  for_each   = toset(compact([var.task_registry, var.platform_registry]))
  location   = var.region
  repository = each.value
  role       = "roles/artifactregistry.reader"
  member     = google_service_account.nodes.member
  depends_on = [google_artifact_registry_repository.tasks, google_artifact_registry_repository.platform]
}

# --- the console's identity: reads the task registry (pinning image digests,
# and its scan Jobs pulling what they scan) ------------------------------

resource "google_service_account" "console" {
  account_id   = "${var.name}-console"
  display_name = "Vertra ${var.name}: console (reads the task registry)"
  depends_on   = [google_project_service.apis]
}

resource "google_artifact_registry_repository_iam_member" "console_read" {
  location   = var.region
  repository = var.task_registry
  role       = "roles/artifactregistry.reader"
  member     = google_service_account.console.member
  depends_on = [google_artifact_registry_repository.tasks]
}

resource "google_service_account_iam_member" "console_workload_identity" {
  for_each = toset([
    "console-execution-console",         # the console
    "console-execution-console-scanner", # its scan Jobs
  ])
  service_account_id = google_service_account.console.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "${local.ksa}/${each.value}]"
  depends_on         = [google_container_cluster.this]
}

# --- backups of the in-cluster database ------------------------------------

resource "google_storage_bucket" "backups" {
  count                       = var.backups ? 1 : 0
  name                        = "${var.project}-${var.name}-backups"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = var.delete_data
  lifecycle_rule {
    condition {
      age = var.backup_retention_days
    }
    action {
      type = "Delete"
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_service_account" "backup" {
  count        = var.backups ? 1 : 0
  account_id   = "${var.name}-backup"
  display_name = "Vertra ${var.name}: database backups (one bucket)"
  depends_on   = [google_project_service.apis]
}

resource "google_storage_bucket_iam_member" "backup" {
  for_each = var.backups ? toset(["roles/storage.objectCreator", "roles/storage.objectViewer"]) : toset([])
  bucket   = google_storage_bucket.backups[0].name
  role     = each.value
  member   = google_service_account.backup[0].member
}

resource "google_service_account_iam_member" "backup_workload_identity" {
  count              = var.backups ? 1 : 0
  service_account_id = google_service_account.backup[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "${local.ksa}/vertra-pg-backup]"
  depends_on         = [google_container_cluster.this]
}

# --- logs: Loki's bucket, archived after log_search_days --------------------
# Loki (single tenant) keeps chunks under fake/ and its index under index/;
# only chunks move to the Archive class, and Loki still reads them there.

resource "google_storage_bucket" "logs" {
  count                       = var.logs ? 1 : 0
  name                        = "${var.project}-${var.name}-logs"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = var.delete_data
  lifecycle_rule {
    condition {
      age            = var.log_search_days
      matches_prefix = ["fake/"]
    }
    action {
      type          = "SetStorageClass"
      storage_class = "ARCHIVE"
    }
  }
  lifecycle_rule {
    condition {
      age = var.log_keep_days + 1
    }
    action {
      type = "Delete"
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_service_account" "logs" {
  count        = var.logs ? 1 : 0
  account_id   = "${var.name}-logs"
  display_name = "Vertra ${var.name}: Loki's logs (one bucket)"
  depends_on   = [google_project_service.apis]
}

resource "google_storage_bucket_iam_member" "logs" {
  count  = var.logs ? 1 : 0
  bucket = google_storage_bucket.logs[0].name
  role   = "roles/storage.objectAdmin"
  member = google_service_account.logs[0].member
}

resource "google_service_account_iam_member" "logs_workload_identity" {
  count              = var.logs ? 1 : 0
  service_account_id = google_service_account.logs[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "${local.ksa}/vertra-loki]"
  depends_on         = [google_container_cluster.this]
}

# --- reaching the console: an address for its load balancer -----------------

resource "google_compute_global_address" "console" {
  count      = var.console_public ? 1 : 0
  name       = "${var.name}-console"
  depends_on = [google_project_service.apis]
}

# --- the catalog's CI: pushes images from main, by GitHub's OIDC token -------

# Deleted pools keep their id for 30 days, so each gets a fresh suffix.
resource "random_id" "pool" {
  count       = var.catalog_repository != "" ? 1 : 0
  byte_length = 3
}

resource "google_iam_workload_identity_pool" "github" {
  count                     = var.catalog_repository != "" ? 1 : 0
  workload_identity_pool_id = "${var.name}-gh-${random_id.pool[0].hex}"
  display_name              = "Vertra ${var.name}: catalog CI"
  depends_on                = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  count                              = var.catalog_repository != "" ? 1 : 0
  workload_identity_pool_id          = google_iam_workload_identity_pool.github[0].workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub Actions"
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }
  # Only the catalog repository's main branch: pull requests (any fork's
  # code) never get a token.
  attribute_condition = "assertion.repository == \"${var.catalog_repository}\" && assertion.ref == \"refs/heads/main\""
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "publish" {
  count        = var.catalog_repository != "" ? 1 : 0
  account_id   = "${var.name}-publish"
  display_name = "Vertra ${var.name}: catalog CI (pushes to the task registry)"
  depends_on   = [google_project_service.apis]
}

resource "google_artifact_registry_repository_iam_member" "publish" {
  count      = var.catalog_repository != "" ? 1 : 0
  location   = var.region
  repository = var.task_registry
  role       = "roles/artifactregistry.writer"
  member     = google_service_account.publish[0].member
  depends_on = [google_artifact_registry_repository.tasks]
}

resource "google_service_account_iam_member" "publish_federation" {
  count              = var.catalog_repository != "" ? 1 : 0
  service_account_id = google_service_account.publish[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github[0].name}/attribute.repository/${var.catalog_repository}"
}

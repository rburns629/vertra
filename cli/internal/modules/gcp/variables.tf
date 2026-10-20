# SPDX-License-Identifier: MIT

variable "project" {
  description = "The Google Cloud project, which must already exist with billing enabled."
  type        = string
}

variable "region" {
  description = "Where everything goes, e.g. us-central1."
  type        = string
}

variable "name" {
  description = "The cluster's name, and the prefix of everything else this creates."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,18}[a-z0-9]$", var.name))
    error_message = "3 to 20 lowercase letters, digits and dashes, starting with a letter."
  }
}

variable "mode" {
  description = "auto (GKE Autopilot: billed per Pod) or standard (node pools this sizes: billed per node)."
  type        = string
  default     = "auto"
  validation {
    condition     = contains(["auto", "standard"], var.mode)
    error_message = "auto or standard."
  }
}

variable "size" {
  description = "minimal, resilient, scaled or auto: sizes the standard mode's node pools (Autopilot follows the Pods)."
  type        = string
  default     = "minimal"
  validation {
    condition     = contains(["minimal", "resilient", "scaled", "auto"], var.size)
    error_message = "minimal, resilient, scaled or auto."
  }
}

variable "namespace" {
  description = "The platform's Kubernetes namespace: its ServiceAccounts get the cloud identities."
  type        = string
  default     = "vertra-system"
}

variable "step_headroom" {
  description = "Standard mode: steps that can start without waiting, so the steps pool keeps a node."
  type        = number
  default     = 0
}

variable "task_registry" {
  description = "The Artifact Registry repository steps' images come from: created unless it already exists (create_task_registry = false)."
  type        = string
  default     = "vertra-products"
}

variable "create_task_registry" {
  type    = bool
  default = true
}

variable "platform_registry" {
  description = "A repository for platform images built from source; empty when installing a release (its images come from GHCR)."
  type        = string
  default     = ""
}

variable "backups" {
  description = "A bucket for the in-cluster database's daily backups."
  type        = bool
  default     = true
}

variable "backup_retention_days" {
  type    = number
  default = 30
}

variable "delete_data" {
  description = "Let destroy delete the backup bucket even when it holds backups (vertra destroy asks first)."
  type        = bool
  default     = false
}

variable "console_public" {
  description = "Reserve a global address for reaching the console over HTTPS (the catalog's CI needs it)."
  type        = bool
  default     = true
}

variable "catalog_repository" {
  description = "The catalog's GitHub repository (owner/name): its CI may push to the task registry, from main only, without a key. Empty: none."
  type        = string
  default     = ""
}

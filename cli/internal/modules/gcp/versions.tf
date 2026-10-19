# SPDX-License-Identifier: MIT
# The cloud side of an Acyclix install on Google Cloud. acyclixctl runs it
# (embedded in the binary, so a CLI version always runs the module it was
# tested with); it also works on its own with OpenTofu or Terraform.

terraform {
  required_version = ">= 1.10"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "= 8.5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "= 3.9.1"
    }
  }
}

provider "google" {
  project = var.project
  region  = var.region
  default_labels = {
    "acyclix-environment" = var.name
  }
}

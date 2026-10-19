# SPDX-License-Identifier: MIT
# The cloud side of an Acyclix install on AWS. acyclixctl runs it (embedded
# in the binary); it also works on its own with OpenTofu or Terraform.

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.67.0"
    }
  }
}

provider "aws" {
  region  = var.region
  profile = var.profile != "" ? var.profile : null
  default_tags {
    tags = {
      "acyclix-environment" = var.name
    }
  }
}

# SPDX-License-Identifier: MIT

data "aws_caller_identity" "this" {}
data "aws_partition" "this" {}

data "aws_availability_zones" "this" {
  state = "available"
  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

locals {
  account   = data.aws_caller_identity.this.account_id
  partition = data.aws_partition.this.partition
  # EKS needs subnets in two zones.
  zones    = slice(data.aws_availability_zones.this.names, 0, 2)
  registry = "${local.account}.dkr.ecr.${var.region}.amazonaws.com"
  # Steps on Spot, except at `scaled` (on-demand).
  spot     = var.size != "scaled"
  auto     = var.mode == "auto"
  standard = var.mode == "standard"
  # Standard mode's groups by size: the platform's (always one node) and the
  # steps' (from zero; several types, so Spot has somewhere to come from).
  groups = {
    minimal   = { platform = "c6a.large", platform_max = 2, steps_max = 3 }
    resilient = { platform = "c6a.large", platform_max = 3, steps_max = 13 }
    scaled    = { platform = "m6a.large", platform_max = 4, steps_max = 50 }
    auto      = { platform = "c6a.large", platform_max = 3, steps_max = 13 }
  }[var.size]
}

# --- network: public subnets in two zones, no NAT gateway (it would cost
# more than a small install's nodes); nodes get public addresses, and their
# security group admits nothing from outside ---------------------------------

resource "aws_vpc" "this" {
  cidr_block           = "10.40.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = var.name }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = var.name }
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.this.id
  availability_zone       = local.zones[count.index]
  cidr_block              = cidrsubnet(aws_vpc.this.cidr_block, 4, count.index)
  map_public_ip_on_launch = true
  tags = {
    Name                                = "${var.name}-${local.zones[count.index]}"
    "kubernetes.io/role/elb"            = "1"
    "kubernetes.io/cluster/${var.name}" = "shared"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
  tags = { Name = var.name }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# --- the cluster: EKS Auto Mode -----------------------------------------------

data "aws_iam_policy_document" "cluster_trust" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cluster" {
  name               = "${var.name}-cluster"
  assume_role_policy = data.aws_iam_policy_document.cluster_trust.json
}

resource "aws_iam_role_policy_attachment" "cluster" {
  for_each = toset([
    "AmazonEKSClusterPolicy",
    "AmazonEKSComputePolicy",
    "AmazonEKSBlockStoragePolicy",
    "AmazonEKSLoadBalancingPolicy",
    "AmazonEKSNetworkingPolicy",
  ])
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/${each.value}"
}

data "aws_iam_policy_document" "node_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

# The nodes' own identity: joining the cluster and pulling images; in
# standard mode also the VPC CNI's addresses.
resource "aws_iam_role" "nodes" {
  name               = "${var.name}-nodes"
  assume_role_policy = data.aws_iam_policy_document.node_trust.json
}

resource "aws_iam_role_policy_attachment" "nodes" {
  for_each = toset(local.auto ? [
    "AmazonEKSWorkerNodeMinimalPolicy",
    "AmazonEC2ContainerRegistryPullOnly",
    ] : [
    "AmazonEKSWorkerNodePolicy",
    "AmazonEKS_CNI_Policy",
    "AmazonEC2ContainerRegistryPullOnly",
  ])
  role       = aws_iam_role.nodes.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/${each.value}"
}

resource "aws_eks_cluster" "this" {
  name     = var.name
  version  = var.kubernetes_version
  role_arn = aws_iam_role.cluster.arn

  # Who signs in: EKS access entries; you (who ran this) as admin.
  access_config {
    authentication_mode                         = "API"
    bootstrap_cluster_creator_admin_permissions = true
  }
  # Auto Mode runs CoreDNS, kube-proxy, the VPC CNI and the EBS driver
  # itself; standard mode gets them as EKS add-ons, below.
  bootstrap_self_managed_addons = false

  dynamic "compute_config" {
    for_each = local.auto ? [1] : []
    content {
      enabled       = true
      node_pools    = ["general-purpose", "system"]
      node_role_arn = aws_iam_role.nodes.arn
    }
  }
  dynamic "kubernetes_network_config" {
    for_each = local.auto ? [1] : []
    content {
      elastic_load_balancing {
        enabled = true
      }
    }
  }
  dynamic "storage_config" {
    for_each = local.auto ? [1] : []
    content {
      block_storage {
        enabled = true
      }
    }
  }
  vpc_config {
    subnet_ids              = aws_subnet.public[*].id
    endpoint_public_access  = true
    endpoint_private_access = true
  }

  depends_on = [aws_iam_role_policy_attachment.cluster, aws_route_table_association.public]
}

# --- standard mode: node groups, add-ons, the Cluster Autoscaler's identity --

resource "aws_eks_node_group" "platform" {
  count           = local.standard ? 1 : 0
  cluster_name    = aws_eks_cluster.this.name
  node_group_name = "platform"
  node_role_arn   = aws_iam_role.nodes.arn
  subnet_ids      = aws_subnet.public[*].id
  instance_types  = [local.groups.platform]
  capacity_type   = "ON_DEMAND"
  disk_size       = 20
  scaling_config {
    min_size     = 1
    desired_size = 1
    max_size     = local.groups.platform_max
  }
  # The Cluster Autoscaler moves desired_size.
  lifecycle {
    ignore_changes = [scaling_config[0].desired_size]
  }
  depends_on = [aws_iam_role_policy_attachment.nodes, aws_eks_addon.cni]
}

# Steps run here (the chart's scheduler.taskPlacement selects and tolerates
# it), from zero nodes; Spot except at `scaled`.
resource "aws_eks_node_group" "steps" {
  count           = local.standard ? 1 : 0
  cluster_name    = aws_eks_cluster.this.name
  node_group_name = "steps"
  node_role_arn   = aws_iam_role.nodes.arn
  subnet_ids      = aws_subnet.public[*].id
  instance_types  = ["c6a.large", "c5a.large", "c6i.large", "c7a.large", "m6a.large"]
  capacity_type   = local.spot ? "SPOT" : "ON_DEMAND"
  disk_size       = 20
  labels = {
    "vertra.dev/pool" = "steps"
  }
  taint {
    key    = "vertra.dev/steps"
    value  = "true"
    effect = "NO_SCHEDULE"
  }
  scaling_config {
    min_size     = var.step_headroom > 0 ? 1 : 0
    desired_size = var.step_headroom > 0 ? 1 : 0
    max_size     = local.groups.steps_max
  }
  lifecycle {
    ignore_changes = [scaling_config[0].desired_size]
  }
  depends_on = [aws_iam_role_policy_attachment.nodes, aws_eks_addon.cni]
}

resource "aws_eks_addon" "cni" {
  for_each     = local.standard ? toset(["vpc-cni", "kube-proxy", "eks-pod-identity-agent"]) : toset([])
  cluster_name = aws_eks_cluster.this.name
  addon_name   = each.value
}

# CoreDNS and the EBS driver run as Pods: after the platform's node.
resource "aws_eks_addon" "coredns" {
  count        = local.standard ? 1 : 0
  cluster_name = aws_eks_cluster.this.name
  addon_name   = "coredns"
  depends_on   = [aws_eks_node_group.platform]
}

resource "aws_iam_role" "ebs" {
  count              = local.standard ? 1 : 0
  name               = "${var.name}-ebs"
  assume_role_policy = data.aws_iam_policy_document.pod_trust.json
}

resource "aws_iam_role_policy_attachment" "ebs" {
  count      = local.standard ? 1 : 0
  role       = aws_iam_role.ebs[0].name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"
}

resource "aws_eks_addon" "ebs" {
  count        = local.standard ? 1 : 0
  cluster_name = aws_eks_cluster.this.name
  addon_name   = "aws-ebs-csi-driver"
  pod_identity_association {
    role_arn        = aws_iam_role.ebs[0].arn
    service_account = "ebs-csi-controller-sa"
  }
  depends_on = [aws_eks_node_group.platform, aws_eks_addon.cni]
}

# The Cluster Autoscaler (vertra installs it): resize this cluster's
# groups only, by their tags.
resource "aws_iam_role" "autoscaler" {
  count              = local.standard ? 1 : 0
  name               = "${var.name}-autoscaler"
  assume_role_policy = data.aws_iam_policy_document.pod_trust.json
}

data "aws_iam_policy_document" "autoscaler" {
  count = local.standard ? 1 : 0
  statement {
    actions = [
      "autoscaling:DescribeAutoScalingGroups", "autoscaling:DescribeAutoScalingInstances",
      "autoscaling:DescribeLaunchConfigurations", "autoscaling:DescribeScalingActivities",
      "autoscaling:DescribeTags", "ec2:DescribeImages", "ec2:DescribeInstanceTypes",
      "ec2:DescribeLaunchTemplateVersions", "ec2:GetInstanceTypesFromInstanceRequirements",
      "eks:DescribeNodegroup",
    ]
    resources = ["*"]
  }
  statement {
    actions   = ["autoscaling:SetDesiredCapacity", "autoscaling:TerminateInstanceInAutoScalingGroup"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/k8s.io/cluster-autoscaler/${var.name}"
      values   = ["owned"]
    }
  }
}

resource "aws_iam_role_policy" "autoscaler" {
  count  = local.standard ? 1 : 0
  name   = "resize-node-groups"
  role   = aws_iam_role.autoscaler[0].id
  policy = data.aws_iam_policy_document.autoscaler[0].json
}

resource "aws_eks_pod_identity_association" "autoscaler" {
  count           = local.standard ? 1 : 0
  cluster_name    = aws_eks_cluster.this.name
  namespace       = "kube-system"
  service_account = "cluster-autoscaler"
  role_arn        = aws_iam_role.autoscaler[0].arn
  depends_on      = [aws_eks_addon.cni]
}

# --- registries: ECR creates a product's repository on its first push -------

resource "aws_ecr_repository_creation_template" "tasks" {
  prefix               = var.task_registry
  applied_for          = ["CREATE_ON_PUSH"]
  description          = "Vertra ${var.name}: the catalog's product images"
  image_tag_mutability = "MUTABLE"
  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_repository" "platform" {
  for_each             = var.platform_registry != "" ? toset(["execution-kernel", "execution-console"]) : toset([])
  name                 = "${var.platform_registry}/${each.value}"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
}

# --- identities for Pods (EKS Pod Identity) ----------------------------------

data "aws_iam_policy_document" "pod_trust" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }
  }
}

# The console and its scan Jobs read the task registry (pinning digests,
# scanning what they pin).
resource "aws_iam_role" "console" {
  name               = "${var.name}-console"
  assume_role_policy = data.aws_iam_policy_document.pod_trust.json
}

data "aws_iam_policy_document" "console" {
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability", "ecr:DescribeImages"]
    resources = ["arn:${local.partition}:ecr:${var.region}:${local.account}:repository/${var.task_registry}/*"]
  }
}

resource "aws_iam_role_policy" "console" {
  name   = "read-task-registry"
  role   = aws_iam_role.console.id
  policy = data.aws_iam_policy_document.console.json
}

resource "aws_eks_pod_identity_association" "console" {
  for_each        = toset(["console-execution-console", "console-execution-console-scanner"])
  cluster_name    = aws_eks_cluster.this.name
  namespace       = var.namespace
  service_account = each.value
  role_arn        = aws_iam_role.console.arn
}

# --- backups of the in-cluster database: one bucket, one writer --------------

resource "aws_s3_bucket" "backups" {
  count         = var.backups ? 1 : 0
  bucket        = "${var.name}-backups-${local.account}-${var.region}"
  force_destroy = var.delete_data
}

resource "aws_s3_bucket_public_access_block" "backups" {
  count                   = var.backups ? 1 : 0
  bucket                  = aws_s3_bucket.backups[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  count  = var.backups ? 1 : 0
  bucket = aws_s3_bucket.backups[0].id
  rule {
    id     = "expire"
    status = "Enabled"
    filter {}
    expiration {
      days = var.backup_retention_days
    }
  }
}

resource "aws_iam_role" "backup" {
  count              = var.backups ? 1 : 0
  name               = "${var.name}-backup"
  assume_role_policy = data.aws_iam_policy_document.pod_trust.json
}

data "aws_iam_policy_document" "backup" {
  count = var.backups ? 1 : 0
  statement {
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.backups[0].arn}/*"]
  }
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.backups[0].arn]
  }
}

resource "aws_iam_role_policy" "backup" {
  count  = var.backups ? 1 : 0
  name   = "write-backups"
  role   = aws_iam_role.backup[0].id
  policy = data.aws_iam_policy_document.backup[0].json
}

resource "aws_eks_pod_identity_association" "backup" {
  count           = var.backups ? 1 : 0
  cluster_name    = aws_eks_cluster.this.name
  namespace       = var.namespace
  service_account = "vertra-pg-backup"
  role_arn        = aws_iam_role.backup[0].arn
}

# --- logs: Loki's bucket, archived after log_search_days --------------------
# Loki (single tenant) keeps chunks under fake/ and its index under index/;
# only chunks move to Glacier Instant Retrieval, which Loki still reads.

resource "aws_s3_bucket" "logs" {
  count         = var.logs ? 1 : 0
  bucket        = "${var.name}-logs-${local.account}-${var.region}"
  force_destroy = var.delete_data
}

resource "aws_s3_bucket_public_access_block" "logs" {
  count                   = var.logs ? 1 : 0
  bucket                  = aws_s3_bucket.logs[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  count  = var.logs ? 1 : 0
  bucket = aws_s3_bucket.logs[0].id
  rule {
    id     = "archive"
    status = "Enabled"
    filter {
      prefix = "fake/"
    }
    transition {
      days          = var.log_search_days
      storage_class = "GLACIER_IR"
    }
  }
  rule {
    id     = "expire"
    status = "Enabled"
    filter {}
    expiration {
      days = var.log_keep_days + 1
    }
  }
}

resource "aws_iam_role" "logs" {
  count              = var.logs ? 1 : 0
  name               = "${var.name}-logs"
  assume_role_policy = data.aws_iam_policy_document.pod_trust.json
}

data "aws_iam_policy_document" "logs" {
  count = var.logs ? 1 : 0
  statement {
    actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.logs[0].arn}/*"]
  }
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.logs[0].arn]
  }
}

resource "aws_iam_role_policy" "logs" {
  count  = var.logs ? 1 : 0
  name   = "loki-bucket"
  role   = aws_iam_role.logs[0].id
  policy = data.aws_iam_policy_document.logs[0].json
}

resource "aws_eks_pod_identity_association" "logs" {
  count           = var.logs ? 1 : 0
  cluster_name    = aws_eks_cluster.this.name
  namespace       = var.namespace
  service_account = "vertra-loki"
  role_arn        = aws_iam_role.logs[0].arn
}

# --- the audit log's write-once copy --------------------------------------
# Object Lock: every object kept audit_keep_days (governance; compliance
# when audit_lock, which nobody can shorten, the root account included).
# The console may only put objects. Kept by destroy: it's the record.

resource "aws_s3_bucket" "audit" {
  count               = var.audit_export ? 1 : 0
  bucket              = "${var.name}-audit-${local.account}-${var.region}"
  object_lock_enabled = true
}

resource "aws_s3_bucket_public_access_block" "audit" {
  count                   = var.audit_export ? 1 : 0
  bucket                  = aws_s3_bucket.audit[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "audit" {
  count  = var.audit_export ? 1 : 0
  bucket = aws_s3_bucket.audit[0].id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "audit" {
  count  = var.audit_export ? 1 : 0
  bucket = aws_s3_bucket.audit[0].id
  rule {
    default_retention {
      mode = var.audit_lock ? "COMPLIANCE" : "GOVERNANCE"
      days = var.audit_keep_days
    }
  }
  depends_on = [aws_s3_bucket_versioning.audit]
}

data "aws_iam_policy_document" "console_audit" {
  count = var.audit_export ? 1 : 0
  statement {
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.audit[0].arn}/*"]
  }
}

resource "aws_iam_role_policy" "console_audit" {
  count  = var.audit_export ? 1 : 0
  name   = "write-audit-copy"
  role   = aws_iam_role.console.id
  policy = data.aws_iam_policy_document.console_audit[0].json
}

# --- the catalog's CI: pushes images from main, by GitHub's OIDC token -------

resource "aws_iam_openid_connect_provider" "github" {
  count          = var.catalog_repository != "" && var.github_oidc_provider_arn == "" ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

locals {
  catalog_subject = var.catalog_subject_prefix != "" ? var.catalog_subject_prefix : "repo:${var.catalog_repository}"
  github_provider = var.github_oidc_provider_arn != "" ? var.github_oidc_provider_arn : try(aws_iam_openid_connect_provider.github[0].arn, "")
}

data "aws_iam_policy_document" "publish_trust" {
  count = var.catalog_repository != "" ? 1 : 0
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.github_provider]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    # main only; a job in the catalog-publish Environment says so instead
    # of its branch. Pull requests (any fork's code) never match.
    # GitHub's subject names the repository, pinned by its id when it uses
    # immutable subjects (a re-registered name can't match).
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "${local.catalog_subject}:ref:refs/heads/main",
        "${local.catalog_subject}:environment:catalog-publish",
      ]
    }
  }
}

resource "aws_iam_role" "publish" {
  count              = var.catalog_repository != "" ? 1 : 0
  name               = "${var.name}-publish"
  assume_role_policy = data.aws_iam_policy_document.publish_trust[0].json
}

data "aws_iam_policy_document" "publish" {
  count = var.catalog_repository != "" ? 1 : 0
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    # Creating a product's repository on its first push, and pushing to it.
    actions = [
      "ecr:CreateRepository", "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload",
      "ecr:DescribeImages", "ecr:DescribeRepositories", "ecr:GetDownloadUrlForLayer", "ecr:InitiateLayerUpload",
      "ecr:PutImage", "ecr:UploadLayerPart",
    ]
    resources = ["arn:${local.partition}:ecr:${var.region}:${local.account}:repository/${var.task_registry}/*"]
  }
}

resource "aws_iam_role_policy" "publish" {
  count  = var.catalog_repository != "" ? 1 : 0
  name   = "push-task-registry"
  role   = aws_iam_role.publish[0].id
  policy = data.aws_iam_policy_document.publish[0].json
}

# --- the console's public address: a Route 53 zone you delegate, and an ACM
# certificate validated through it ------------------------------------------

locals {
  console_host = var.console_zone == "" ? "" : (var.console_hostname != "" ? var.console_hostname : "console.${var.console_zone}")
}

resource "aws_route53_zone" "console" {
  count   = var.console_zone != "" ? 1 : 0
  name    = var.console_zone
  comment = "Vertra ${var.name}: the console's public address"
  # Records vertra adds (the load balancer's alias) go first on destroy.
  force_destroy = true
}

resource "aws_acm_certificate" "console" {
  count             = var.console_zone != "" ? 1 : 0
  domain_name       = local.console_host
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

# ACM's validation record. ACM issues the certificate once the zone is
# delegated to Route 53 (vertra waits for it; OpenTofu doesn't).
resource "aws_route53_record" "console_validation" {
  for_each = var.console_zone != "" ? {
    for o in aws_acm_certificate.console[0].domain_validation_options : o.domain_name => o
  } : {}
  zone_id         = aws_route53_zone.console[0].zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 300
  allow_overwrite = true
}

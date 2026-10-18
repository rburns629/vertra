# aws: real AWS calls

Example products that call real AWS APIs, to copy from when your product has
to. Running them costs money. **Not yet proven against a real AWS account:**
they build, and their tests pass with boto3 mocked, but nothing here has
called AWS yet.

| Product | What `create` does |
|---|---|
| [`s3-bucket`](products/s3-bucket/) | Finds a bucket by name, or creates it with all public access blocked. A name another account owns fails with `BUCKET_NAME_TAKEN` |
| [`app-runner`](products/app-runner/) | Deploys an image (ECR or ECR Public) as an App Runner service and waits for it to run, or returns the existing service's URL. Private unless `public: true` |
| [`rds-postgres`](products/rds-postgres/) | Finds an RDS for PostgreSQL instance, or creates it (encrypted, not public) and waits until it's available, several minutes: set `timeoutSeconds` to 1500 or more, and delete it after |

Every action looks before it creates, so a retried step is harmless.
[dags/aws-hello-world-dag.yaml](dags/aws-hello-world-dag.yaml) chains the
first two.

## No passwords

`rds-postgres` never sees its database's password: RDS generates it and keeps
it in AWS Secrets Manager, and the step outputs that secret's ARN. Give an
app's own IAM role read access to that one secret rather than passing the
password along, since a step's outputs are readable by anyone who can see
the execution.

## Credentials

No keys: the actions use boto3's default credential chain, which EKS fills in
for the step's Kubernetes ServiceAccount. Give each product its own:
`serviceAccount: <name>` in its `product.yaml` (the console creates it in the
`aws` namespace, and the cluster lets only that product's image run as it).
Then either:

- **EKS Pod Identity** (simplest): install the Pod Identity agent add-on and
  create an association from that ServiceAccount to an IAM role. Nothing on
  the ServiceAccount or Pod changes.
- **IRSA**: an IAM OIDC provider for the cluster, and the annotation
  `eks.amazonaws.com/role-arn: <role>` on the ServiceAccount (an admin adds
  it; the console never changes a product's ServiceAccount).

Grant each product's role only what it calls:

| Product | IAM actions |
|---|---|
| `s3-bucket` | `s3:ListBucket` (for HeadBucket), `s3:CreateBucket`, `s3:PutBucketPublicAccessBlock` on `arn:aws:s3:::<prefix>*` |
| `app-runner` | `apprunner:ListServices`, `apprunner:DescribeService`, `apprunner:CreateService`, and `iam:PassRole` on the ECR access role if you use one |
| `rds-postgres` | `rds:DescribeDBInstances`, `rds:CreateDBInstance`, `rds:AddTagsToResource`, plus `secretsmanager:CreateSecret` and `kms:DescribeKey` for the managed password |

Optionally, set `AWS_TARGET_ROLE_ARN` on the step (the kernel's
`TASK_EXTRA_ENVIRONMENT`): the actions then use their own credentials only to
assume that role (`sts:AssumeRole`, which the target's trust policy must
allow) and act as it.

## Secrets

[secret-stores/secretstore.yaml](secret-stores/secretstore.yaml) syncs this
team's secrets from AWS Secrets Manager through External Secrets Operator,
signing in as `eso-aws` the same keyless way.

# aws: real AWS calls

Example products that call real AWS APIs, to copy from when your product has
to. Running them costs money. Proven on EKS Auto Mode (2026-10-19): each
product as its own ServiceAccount, bound by EKS Pod Identity to its own IAM
role with the permissions below, the DAG and the database run for real. The
SecretStore isn't proven yet.

| Product | What `create` does |
|---|---|
| [`s3-bucket`](products/s3-bucket/) | Finds a bucket by name, or creates it with all public access blocked. A name another account owns fails with `BUCKET_NAME_TAKEN` |
| [`app-runner`](products/app-runner/) | Deploys an image (ECR or ECR Public) as an App Runner service and waits for it to run, or returns the existing service's URL. Private unless `public: true` |
| [`rds-postgres`](products/rds-postgres/) | Finds an RDS for PostgreSQL instance, or creates it (encrypted, not public) and waits until it's available, several minutes: set `timeoutSeconds` to 1500 or more, and delete it after |

Every action looks before it creates, so a retried step is harmless.

## Deleting what they made

Each `create` tags what it makes `vertra-made=true` and reports it as
`resources`, with a `delete` action as its `cleanup`: Delete on the run page
(or **What runs made**) runs it. A delete refuses anything without the tag
(`NOT_MADE_BY_VERTRA`), so a bucket, service or database that was only
found, never made, is never deleted, and one already gone counts as deleted.
The console lets only the team it was made for, whoever ran it, and admins
delete it. Some deletes are careful on purpose:

- `s3-bucket` refuses a bucket that still holds objects
  (`BUCKET_NOT_EMPTY`) rather than emptying it.
- `rds-postgres` keeps a final snapshot, named in its output
  (`finalSnapshot`): delete the snapshot once nobody needs the data, since
  it's billed as storage.
- App Runner and RDS finish a delete on their own once it's accepted, so
  the step doesn't wait for it.

Proven on EKS Auto Mode (2026-10-25): each made by one team's member,
refused to another team's, the bucket refused while it held an object, and
all three deleted by an admin's cleanup run (the database's final snapshot
kept).
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
for the step's Kubernetes ServiceAccount. Each product runs as its own
(`serviceAccount` in its `product.yaml`: `aws-s3-bucket`, `aws-app-runner`,
`aws-rds-postgres`), which the console creates in the `aws` namespace, and
only that product's image may run as it. Bind each to its own role, either:

- **EKS Pod Identity** (simplest): install the Pod Identity agent add-on and
  create an association from that ServiceAccount to an IAM role. Nothing on
  the ServiceAccount or Pod changes.
- **IRSA**: an IAM OIDC provider for the cluster, and the annotation
  `eks.amazonaws.com/role-arn: <role>` on the ServiceAccount (an admin adds
  it; the console never changes a product's ServiceAccount).

Grant each product's role only what it calls:

| Product | IAM actions |
|---|---|
| `s3-bucket` | `s3:ListBucket` (for HeadBucket), `s3:CreateBucket`, `s3:PutBucketPublicAccessBlock`, `s3:PutBucketTagging`, `s3:GetBucketTagging`, and for delete `s3:DeleteBucket`, on `arn:aws:s3:::<prefix>*` |
| `app-runner` | `apprunner:ListServices`, `apprunner:DescribeService`, `apprunner:CreateService`, `apprunner:TagResource`, `apprunner:ListTagsForResource`, and for delete `apprunner:DeleteService`; `iam:PassRole` on the ECR access role if you use one |
| `rds-postgres` | `rds:DescribeDBInstances`, `rds:CreateDBInstance`, `rds:AddTagsToResource`, and for delete `rds:DeleteDBInstance` and `rds:CreateDBSnapshot` (its final snapshot), plus `secretsmanager:CreateSecret`, `secretsmanager:TagResource` and `kms:DescribeKey` for the managed password (and `secretsmanager:DeleteSecret`, which RDS uses to remove it) |

The first App Runner service or RDS instance in an account also makes that
service's service-linked role. Either create it once yourself (`aws iam
create-service-linked-role --aws-service-name apprunner.amazonaws.com`, and
`rds.amazonaws.com`) or let the product's role do it:
`iam:CreateServiceLinkedRole` on
`arn:aws:iam::<account>:role/aws-service-role/<service>/AWSServiceRoleFor<AppRunner|RDS>`,
with the condition `iam:AWSServiceName` equal to the service. RDS can refuse
the create right after making its role; the step fails as retryable and
the next attempt goes through.

An EKS Pod Identity role trusts `pods.eks.amazonaws.com` for
`sts:AssumeRole` and `sts:TagSession`; narrow it with the conditions
`aws:SourceAccount` (your account) and `aws:SourceArn` (the cluster's ARN).

Optionally, register a team secret `aws-target` whose key `role-arn` is a
role's ARN, and list it in each action that should act as it
(`secretRefs: [{name: aws-target, keys: [role-arn]}]`): those steps then use
their own credentials only to assume that role (`sts:AssumeRole`, which the
target's trust policy must allow) and act as it. Each team, and each
product, chooses its own.

## Secrets

[secret-stores/secretstore.yaml](secret-stores/secretstore.yaml) syncs this
team's secrets from AWS Secrets Manager through External Secrets Operator,
signing in as `eso-aws` the same keyless way.

# TODO

Open work, roughly by area. Before starting something here, check the code:
an item may be partly done. When you finish one, remove it; when you find a
new one, add it. Larger items are worth an issue first, to agree on the
design.

## Installing and operating

- [ ] **An installer CLI, `acyclixctl`**, in `cli/`, in Python like
  catalogctl. `init <env>` writes an install's settings (outside this
  repository); `check` is a read-only plan of what's missing; `cloud` sets up
  the cloud side with the cloud's own CLI (GCP first); `install` deploys both
  charts; `catalog` creates a catalog repository from `catalog-template/`
  with `gh` (variables, Environments, branch protection, the federation
  provider, both console tokens stored without being shown) and the
  adopter's first team, with starter products for the languages they pick
  (copied from `samples/local`), optionally `--samples gcp|aws|azure`; then
  publishes and runs a starter as a smoke test. Idempotent, plan before
  apply, secrets generated in place. Open: Terraform now or later.
  `make quickstart` becomes a wrapper over it.
- [ ] **Prove the AWS and Azure samples** (`catalog-template/samples/aws`,
  `azure`): they build and their tests pass with the SDKs mocked, but they
  haven't called a real account. On EKS and AKS: bind each product's
  ServiceAccount, run each DAG, check the resources and the password-free
  databases, delete them; and their SecretStores through ESO.
- [ ] **Let a deployment label step Pods** (a kernel setting like
  `task_node_selector`, never overriding the kernel's own labels). AKS
  Workload Identity only gives credentials to Pods labelled
  `azure.workload.identity/use: "true"`, so the Azure sample can't sign in
  until this exists. Check the identity policy still allows the volume the
  webhook adds.
- [ ] **Prove backups on each cloud.** `backup.destination` takes `gcs`,
  `s3`, `azure` or `pvc`; `pvc` and S3-compatible storage are proven on
  kind, GCS, S3 on AWS (Pod Identity or IRSA) and Azure Blob aren't. On each:
  run one, download it, restore it into a throwaway database. Also: the GCS
  backup image (`google/cloud-sdk:*-slim`) is amd64 only, so Arm nodes need
  another image.
- [ ] **Example values for EKS and AKS** next to `helm/values/gke/`, and a
  per-cloud guide to binding identities (console scanning and registry
  checks, ESO, products).
- [ ] **A lock file for the kernel.** Its `pyproject.toml` has lower bounds
  only (and `kubernetes<37`), so each image build installs that day's
  newest; lock it for the image and CI. (Dependabot proposes updates; the
  console has `package-lock.json`.)
- [ ] **Upgrade the kernel to `kubernetes` 37.** It ships type information:
  fix the typing gaps mypy then reports, drop the `kubernetes.*` mypy
  override, run the Kubernetes tests on kind, lift the cap.
- [ ] **Per-team ResourceQuota and LimitRange**, created with the team's
  namespace: a hard ceiling the cluster enforces, and a maximum step size.
  (Step sizes, Spot placement and running-step caps exist already.)
- [ ] **Let a product choose its own capacity** (Spot or on-demand) in its
  `product.yaml`; placement is deployment-wide today.
- [ ] **Alerts** on `IMAGE_NOT_ALLOWED`, `IMAGE_NOT_FOUND`,
  `IMAGE_NOT_SIGNED`, `IMAGE_SCAN_FAILED`, dispatch rejections, purges,
  policy sync failures, and changes to the image policy.
- [ ] **Prove the scheduler at scale on a cloud cluster:** the watches
  surviving an API server restart and the 5-minute relist, API rate limits
  at `scheduler_executor_concurrency` 16, and a reclaimed Spot step failing
  as retryable and being retried, on each cloud.
- [ ] **Batch the scheduler's per-task database work** (attempts, outputs
  and dependents for a whole pass in a few queries): about 6 ms per task
  started and 1.6 ms per task polled today, mostly round trips.

## Security

- [ ] **TLS in front of the console** in the charts: an optional Ingress or
  Gateway with certificates. Today the operator provides it.
- [ ] **SSO/OIDC sign-in**, with groups mapped to teams. Email and password
  are the only sign-in today.
- [ ] **Force a password change on first sign-in** for admin-created
  accounts.
- [ ] **Limit what steps can reach inside the cluster:** a default-deny
  ingress policy in each team namespace, created with it. Steps can't reach
  the platform's databases or kernel-api, but can reach other teams' Pods.
- [ ] **Make the charts require non-root** on the kernel and console Pods
  (`runAsNonRoot`, no privilege escalation, dropped capabilities, read-only
  root filesystem). The images run as non-root; nothing stops a regression.
- [ ] **Bind the console's Secret rights per team namespace** as teams are
  created, instead of cluster-wide fenced by an admission policy.
- [ ] **Ship audit log lines to a write-once store**: the audit log lives in
  the console's database, which its writers could change.
- [ ] **Decide who may read a multi-team execution.** Cancel and retry need
  every team; reads need one, so a member of team A sees team B's outputs
  and logs in a shared DAG. Filter by team, or require every team.
- [ ] **Have the GKE deploy use released images** (`make gke-deploy` still
  builds from the working copy with Cloud Build); the release workflow
  builds, scans and signs them in CI.
- [ ] **One cloud identity per product in the gcp sample:** its products
  declare no `serviceAccount`, so they share the namespace's `default`.
- [ ] **Catalog: keep pull-request workflows away from secrets and cloud
  identities**: every workflow that holds one in a `main`-only Environment.

## Console

- [ ] **Pages for the audit log and image scans** (`/api/audit`,
  `/api/image-scans`), which have an API only.
- [ ] **Usable on a phone:** the sidebar is a permanent drawer
  (`layout/AppLayout.tsx`); collapse it into a menu below `md`.
- [ ] **Connect a team's `owner` to its console team**: membership is
  managed on the team's page, separately from the catalog's CODEOWNERS.
- [ ] **Set the catalog repository on the Admin page** instead of the
  `secretSources.catalogRepo` Helm setting, for the secret-setup guides.
- [ ] **Show a product's latest tag** where people build DAGs.
- [ ] **Stop accepting `externalReference` and `idempotencyKey`** (now
  `name` and `requestId`) once nothing sends them:
  `kernel/app/contracts/execution.py`, `withCurrentFieldNames` in
  `console/src/routes/executions.ts`, the frontend's `dagCheck.ts` and
  `ExecutionDetailPage.tsx`.

## Products and catalog

- [ ] **Submit orders from outside the cluster** (a storefront, an event
  bus): a public HTTPS front door for the console's `/api`, keyless sign-in
  for services (OIDC tokens from trusted issuers, mapped to a bot), orders
  rather than raw DAGs, and a decision on who an order is for. kernel-api
  stays private.
- [ ] **Order builder (exploratory):** turn a cart of products into a DAG
  from their schemas. The console stores products' descriptions and wiring
  types already; next, the generator (`POST /api/orders/preview`), then a
  page.
- [ ] **Base images the platform maintains**: copy approved base images into
  a registry on a schedule, scanned and pinned, for products to build from.
- [ ] **Catalog: send `resources` when registering products** (the console
  accepts and stores them; `product.yaml` and catalogctl don't send them).
- [ ] **One provider identity per team** for SecretStores: two teams'
  stores must not sign in as the same cloud identity.

## Testing and housekeeping

- [ ] **Run the older kernel tests on the database's clock**, as the newer
  ones do: `now` from this machine against `available_at` from Postgres can
  disagree in a Dockerized Postgres.
- [ ] **Push the Kubernetes tests' fixture images to the local registry**
  instead of `kind load` (`_load_image_into_kind` in
  `kernel/tests/conftest.py`): on Kubernetes 1.37, a side-loaded image can
  stop being usable after it's pulled under a second name.
- [ ] **An end-to-end secret test** with a product registered by catalog CI.
- [ ] **actionlint in the catalog template's own CI.**
- [ ] **Move `docker` to the kernel's dev dependencies** (tests only).
- [ ] **`make up` mistakes any console port-forward for its own:** include
  the port in its `pgrep`/`pkill` patterns.
- [ ] **Switch to Sigstore's newer signature format** once policy-controller
  reads it (catalog CI signs with `--new-bundle-format=false`).

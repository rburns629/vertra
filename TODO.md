# TODO

Open work, roughly by area. Before starting something here, check the code:
an item may be partly done. When you finish one, remove it; when you find a
new one, add it. Larger items are worth an issue first, to agree on the
design.

## Installing and operating

- [ ] **An installer CLI, `acyclixctl`**, in Go (one static binary per OS,
  released signed with the platform). Step 1 of `cli/DESIGN.md`'s build
  order is in `cli/`: kind (local) and existing clusters, `init`, `check`,
  `apply`, `status`, `sleep`, `wake`, `destroy`, `config`, `tools`. Step 2,
  the chart features, is in the charts: size presets (`sizes/`), the
  sleeper, the idle scanner, headroom, PodDisruptionBudgets and the `auto`
  autoscalers. Step 3, gcp, is in: the OpenTofu module (Autopilot and
  Standard), live list prices, apply and destroy; still to do there:
  Cloud SQL, signing and catalog federation (with the catalog step),
  account prices. Step 4, the catalog on GitHub, is proven (repository,
  federation, CI publishing, a starter run on Spot). Step 5, aws, is proven
  on EKS Auto Mode in us-east-2 (2026-10-18): install, ECR pinning and scans
  through Pod Identity, S3 backups, sleep (nodes gone in about a minute) and
  wake, destroy. Standard mode is proven too (node groups, the EBS and Pod
  Identity add-ons, the Cluster Autoscaler: a step scaled the Spot steps
  group 0 → 1 and back). Since proven (2026-10-19): standard mode's
  platform group settles at one node once the scanner idles; the public
  console on Auto Mode (Route 53 zone, ACM certificate, Auto Mode's load
  balancer, the alias record); the catalog on AWS (a private test
  repository publishing to ECR through GitHub's OIDC role, keyed to
  GitHub's immutable subject, and a starter run); the AWS sample (each
  product as its own ServiceAccount and IAM role by Pod Identity: the
  bucket → App Runner DAG and an RDS instance, then deleted). That run found
  two bugs in images pinned as `repo:tag@sha256:…`, now fixed: the identity
  policy kept the tag on the repository (so a registered product with its
  own ServiceAccount was refused), and the console's registry check asked
  for a repository named with its tag (so retries said the image was gone).
  Just Ship It was left empty afterwards (2026-10-19). Still to do: decide
  about the two test catalog repositories; the AWS sample's SecretStore. The sizes' figures are first estimates, to be
  measured.
  Decided 2026-10-18:
  - **Targets:** `kind (local)`, `gcp`, `aws`, `azure`, `existing`. Cluster
    mode when the CLI creates one: `auto` (GKE Autopilot, EKS Auto Mode, AKS
    Automatic), `standard` (a platform node pool, and a steps pool that
    scales from 0), or `existing`.
  - **Cloud side in OpenTofu** (open source; Terraform-compatible): one
    module per cloud for the cluster, network, registry, identities, signing
    key and backup bucket. `tofu plan` feeds the approval screen; changes and
    `destroy` come with it. Runs locally under the user's own cloud login;
    state in `deploy/<env>/` (optional remote backend). kind and existing
    don't use it. Acyclix itself is installed with the Helm charts.
  - **Config:** `./deploy/<env>/acyclix.yaml` (gitignored in this repo; safe
    to commit elsewhere: names only, secrets generated in the cluster), plus
    a Helm values passthrough for anything the CLI doesn't ask about.
  - **Size:** `minimal` (the absolute minimum), `resilient` (two copies,
    survives upgrades), `scaled` (three or more), `auto` (one to three on
    load): values files shipped with the charts (replicas, step caps,
    default step size, Spot), so Helm users get them too.
  - **Database**, for any size: in-cluster Postgres with daily backups to a
    bucket, or managed (Cloud SQL, RDS, Azure Flexible Server, high
    availability optional).
  - **macOS and Linux only.** `destroy` asks about each kind of data unless
    `--all`.
  - **Scale down:** a yes/no prompt, changeable later. Yes: the platform
    sleeps after an idle period and wakes with `acyclixctl wake`. No: asks
    the always-on copies of the console and API (default from the size) and
    the warm headroom for steps. `sleep` and `wake` always work. The image
    scanner idles to zero regardless.
  - **Requirements first:** per target (kubectl, helm, tofu, docker and kind;
    gcloud, aws and eksctl, az and kubelogin; git and gh for `catalog`).
    Single binaries are downloaded on consent, checksum-verified, into
    `~/.acyclix/bin`; installers (docker, gcloud, aws, az) get the exact
    install command instead.
  - **Approval screen** before anything changes: the whole configuration,
    what will be created and installed, and an estimated monthly cost from
    each cloud's live pricing API (always, awake, asleep, per step-hour, a
    likely total), with its limits stated. `--yes`, `--plan-only`; the
    approved plan is kept in `deploy/<env>/`.
  - **Then** `catalog` creates the catalog repository from
    `catalog-template/` with `gh` and the first team with starters for the
    languages picked, and runs one as a smoke test. `make quickstart`
    becomes a wrapper over it.
  - **Repository visibility:** public, private, or internal (offered only
    for an organization under GitHub Enterprise). `check` reads the
    owner's plan and policies (repository creation, allowed actions, OIDC)
    and the approval screen says which settings will be skipped (branch
    rules, secret scanning and Environment branch limits need a paid plan
    on a private repository).
  - **SSO and scopes:** a 403 from an organization's SAML enforcement is
    detected from GitHub's `X-GitHub-SSO` header; the CLI shows (and opens)
    the authorization URL, waits, and retries. Missing token scopes (`repo`,
    `workflow`) go through `gh auth refresh -s`.
  - **Git hosts behind one layer** (create a repository, variables and
    secrets, environments, protected branches, code owners, OIDC, SSO), so
    **GitLab** (gitlab.com and self-managed, public, internal and private,
    with `glab`) follows GitHub as a second implementation; the catalog
    template then ships GitLab CI wrappers over catalogctl alongside its
    GitHub workflows.

- [x] **Guided access in `acyclixctl init`** (done 2026-10-18:
  `internal/access`, `init_access.go`, `docs/clouds/`; proven read-only
  against Just Ship It, acyclix-dev and GitHub). Agreed 2026-10-18. Setting up AWS showed most of the effort goes on
  finding out which account you're in and what it allows. Before planning,
  per cloud: detect, show, then ask.
  - **Sign-in:** explain the options briefly, recommend one, and run the
    interactive command (`aws login` for one person, Identity Center for a
    team; `gcloud auth login` and `application-default login`; `gh auth
    login` with its scopes). Refuse root on AWS. With several sign-ins
    (gcloud accounts, AWS profiles, gh accounts), list them and save the
    choice.
  - **Where things go:** GCP projects you can use (which already hold
    resources; recommend a new one); the AWS account's name, ID and
    organization role (standalone, member, management); GitHub owners you
    can create repositories under.
  - **What it allows:** the regions that answer (pick from those); an
    organization's guardrails (AWS SCPs: tell a denial from a missing
    permission and name the policy; GCP org policies such as allowed
    locations or external IPs); billing linked, budgets (offer to create
    one), the free-plan state, AWS's spend-limit policies; gcloud and
    OpenTofu (ADC) signed in as different accounts.
  - Probes are tested functions that judge the whole response (a shell
    one-liner misread AWS's errors as success once).
  - An **Access** block on the approval screen ("rburns (IAM user) in
    Just Ship It (…0147), member of an organization; region us-east-2,
    the only one its organization allows; budget $20/month"), recorded in
    the config and re-checked on later runs.
  - Guides for what only a browser does (`docs/clouds/aws.md`, `gcp.md`,
    `github.md`: account, root MFA, Identity Center, budgets), linked from
    the CLI when it recognises a case: a Builder ID that isn't an account,
    an Identity Center account instance, an organization a sign-up made.
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

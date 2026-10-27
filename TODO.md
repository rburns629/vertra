# TODO

Open work, roughly by area. Before starting something here, check the code:
an item may be partly done. When you finish one, remove it; when you find a
new one, add it. Larger items are worth an issue first, to agree on the
design.

## Installing and operating

- [ ] **Observe: security checks, logs and metrics for everyone**
  (mocked up 2026-10-21, boards 17–19). One console section with tabs:
  - Security checks (done 2026-10-22: `ObserveService.GetSecurity`, the
    Observe page's first tab): what the cluster enforces (and what it
    doesn't yet), every allowed image with its scan, and every refusal
    (admission codes via kernel-api's `ListRefusals`, and a catalog release
    that couldn't be applied). Each image's SBOM (done 2026-10-27): catalog
    CI attaches it, from its scan, as a CycloneDX attestation signed as the
    image is, and Observe offers it for download (an image the caller may
    see); the release check names the signer. Not yet seen end to end:
    attesting needs cosign, so the next cloud catalog run proves it.
  - Logs (done 2026-10-22, proven on kind: `ObserveService.SearchLogs`,
    the Observe page's Logs tab, the console chart's `logs`): Grafana Alloy
    reads steps' and the platform's Pods through the Kubernetes API,
    redacts credentials with the kernel's patterns (a kernel test keeps
    them equal) and sends them to one Loki, labelled with team, level and
    source, and the run, task, attempt and image as structured metadata.
    The console adds the caller's visibility to every query. Searchable
    `searchDays` (30); on gcp and aws, `vertra` makes the bucket, whose
    lifecycle moves chunks to Archive / Glacier Instant Retrieval then, and
    deletes them after `keepDays` (365). The scheduler keeps a finished
    step's Job 30 s (`scheduler.releaseFinishedAfterSeconds`) so even a
    short step's output is collected. Proven on GKE (2026-10-22): the
    bucket and its rules, Loki writing through Workload Identity, and
    reading back chunks moved to Archive after a restart wiped its local
    copy (which also showed a restart lost the not-yet-uploaded logs: Loki
    now always has a volume). And on EKS: the bucket and its rules, Loki
    writing through Pod Identity, reading back chunks moved to Glacier
    Instant Retrieval with its volume deleted, and a restart keeping its
    volume losing nothing. Left: API products' backends'
    logs (in team namespaces, not steps) for their teams; Secret values
    (not just credential shapes) masked.
  - Metrics (done 2026-10-22): the Observe page's Metrics tab for
    everyone, from kernel-api's own tables (`GetStats`: steps started and
    their p95 wait by hour, failures by code, each product's step times),
    so it needs no metrics system. For admins: the console's `console_*`
    metrics on a port of its own, the scheduler's queue gauges
    (`kernel_tasks`, `kernel_oldest_ready_task_age_seconds`), PodMonitors,
    PrometheusRules and a Grafana dashboard in the charts (`monitoring`, off
    by default), with every metrics port open only to
    `networkPolicy.metricsFrom`. Proven on kind with kube-prometheus-stack
    92.1.0 (2026-10-22): all four components scraped through the
    PodMonitors, all seven alerts loaded, the dashboard in Grafana with its
    queries answering; `vertra init` finds the operator and its selector
    labels (`--monitoring`). Left: GKE's Managed Service for Prometheus,
    which reads `PodMonitoring` and `Rules`
    (`monitoring.googleapis.com`), not the operator's resources: ship those
    too, behind their own value.
  - The audit log (done 2026-10-22: `ObserveService.ListAudit`, the
    Observe page's Audit log tab): an admin sees every entry; anyone else
    their own, and what was done to their teams or to runs in them, by
    anyone. An entry records the run a call started, so a submission
    reaches every team in it. Filters: a team, only mine, only refused.
  Who sees a step's logs, by level (decided 2026-10-21; done 2026-10-22 for
  the step output the kernel captures: `console/src/logLevels.ts`, every
  sample logging JSON INFO lines): INFO lines to
  everyone who can see the run, with Secrets masked; DEBUG, WARN and ERROR
  to the product's team (and admins). Steps log JSON lines with a `level`
  (plain lines count as DEBUG, so nothing is shown to consumers by
  accident); the level becomes a Loki label, and the console filters on it
  by the caller's role. The product docs say: write INFO for consumers.

- [ ] **An installer CLI, `vertra`**, in Go (one static binary per OS,
  released signed with the platform). Step 1 of `cli/DESIGN.md`'s build
  order is in `cli/`: kind (local) and existing clusters, `init`, `check`,
  `apply`, `status`, `sleep`, `wake`, `destroy`, `config`, `tools`. Step 2,
  the chart features, is in the charts: size presets (`sizes/`), the
  sleeper, the idle scanner, headroom, PodDisruptionBudgets and the `auto`
  autoscalers. Step 3, gcp, is in: the OpenTofu module (Autopilot and
  Standard), live list prices, apply and destroy; signing (2026-10-26) and
  catalog federation are in; still to do there: Cloud SQL, account prices. Step 4, the catalog on GitHub, is proven (repository,
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
  Just Ship It was left empty afterwards (2026-10-19). The test catalog
  repositories (rburns629/vertra-catalog-test, -aws-test) are kept for
  now. The AWS sample's SecretStore is proven (2026-10-27). Still to do: a
  managed database (Cloud SQL, RDS), and measuring the sizes' figures, which
  are first estimates (both billed runs).
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
    don't use it. Vertra itself is installed with the Helm charts.
  - **Config:** `./deploy/<env>/vertra.yaml` (gitignored in this repo; safe
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
    sleeps after an idle period and wakes with `vertra wake`. No: asks
    the always-on copies of the console and API (default from the size) and
    the warm headroom for steps. `sleep` and `wake` always work. The image
    scanner idles to zero regardless.
  - **Requirements first:** per target (kubectl, helm, tofu, docker and kind;
    gcloud, aws and eksctl, az and kubelogin; git and gh for `catalog`).
    Single binaries are downloaded on consent, checksum-verified, into
    `~/.vertra/bin`; installers (docker, gcloud, aws, az) get the exact
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
    template then ships GitLab CI wrappers over vertra catalog alongside its
    GitHub workflows.

- [x] **Guided access in `vertra init`** (done 2026-10-18:
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
- [x] **Prove the AWS sample's SecretStore** (done 2026-10-27, EKS): ESO
  2.10 signed in as team platform's `eso-aws` by IRSA (the cluster's OIDC
  issuer registered in IAM by hand, a role trusting only that
  ServiceAccount and reading one secret), synced the secret, and a step
  mounted it. Pod Identity doesn't work for a store (it isn't the Pod's
  identity ESO uses); the sample said it did. The Azure samples are after
  the MVP (decided 2026-10-25).
- [ ] **`vertra` sets up SecretStores on aws** (done 2026-10-27, not yet
  proven on a cloud): the aws module registers the cluster's OIDC issuer
  in IAM, the console gets it (the Team page's AWS guide, now marked
  tested), and `externalSecrets: true` has `vertra apply` install External
  Secrets Operator 2.10.0, pinned. Prove with the next EKS run.
- [ ] **A first step on a new GKE Autopilot install can time out**: seen on
  both GKE proofs (2026-10-26, 2026-10-27). Fixed (2026-10-27): a step's
  timeout counts from its container's start, and waiting to start has its
  own limit (`scheduler.taskStartTimeoutSeconds`, 10 minutes), past which it
  fails as `TASK_NOT_STARTED` (retryable) instead of a misleading
  `TASK_TIMEOUT`. Left: why a minimal install had three nodes (one with the
  platform, one with only a sleeper Job, one empty), whose boot disks
  (about 146 GB each) filled a new project's 500 GB SSD quota so no node
  could be added for a step; look on a live cluster.
- [x] **Let a deployment label step Pods** (I2, done 2026-10-21):
  `scheduler.taskPodLabels` (`TASK_POD_LABELS`), on the step Pod only; the
  scheduler refuses to start with `app` or a `vertra.dev/*` key. Proven on
  kind (a step's Pod carried them). The identity policy checks Jobs, not
  Pods, so the volume AKS's webhook adds to the Pod isn't checked by it.
  Left: the Azure sample signing in, when Azure is proven.
- [x] **Prove backups on each cloud** (done 2026-10-26 for GCS and S3):
  on GKE Autopilot (Workload Identity) and EKS Auto Mode (Pod Identity),
  installs made by `vertra` with `database.backups` on, a backup run by hand
  copied both databases' dumps to the bucket `vertra` made; each downloaded
  dump restored cleanly into a throwaway database with every table. Azure
  Blob is after the MVP. The GCS backup image is Google's
  `google-cloud-cli:*-slim` from gcr.io (amd64 and arm64; Docker Hub's
  `google/cloud-sdk` is amd64 only), done 2026-10-26.
- [x] **Example values for EKS** (done 2026-10-27), `helm/values/eks/`, as
  `vertra apply` writes them, and a per-cloud guide to binding identities
  (docs/operations.md, Cloud identities). AKS is after the MVP, with Azure.
- [x] **Per-team ResourceQuota and LimitRange** (done 2026-10-26): written
  with each team namespace and on every policy resync (`teamQuota.ts`), from
  the console chart's `teamNamespaces.quota` or a team's own, which an admin
  sets on its Settings tab (`TeamService/SetTeamQuota`, console migration
  0030): CPU, memory and Pods together, and memory per step (CPU only in
  total, so a step may use spare CPU). The write fence accepts only those
  two names. A step that can never fit fails at once
  (`RESOURCES_NOT_ALLOWED`, read by the kernel from its Job's FailedCreate
  events); one waiting for room waits. Proven on kind: two runs with one Pod
  allowed both ran, one after the other; a 4Gi step against a 2Gi maximum
  failed in seconds; the fence refused another name and another namespace.
- [x] **Let a product choose its own capacity** (done 2026-10-27, proven
  on kind): product.yaml's `capacity` (spot or onDemand) reaches the kernel
  with each step, which runs it on the placement the install sets for that
  kind (`scheduler.capacityPlacements`) instead of its default; `vertra`
  sets them on GKE Autopilot (the gke-spot selector, or none) and EKS
  (Karpenter's capacity-type, the steps pool taking both when it uses
  Spot). GKE standard mode has one steps pool, so no choice. Not yet seen
  on a cloud.
- [x] **The console's liveness probe killed it once while it started** on a
  minimal GKE install (2026-10-25, exit 137 a minute after start): it has a
  startup probe now, five minutes long (done 2026-10-25).
- [x] **`vertra check` could warn about GCE's SSD quota** (done 2026-10-26:
  `vertra check` and `apply` warn when the region has room for fewer than
  four Autopilot nodes' disks; found
  2026-10-25): a new project's 500 GB `SSD_TOTAL_GB` in a region holds about
  three GKE Autopilot nodes' boot disks (about 140 GB each, counted but not
  listed), so a step's Spot node can't be added ("GCE quota exceeded") while
  three are up, and the step waits until one is scaled down.
- [x] **A resource whose cleanup run just failed shows "being deleted"**
  (done 2026-10-26: a delete asked for again checks the run with the kernel)
  for up to 30 seconds (until `resourceRecorder.ts` next looks at the run),
  so asking again at once is refused (`DELETE_IN_PROGRESS`). Read the run's
  own state when it's finished but not yet recorded.
- [x] **Alerts** (done 2026-10-27, proven on kind for purges and image
  source changes): a step the cluster refused (`step_refused`: the kernel's
  admission codes) tells admins and whoever ran it, and posts to its team's
  webhook if it wants that kind; a team purged, the allowed image sources
  changed, a policy sync failing ten minutes, a run's image gone from the
  registry (`platform_alert`) tell admins. Both are emailed by default.
  The refusal alert was seen for real on EKS (2026-10-27, the reader install).
  Admins' alerts in chat (done 2026-10-27, proven on kind): an admin
  chooses a team (Admin page) whose webhook may also get `platform_alert`,
  `catalog_failing` and every team's `step_refused`; a policy-sync alert is
  keyed by policy and day, so two consoles say it once.
- [ ] **Prove the scheduler at scale on a cloud cluster:** the watches
  surviving an API server restart and the 5-minute relist, API rate limits
  at `scheduler_executor_concurrency` 16, and a reclaimed Spot step failing
  as retryable and being retried, on each cloud.
- [x] **Batch the scheduler's per-task database work** (done 2026-10-27,
  proven on kind): a pass reads every running task's attempt, execution
  state and log capture at once, renews their leases in one statement, and
  writes its events in one (in order); a start updates its attempt in one
  statement and marks an execution running once. Against the test database:
  polling 30 running steps, 94 round trips (9.9 ms) → 7 (1.7 ms); starting
  30, 278 (9.3 each, 44 ms) → 159 (5.3 each, 19 ms). Tests guard both.

## Agreed direction

From the assessment of 2026-10-19 ([docs/assessment.md](docs/assessment.md);
IDs refer to its findings). P0 first; none of it needs a new service.
This comes before Azure and GitLab, which are deferred (the Azure items
elsewhere in this file wait until then; Azure is after the MVP, decided
2026-10-25).

Order of work (decided 2026-10-20): **0** R1, R2 and R4 in the Python
scheduler (done 2026-10-20). **1** The contracts: the console's API on Connect (protos,
generated clients for the frontend and `vertra`), the
catalog format version 2, the catalog tool ported to Go in the CLI's module,
the compatibility check. **Kernel track:** the kernel in Go, Python
removed (done 2026-10-20). **2** Pull-based registration. **3** Roles,
consumers, templates, exports, targets. **4** Schema checks and forms.
**5** Default-deny networking, projected tokens, identity references from
secrets. **6** Kernel features, in Go: retry policy, concurrency keys,
approvals, attempts, `WatchRun`. **7** The console pages. **8** API products
through the gateway (decision 20), bots with keyless sign-in. **9** Preview, what a run
created, examples. **10** Production: SSO, TLS, audit store, alerts, scale,
backups, docs; then CLI releases and a public repository.
Related items elsewhere in this file: default-deny between team
namespaces and who may read a multi-team execution (Security), Pod labels
for AKS Workload Identity (Installing), run forms from schemas (Console).

- [x] **Phase 1: the contracts** (decided 2026-10-20; done the same
  day). Done: `proto/` with all ten services, `make proto` (buf
  1.74.0; protoc-gen-es 2.16.0 from the console's npm, protoc-gen-go and
  protoc-gen-connect-go as tools in `cli/go.mod`), the generated code for
  the console, frontend and CLI, and the `proto` CI job; the API's logic
  in `console/src/core/`, every service served over Connect from
  `console/src/rpc/` with authentication, audit, rate limits and error
  masking as interceptors, and `WatchExecution` streaming; the frontend's
  `api.ts` on the generated clients (proven on kind: submit, watch,
  events, logs, retry, rerun); the execution page on `WatchExecution`
  instead of polling (proven in a browser on kind; the stream resends
  every 15s so idle timeouts don't cut it, and GKE's default 30s backend
  timeout just means a reconnect); `vertra`'s `internal/consoleapi`
  on the generated Go client (proven on kind: sign-in, `EnsureTeam`,
  token rotation, submit and watch); the catalog tool ported to Go
  (`cli/cmd/vertra`; the same verdicts as the Python tool on 37
  broken and unbroken catalogs, and `make catalog-publish` proven on kind:
  teams applied, five products built, tested, scanned, pushed and
  registered over Connect, then run); the REST routes, `openapi.ts` and
  their packages removed, every REST test ported to Connect (finding and
  fixing: an unset optional field refused, wiring type names unchecked,
  refusals' extra fields dropped, now `Failure.detail`), and the API
  reference built from the protos by `make proto`; catalog format v2
  (`apiVersion: vertra.dev/v2` and a `kind` in every file; actions'
  `secretRefs` bindings, `shareWith` and `deprecated`, recorded by the
  console; `kind: Template` with parameters and steps naming actions,
  checked by vertra catalog; `vertra catalog migrate`, which converted the
  template); the compatibility check (C2: `vertra catalog check --changed`
  compares each product with its last release on the base and refuses a
  breaking change unless its `version` is raised, and a removal unless it
  was deprecated first). Phase 1 is done. Load balancers need HTTP/2 end
  to end only for gRPC callers (the charts' Ingress and the CLI's AWS and
  GCP settings); the browser and both CLIs use Connect over HTTP/1.1.
- [x] **Renamed Acyclix to Vertra** (done 2026-10-20). Everything that
  carries the name: the CLI (`acyclixctl` is now `vertra`), Go modules
  (`github.com/rburns629/vertra/...`), protos and their routes
  (`/api/vertra.console.v1.*`), the catalog format (`vertra.dev/v2`, its
  settings file `vertra.yaml`), labels (`vertra/team`), the platform
  namespace (`vertra-system`), environment variables (`VERTRA_*`) and the
  kind cluster (`vertra-local`). `vertra catalog migrate` converts a catalog
  from before; `vertra catalog create` removes a repository's `ACYCLIX_*`
  variables. Not renamed: the GCP project `acyclix-dev`, a real resource.
  An install from before keeps its old labels and namespace: reinstall it
  (none outside kind existed).
- [x] **Kernel track: kernel-scheduler in Go** (done 2026-10-20).
  `kernel/cmd/kernel-scheduler` and `kernel/internal/` (pgx, client-go
  informers), against the same schema and settings, with the same Job
  names, handles, logs and metrics, so it adopts the Python scheduler's
  tasks in flight. Every Python scheduler and executor test ported (the
  scheduler's scenarios against the real test database; the executor's
  stubbed tests on client-go's fake; the kind tests as `TestKind*`, in
  CI's kubernetes job), then the Python scheduler, executor, their tests
  and settings removed. Proven on kind: two steps in flight under the
  Python scheduler adopted and finished on attempt 1; a Go-to-Go restart
  mid-step; chain, retries with backoff then a manual retry, cancel,
  timeout, a fan-out and join; Jobs released, metrics, liveness. Found
  and fixed on the way: the watch never marked Pods synced (every status
  was read from the API until the first Pod event), a 403 with no message
  gave an empty refusal, and a misspelt toleration was silently dropped
  (Python refused it). The scheduler's ClusterRole narrowed to the calls
  it makes (no `jobs/status`, no `get` on Pods or ConfigMaps).
- [x] **Kernel track: the rest of the kernel in Go, Python removed** (done
  2026-10-20). One binary, `kernel` (`api`, `scheduler`, `migrate`,
  `sleep`), on a distroless image (about 50 MB). kernel-api is
  `KernelService` (`proto/vertra/kernel/v1`) over Connect, with the same
  TokenReview caller check; the console calls it through the generated
  client (`console/src/kernel/client.ts`), which now refuses field names it
  didn't check, as kernel-api's pydantic models did. The schema is
  `kernel/internal/migrate/sql/`, recorded in `schema_migrations`, and an
  install Alembic migrated is taken over (proven identical by `pg_dump`).
  The sleeper scales through `GetScale`/`UpdateScale` (its Role: `update`
  on `deployments/scale`, not `patch`). Every Python test ported. Proven
  on kind, as an upgrade of a running install: the takeover, a run
  submitted through the Python kernel-api finished and read through the Go
  one, the console's whole execution path, a rerun of a DAG stored before,
  retries, cancel, timeout, fan-out, the caller check (no token 401, a
  step's token 403, the wrong audience 401), and a real scheduled sleep and
  wake under the sleeper's own Role. Then on GKE Autopilot in acyclix-dev,
  a fresh install by `vertra` (the scheduler waited for the migration
  hook): a chain passing an output, retries, cancel, a timeout, a fan-out
  on Spot, the caller check; then `vertra destroy --all`, leaving
  nothing but the project's own defaults. That run found client-go
  printing Autopilot's warning on every Job unstructured; each distinct
  API warning is now logged once, as JSON.
- [x] **Release `vertra` binaries, and pin one in the catalog
  template's `./vertra`** (done 2026-10-21: v0.2.2, pinned in
  `catalog-template/vertra`; the package is public with the repository).
  `release.yml`'s `cli` job builds
  linux/darwin × amd64/arm64, pushes each to `ghcr.io/<owner>/<repo>/cli`
  as one blob (its digest the binary's SHA-256), signs it and attaches
  it with `vertra-checksums.txt` to the release; `./vertra` downloads
  its platform's blob anonymously by SHA-256 (tested against a local
  registry, then from GHCR). Each later release: `.github/scripts/pin-vertra.sh
  <version>` for `catalog-template/vertra` and each catalog's wrapper. A
  signing step that fails with Rekor's 409 "equivalent entry" is a retried
  upload that had succeeded: rerun the job.
- [ ] **`buf breaking` in CI at the first release**, against the released
  protos: until then contracts change freely (decided 2026-10-19).
- [x] **P0: pull-based catalog registration (M1, S1)** (done 2026-10-20).
  Catalog CI publishes, then `./vertra catalog release` pushes the whole
  catalog (teams, their SecretStore files, every product action pinned by
  digest; `proto/vertra/catalog/v1/release.proto`) as a signed OCI
  artifact, `<registry>/catalog-release`. Each console polls it
  (`catalog.pollSeconds`, and Sync now on the Admin page), verifies it with
  a cosign Job against `catalog.signature`, and applies it
  (`console/src/catalogSync.ts`) with the old token's rights only:
  dropped products are unregistered, dropped teams retired, never purged.
  A team the catalog didn't make is left alone until an admin adopts it
  (`AdminService/AdoptCatalogTeam`), replacing `check-new-team-names`. A
  SecretStore's stored credential is set per install
  (`TeamService/SetSecretStoreCredential`). The push workflows, the catalog tool's
  `teams` commands and every console token in the catalog are gone;
  `delete-team-images` keeps the registry clean-up; `vertra catalog create`
  sets only registry variables (and removes and revokes the old ones) and
  the install sets the console's `catalog.release`, so a catalog no
  longer needs a public console. Templates aren't in the release yet
  (they come with consumers, A1). Proven on GKE Autopilot in acyclix-dev
  (2026-10-20): a release signed by catalog CI's cosign (3.1.3, key mode)
  verified by the console's (2.5.3) and applied; one signed by another key,
  and an unsigned one, refused with nothing applied. That run found the
  verification Job signing in to Artifact Registry anonymously: it now
  passes `--k8s-keychain` (the ServiceAccount's Workload Identity) unless a
  pull Secret is configured.
- [x] **P0: consumers and templates (A1)** (done 2026-10-21):
  templates travel in the catalog release and are stored per team
  (`templates`); `TemplateService` lists what a person may run (templates
  and shared actions) and runs one with parameters only, checked against
  its schema, each step built from its product (image, ServiceAccount,
  the action's secrets, token audiences, namespace); sharing with
  specific teams runs on behalf of one; a step of an unshared action is
  refused; the submitter sees, cancels, retries and reruns their run
  (a rerun runs the template again). Proven on kind with a consumer in no
  team. The Run page lists them and runs one through a form built from its
  parameter schema (the server's problems shown on their fields), with
  "Run for" when sharing needs a team; the Products page links shared
  actions to it; an execution shows the template it came from. Proven in
  a browser on kind as a consumer in no team. Roles beyond member and
  admin are P1 below. The original item: a consumer role that may run a
  team's published templates with parameters only; templates
  (`teams/<team>/dags/`, with a `parameters` block) fix each step's
  `secretRefs` and identity. Every product action is also a one-step
  template. Maintainers keep today's rights. Secret bindings live per
  action in `product.yaml` (`actions[].secretRefs`), so an exported action
  keeps its owner's bindings in any DAG; steps use the product's latest
  release. Everyone signed in is a consumer; consumers may cancel and retry
  their own runs.
- [x] **P0: projected ServiceAccount tokens for federation (I1)** (done
  2026-10-20). A product declares `tokenAudiences` in `product.yaml`; the
  release carries them, the console stores them and sets them on its
  tasks (a submitter can't), and the kernel projects one hour-long token
  per audience at `/platform/tokens/<audience>`. The console refuses the
  Kubernetes API's audiences (read from its own token) and kernel-api's;
  the identity policy refuses an undeclared audience or a longer token.
  Proven on kind and on GKE Autopilot (2026-10-20): each declared token
  arrives from the cluster's issuer for the product's ServiceAccount,
  lasting an hour; the policy refuses the rest; registration refuses
  GKE's API audience, read from the console's own token. Not yet: a
  sample that federates with it (S2's samples, or AWS from GKE).
- [x] **P1: check inputs and outputs against their schemas (C1)** (done
  2026-10-21). The console checks each step's literal inputs against its
  product's input schema at submit (`INPUT_INVALID`, each problem on its
  field; upstream references left for later) and attaches both schemas to
  the kernel's task; the kernel checks the resolved inputs before the step
  starts (`INPUT_INVALID`) and its outputs when it finishes
  (`OUTPUT_INVALID`), neither retried, and refuses a schema that isn't one
  or refers outside itself. Proven on kind (a refused literal, a template
  run checked both ways); the kernel's failures by its scheduler tests
  against Postgres.
- [x] **P1: exports (X2)** (done 2026-10-21): an action's `shareWith` in
  product.yaml is its export list, so there's no second list. Checked by
  `vertra catalog validate`; when a release is applied (a template whose
  step's action isn't shared with its team is a problem, not stored); on
  every run; and on retrying a consumer's own run, which is refused once the
  template, the action or a step is no longer shared. Raw DAGs need a
  maintainer of every team they run in.
- [x] **P1: allowed targets per team (X1)** (done 2026-10-21): team.yaml's
  `allowedTargets` (rules of teams and, per kind, values or `*` patterns),
  carried by releases; an action input typed `x-vertra-needs` gcp.project,
  gcp.folder, aws.account or azure.subscription is a target. Another
  team's run with any other value is refused before it starts
  (`TARGET_NOT_ALLOWED`, `console/src/targets.ts`); the Run form offers the
  allowed values. The owning team and admins aren't limited; a value from
  an earlier step isn't checked. Proven on kind. Left: re-checking targets
  on retry if a team narrows its rules; GCP folder membership isn't looked
  up (patterns on IDs, by decision); scoping owner identities to folders is
  each team's cloud setup.
- [x] **P1: retry policy and idempotency per action (R3)** (done
  2026-10-21): product.yaml's `idempotent` and `maxAttempts` (1–10; more
  than 1 needs idempotent), carried by releases. A registered product's
  step gets its product's attempts, fewer if its template or DAG asks,
  never more, and one if it isn't idempotent; the kernel already retries
  retryable failures (platform ones, or a product's `retryable` error)
  with a growing backoff. Every sample's create or transform action is
  idempotent. Proven on kind. Left: the run page saying whether a manual
  retry is safe, from the same flag.
- [x] **P1: who asked and who acted, per attempt** (done 2026-10-21):
  each attempt records who asked for it (the submitter for a first
  attempt, whoever retried it, or nobody for an automatic retry: the
  console passes "user:<id>", which the kernel never resolves), the
  identity it ran as and its image (kernel migration 0005). Attempts are in
  both APIs (`TaskStatus.attempts`) with the requester as an email, and
  under each step on the run page. Proven on kind.
- [x] **P1: samples read identity references from team secrets (S2)**
  (done 2026-10-21): the gcp samples impersonate the service account in
  the team secret `gcp-target` (key `service-account`), and the aws samples
  assume the role in `aws-target` (key `role-arn`), each mounted only for
  actions that list it in `secretRefs`; the deployment-wide
  `GCP_TARGET_SERVICE_ACCOUNT` and `AWS_TARGET_ROLE_ARN` are gone from code
  and docs. Proven locally against the built images (impersonation and
  AssumeRole only with the secret mounted; the old variables ignored).
  Left: proving it against a real cloud with the next GKE or EKS run.
- [x] **P1: registry access across clouds (M2)** (done 2026-10-22): an
  install reads another install's catalog (`externalCatalog` in vertra.yaml:
  the registry, and for a Google Artifact Registry on another cloud a
  Workload Identity provider) and trusts its signing key
  (`catalogSignature.publicKeyFile`). With no stored key: the console's
  projected token, exchanged at Google's STS, signs it in
  (`console/src/registryFederation.ts`), and every policy sync it writes the
  short-lived token as `vertra-pull` in each team namespace (the kubelet)
  and `vertra-registry-token` in its own (the verify and scan Jobs; the
  write fence allows that one Secret). `vertra apply` prints the catalog
  owner's three gcloud commands (a pool, a provider for the cluster's
  issuer limited to the console's ServiceAccount, read on the repository).
  Proven 2026-10-22: one catalog in Artifact Registry (acyclix-dev), signed
  with a catalog key; a GKE install read it natively and an EKS install
  (us-east-2) by federation. Both applied the signed release, pinned,
  scanned and ran a step from it (the EKS kubelet pulling from Google), and
  both refused a release signed with another key and an unsigned one. Torn
  down after. Left: the reverse direction (ECR read from GKE, by AWS web
  identity), a `vertra` command for the owner's grant, and policy-controller
  (step image signatures) on EKS.
- [x] **P1: recovering the first admin's password** (done 2026-10-22):
  `vertra admin reset-password` runs the console's `dist/db/resetAdmin.js`
  in its Pod (cluster access required): a new random password for an
  admin, printed once, every session revoked, audited. Proven on kind.
- [x] **Cross-building on Apple silicon** (done 2026-10-27): the console's
  npm stages, and now the Node sample's (reverse) build stage, run on the
  build platform, so publishing for amd64 from a Mac doesn't run npm under
  emulation, where it broke.
- [x] **P2: readiness per install** (done 2026-10-24). product.yaml's
  `check` names the action that says whether it's ready here (`ready`,
  `principal`, `missing`); the console runs it itself (a check run, no
  submitter) when a product is new or changed, daily, and on **Check now**
  (`readiness.ts`, console migration 0023), shows it in the catalog, on
  Every product and the run form, and tells the team's maintainers and
  webhook when it isn't ready. Left: the cloud samples' checks.
- [x] **P2: schedules** (done 2026-10-24): a template or action on a cron
  (five fields, an IANA time zone, at most every five minutes), with set
  parameters, for a team, as one of its bots, made from the run form
  (Schedule…) and kept on the team's Schedules tab. Each run is started as
  the bot, through the same checks, by whichever console claims it first;
  a refused start is kept and told to the maintainers (`scheduleRunner.ts`,
  console migration 0024). Left: schedules waking a sleeping install.
- [x] **P2: caps per product** (done 2026-10-27, proven on kind):
  product.yaml's `maxRunning` (1 to 100) caps how many of the product's
  steps, all its actions sharing it, are claimed or running at once; the
  rest wait READY, and the run page says why (`waiting_for_cap`). The
  console scopes it to the product's catalog folder (or its image, for one
  registered by hand); the kernel holds it in the claim, under an advisory
  lock like concurrency keys. The ticket sample allows two (vertra 0.5.0).
- [x] **Keyless bots** (done 2026-10-24): a bot signs in with its CI job's
  OIDC identity (GitHub Actions, GitLab) instead of a stored token. Its
  team's maintainers bind it to exact claims (`TokenService.AddBotIdentity`;
  console migration 0025); `AuthService/ExchangeToken` verifies the token
  (the issuer's keys, an allowed issuer, the install's audience, expiry)
  and returns an hour's session for the one bot it matches, which the
  gateway takes as is. Proven with a test issuer's real signed tokens; not
  yet from a real GitHub Actions job (that needs a console it can reach).
- [x] **P1: roles** (done 2026-10-21): a team's people are maintainers or
  members (`team_memberships.role`; memberships from before are
  maintainers). Members see the team's runs, logs, Pods and secrets'
  names, and run its actions; maintainers also manage people and roles,
  secrets, bots, raw DAGs and cancelling its runs. Everyone signed in is a
  consumer of what's shared with their teams. Managed on the team's
  Members tab (`TeamService/SetMemberRole`); never without a maintainer
  (`LAST_MAINTAINER`). Bots, and people an admin creates in a team, are
  maintainers. Left: SSO groups mapped to roles (with SSO sign-in).
- [x] **P1: `visibility` on actions** (done 2026-10-21): `visibility:
  hidden` on an action (product.yaml) or a template keeps it to its own
  team (and admins), and can't be combined with `shareWith`; everything
  else is listed to everyone, the Run page showing what isn't shared with
  you under "Not shared with you" with **Ask for access**: GitHub's
  new-issue page on the catalog repository, filled in with the change to
  `shareWith` and a link to the file, opened in the person's browser (the
  console only reads the catalog). Releases carry each file's path
  (`ProductAction.path`, `Template.path`) and `hidden`. Left: links for
  catalogs not on GitHub (GitLab, with GitLab).
- [x] **P1: approvals** (done 2026-10-21): product.yaml's `approval`
  (`always`, or `otherTeams`: only another team's runs) and an
  `allowedTargets` rule's `approval: true` (its targets allowed only with
  one), carried by releases. The console marks such steps
  `approvalRequired` (submitters can't); the kernel holds them in
  `AWAITING_APPROVAL` instead of `READY` (kernel migration 0006, console
  0011). A maintainer of the step's team, never whoever submitted the run,
  approves or declines on the run page (`ExecutionService/DecideApproval`,
  audited; the kernel records who in `TASK_APPROVED`); the home page lists
  what's waiting (`ListPendingApprovals`). Declined: `APPROVAL_DECLINED`;
  undecided for `scheduler.approvalTimeoutSeconds` (3 days):
  `APPROVAL_EXPIRED`. An approval lasts across retries; a declined step
  asks again. Proven on kind with the local sample's rot13
  (`approval: otherTeams`). Approvers are notified, and can preview the
  step (both 2026-10-24). Left: approval for one consumer team and not
  another without a target rule.
- [x] **P1: failure help from the owner** (done 2026-10-21): product.yaml's
  `errors` (CODE: means, do) and team.yaml's `help` (chat, url) beside
  `contact`, carried by releases (console migration 0010). A failed step's
  `help` says what its code means (the owner's words first, the platform's
  for its own codes: `console/src/failureHelp.ts`), whether a retry is safe
  (the product's `idempotent`), and whom to ask; shown under the step on
  the run page. Proven on kind with a timed-out step.
- [x] **P1: concurrency keys** (done 2026-10-21): product.yaml's
  `concurrencyKey` (input names, checked to exist by vertra catalog
  validate), carried by releases; the console sends the kernel the
  product and those inputs for each step (submitters can't set one). The
  scheduler works the key out from the resolved inputs when it claims a
  step, and holds it READY while one with the same key is claimed or
  running; a transaction-scoped advisory lock per key keeps two schedulers
  apart (kernel migration 0004). Proven on kind: two runs on the same value
  ran one after the other, a third on another value alongside. A held
  step records its key, and the run page says what it waits for
  (`TaskStatus.waiting_for`, while another with the key is claimed or
  running; proven on kind with the local sample's upper-case, 2026-10-23).
- [x] **P2: the marketplace pages** (eleven mocked up 2026-10-19; done 2026-10-25):
  Catalog with readiness, Runs list and run timeline, Schedules, Admin,
  Compose (2026-10-24: type-matched wiring by `x-vertra-needs` and
  `x-vertra-provides`, drafts in the browser, Propose as a template on
  GitHub's new-file page, Run now when it's all your team's), runnable
  examples (2026-10-24: an action's passing contract tests, carried by
  releases, offered on its run form as Use this), another team's page
  (2026-10-24: `TeamService.GetTeamProfile`, where to ask it and its size,
  and what it offers you, with sharing and readiness), drafts kept by the
  console (2026-10-25: `DraftService`, for the draft's team, from any device,
  a save refused if someone saved since), templates' own examples
  (2026-10-25: a template file's `examples`, checked against its parameters,
  carried by releases, offered on its run form).
- [x] **P2: preview** (done 2026-10-24). product.yaml's `plan` names the
  action that says what this one would do (`summary`, `changes`); the run
  form's **Preview** runs it as a preview run (a template: each step with a
  plan whose inputs are known up front), and whoever may approve a waiting
  step previews it with its real inputs (`ExecutionService/PreviewStep`).
  Previews notify nobody and record nothing. Console migration 0022; the
  local `ticket` sample has one.
- [x] **P2: what a run created** (done 2026-10-23; decision 21). A step
  reports `resources` (type, id, name, link) in its outputs; the console
  keeps them with the step's inputs and outputs once the run finishes
  (`resourceRecorder.ts`, console migration 0020), so they outlive the run.
  product.yaml's `cleanup` names the action that deletes one (given
  `{"resource": ...}`, or inputs mapped with `$input`, `$output`,
  `$resource`). The run page's **What it made** and Runs' **What runs
  made** (searchable) show them; Delete runs the cleanup for the team it was
  made for, newest first, with sharing and approvals. Proven on kind with
  the local `ticket` sample. The gcp samples' `project`, `app-hosting` and
  `cloud-sql` delete what they made (labelled `vertra-made`; done
  2026-10-24, decided: only the team it was made for, whoever ran it, and
  admins; a resource keeps its first owner). Proven 2026-10-25 on GKE in
  acyclix-dev: a gcp member made a project (in a folder) and a Cloud Run
  service, another team's member was refused their Delete, an admin's
  cleanup run shut both down. The aws samples' (s3-bucket, app-runner,
  rds-postgres) and Cloud SQL's proven 2026-10-25 on EKS and GKE. Azure's
  cleanups are after the MVP (decided 2026-10-25).
- [x] **P2: notifications** (done 2026-10-24): an inbox (the bell) and
  each team's chat webhook (Slack, Google Chat, Teams; decided 2026-10-24:
  the URL kept encrypted in the console's database, write-only, allowed
  hosts only). A run that failed or finished tells whoever ran it, a
  failure posts to its team's webhook; a step waiting for approval tells
  its team's maintainers (not whoever ran it) and webhook; the catalog not
  pulled for 30 minutes tells admins (`notifier.ts`, console migration
  0021); a product not ready too (with readiness); by email (2026-10-24:
  SMTP, `notifications.email` in the console chart, each person choosing
  the kinds in Preferences; console migration 0027).
- [x] **P2: copy as API call, run again with changes** (done 2026-10-23):
  the run form's **Show as an API call** (the same run as `curl`, proven
  against kind), and a run's **Run with changes** (its form, filled in from
  the run; the catalog's current version, so a gone image doesn't stop it).
- [x] **Scale-down for development installs only**: `vertra init` says so
  before asking (done 2026-10-27). Schedules wake a sleeping install (done 2026-10-24: the
  console publishes its next schedule; the sleeper stays awake for one due
  soon and otherwise arms the kernel chart's `-wake` CronJob, `kernel
  wake`, five minutes before it. Proven on kind: slept at 21:13, woke at
  21:20, the 21:25 schedule ran as its bot, slept again at 21:27, re-armed
  for the next day).
- [ ] **Trace what a retired team's running executions do** (not checked in
  the assessment).

- [ ] **Catalog versions, and installs reading another's catalog**
  (decision 22, `docs/assessment.md`; vertra 0.4.0). Done 2026-10-26:
  - Versions: a `vX.Y.Z` tag in the catalog repository asks CI on main
    (`version.yml`) to tag that commit's release `catalog-release:vX.Y.Z`
    (`vertra catalog promote`; immutable; only a commit main published).
    The console follows its release's tag, or the newest version
    (`catalog.newestVersion`); `vertra` sets either from `catalogVersion`.
  - A reading install (`externalCatalog`) trusts the owner's signer
    (`catalogSignature`: a public key, or the repository for keyless) on
    releases and, on gcp and aws, images (policy-controller, the modules'
    `verify` identity; apply prints the owner's grant on the same cloud).
  - `vertra catalog create` refuses a repository that already publishes to
    another install's registry, unless `--take-over`.
  Proven on kind (versions) and GKE, an owner signing keyless and a reader
  on `newest` in acyclix-dev: the tag's run started CI on main, which made
  the version; the reader applied nothing before a version, then v1.0.0,
  held there while a merge moved the owner's `latest`, then v1.1.0, each the
  owner's digest, verified against the owner's keyless identity; the owner
  ran a signed image and the reader refused an unsigned one pushed by hand
  (`IMAGE_NOT_SIGNED`). Left:
  - (Proven 2026-10-27.) A signed image running on a reader: an EKS reader
    of the GKE owner's Artifact Registry (federation, policy-controller
    signing in with the steps' pull Secret) ran a signed step and refused an
    unsigned one, and its admin got the `step_refused` alert.
  - An aws reader of another account's ECR (its verifier role reads only its
    own task registry).
  - (Fixed 2026-10-27, not yet seen on a cloud.) `vertra destroy` stopped
    when the cluster's API didn't answer (the reader's was torn down with
    `tofu destroy` on its state): it now skips what's inside an unanswering
    cluster, deletes the cloud side, and lists the unattached disks or EBS
    volumes its volumes may have left.

## Security

- [x] **TLS in front of the console** in the charts. Done 2026-10-22, proven
  on kind (`make kind-tls`): the Ingress takes a certificate from
  cert-manager (an issuer of yours, or Let's Encrypt through the chart's own
  Issuer) as well as a Secret or the cloud, and refuses plain HTTP for
  Traefik, NGINX and GKE; or an HTTPRoute on a Gateway you run, with a
  redirect from its HTTP listener. `vertra` sets it up on existing clusters
  (2026-10-22, proven on a second kind cluster treated as existing: cert-manager
  installed by vertra, the certificate reported not ready until its issuer
  existed, then HTTPS verified through the cluster's own Traefik). Let's
  Encrypt proven on GKE (2026-10-22): the chart's Issuer, HTTP-01 through
  Traefik's load balancer, staging then production; a certificate for a
  real hostname trusted by an ordinary client, plain HTTP refused.
  `vertra apply` names the DNS record a hostname of yours needs and waits
  for it; `vertra status` shows it and the certificate (2026-10-22; not yet
  run against a cluster whose Ingress has a public address).
- [x] **SSO/OIDC sign-in**, with groups mapped to teams (done 2026-10-25). Sign-in with
  Google is in (2026-10-22: `console/src/auth/oidc.ts`, the console chart's
  `sso`): the authorization code flow with PKCE, a verified email in an
  allowed Workspace domain, each account bound to its Google identity at the
  first sign-in. Passwords keep working; a team an admin sets to require
  single sign-on refuses its members' passwords and password sessions
  (admins exempt; not every team can use it, decided 2026-10-22). Teams
  are still set in Vertra (decided 2026-10-22). Proven on kind with a real
  Google OAuth client (2026-10-22): a Workspace account's first sign-in
  made and bound its account; with its team restricted, a member's password
  was refused (403 SSO_REQUIRED, a wrong one still 401) and their earlier
  password session refused by the console and the gateway alike, while an
  admin's password kept working. `vertra sso google` sets it up
  (2026-10-22: the links and redirect URI, the client file checked, the
  secret written by apply through stdin). Admin-configurable and groups
  (2026-10-25, decided: optional, set on Admin, People unless the install
  set it; groups from the ID token's claim and Google Workspace; mapped
  teams owned by the provider): `SsoService`, console migration 0029,
  proven on kind (turned on and off without a restart, an issuer checked)
  and in tests against a stand-in provider. `vertra sso google-groups`
  (gcp) enables Cloud Identity's API and names the console's own service
  account for a Workspace admin to make a Groups Reader (no key, no other
  account: the console reads groups as itself). Proven on GKE (2026-10-25):
  a real Google sign-in of a Workspace account in a mapped group made it
  that team's maintainer; the console asks about each mapped group
  (checkTransitiveMembership), since a Groups Reader can't search all of a
  person's groups at once. Entra ID and Okta untried for real, skipped for
  now (decided 2026-10-25): the flow and the groups claim are generic, and
  tested against a stand-in provider.
- [x] **Force a password change on first sign-in** for admin-created
  accounts (done 2026-10-22): a password someone else set (a new account's,
  an admin's reset of someone else's, `vertra admin reset-password`) marks
  the account (`users.must_change_password`); until its owner changes it,
  a password session may only GetMe and ChangePassword
  (`PASSWORD_CHANGE_REQUIRED`), the gateway refuses it, and the console
  sends them to their account page. Single sign-on and bots aren't held
  back. The chart's bootstrap admin is marked too when its password was
  generated (2026-10-22), not when the operator set one (kind's fixed
  password).
- [x] **Limit what steps can reach inside the cluster** (S3, done
  2026-10-21): the console writes `vertra-default-deny` into every team
  namespace (`teamNetwork.ts`; with the namespace, and on every policy
  resync), letting in connections only from the same namespace. Its write
  fence accepts only that policy in that shape, and it can't delete one.
  Proven on kind: another team's Pod and the platform's were refused, the
  same team's connected, and without the policy the other team got
  through; the fence refused opening it, a second policy, one in the
  platform namespace, and deleting it. Next, when the gateway comes: let it
  reach API products' backends in team namespaces.
- [x] **Make the charts require non-root** on the kernel and console Pods
  (done 2026-10-22, proven on kind: a step ran end to end): kernel-api, the
  scheduler, the console and both migrations require `runAsNonRoot`, the
  runtime's seccomp profile, no privilege escalation, no capabilities and a
  read-only root filesystem (`/tmp` an emptyDir), like the gateway, Loki,
  the collector and Trivy already did. Left: Postgres and the Jobs that run
  its image (backups, the console's database), whose image starts as root.
- [x] **Bind the console's Secret rights per team namespace** as teams are
  created, instead of cluster-wide fenced by an admission policy. Decided
  against (2026-10-22): the console would have to create RoleBindings (and
  `bind` the role they grant), and only the same admission policy would
  stop it binding that role anywhere, so nothing would be gained and the
  console would gain RBAC rights. What stands: the write fence is the
  boundary, and the console can't change it (it may update only the image,
  identity and scan policies, by name). Done instead: the console checks
  the fence is in force (fails closed, checks something, bound to deny)
  before it starts and refuses to start without it (proven on kind by
  deleting the binding), and Observe reports it.
- [x] **Ship audit log lines to a write-once store** (done 2026-10-22): the
  audit log is hash-chained (`audit_log.hash`), and with `audit.export` the
  console copies new entries every few minutes, their chain checked, to a
  bucket that refuses deletes and overwrites (GCS retention, S3 Object
  Lock; `vertra` makes it, kept by destroy, `audit.lock` for the permanent
  kind), create-only. Proven on kind (`make kind-audit-store`, SeaweedFS):
  copies written, an overwrite and a locked delete refused, a forged entry
  stopping the copy and Observe saying where. On GCS (GKE, 2026-10-22):
  copied by the console's own identity (objectCreator only), and a delete
  by the project's owner refused by the retention policy. Left: the S3
  bucket proven on EKS; checking the database against the copies.
- [x] **Decide who may read a multi-team execution** (decided and done
  2026-10-22, `console/src/core/runView.ts`): a run's owners (admins, its
  submitter, the team a template run was for; a raw DAG's every team) see
  every step; a provider team's member sees their own steps in full and, of
  the rest, only product, state, timing and failure code, never inputs,
  outputs, failure messages, template parameters or logs, in the run's
  details, events, logs and Observe's log search. Cancel and retry still
  need every team.
- [ ] **Have the GKE deploy use released images** (done 2026-10-22 in the
  Makefile: `make gke-deploy VERSION=...` deploys the release's signed
  charts and images, every signature checked against the release
  workflow's identity at that tag first; the working-copy build is
  `gke-deploy-*-from-source`). The packages are public, and v0.2.2's
  images and charts verify against its release workflow (cosign v3, which
  the release signs with). Left: running a deploy with it once.
- [x] **One cloud identity per product in the gcp sample** (done
  2026-10-22): each gcp and aws sample product declares its own
  `serviceAccount` (`gcp-<product>`, `aws-<product>`), and the READMEs grant
  each only what it calls: on GCP straight to its Kubernetes identity
  (Workload Identity Federation, no Google service account or annotation),
  on AWS by Pod Identity to its own role. Left: proving the gcp grants on a
  cluster.
- [x] **Catalog: keep pull-request workflows away from secrets and cloud
  identities** (checked 2026-10-22): the cloud identities trust only `main`
  (GCP's `assertion.ref`) or the `catalog-publish` Environment (AWS's
  `sub`), so a pull request's token never matches; the publish and purge
  jobs run in `main`-only Environments; `vertra` sets no secrets (OIDC to
  the registry, keyless signing). Added: `vertra catalog create` warns, by
  name, about any repository-level secret (which every pull request's
  workflows get), and the template says where one belongs.

## Console

- [x] **A page for image scans** (done 2026-10-25): Admin's **Image scans**
  tab, every digest's verdict by state, its findings, Rescan now, and
  Accept with a reason; Observe's Security tab links to it for admins. The
  audit log's is Observe's Audit log tab (2026-10-22).
- [x] **A team's `owner` on its console page** (done 2026-10-27, decided:
  shown, never a grant): team.yaml's owner travels in the release and the
  Team page says who owns the team in the catalog; membership stays the
  console's and single sign-on's.
- [x] **The catalog repository for the secret-setup guides** (done
  2026-10-27): the repository the applied release came from, unless the
  console chart's `secretSources.catalogRepo` names another; no Admin
  setting needed.
- [x] **Run forms generated from each action's input schema** (done
  2026-10-23). The Catalog's Run opens a page (`/catalog/run`) whose form
  comes from the template's parameters or the action's input schema
  (`console/frontend/src/schemaForm.ts`): labels from `title`, help from
  `description`, defaults, `enum` as a choice, `required`, `pattern`,
  lengths and limits checked on the field before sending, lists for arrays
  of text or numbers, name/value rows for string maps, JSON for the rest;
  targets (`x-vertra-needs`) offered from what the owning team allows. Form
  hints, checked by `./vertra catalog validate`: `x-vertra-order`,
  `x-vertra-group`, `x-vertra-widget: textarea`, `x-vertra-pattern-message`.
  Our own small renderer rather than `@rjsf/mui`, which would have been a
  large dependency to restyle. Secrets were never inputs (they come from
  `secretRefs`); the console and kernel already check inputs against the
  schema.
- [x] **Show a product's latest tag** where people build DAGs (done
  2026-10-23): Submit a DAG's **Add a step** appends a step of one of your
  teams' products with its latest image, action, team and identity, and its
  required inputs to fill in (Every product already marks the latest).
- [ ] **Stop reading `externalReference` and `idempotencyKey`** (now
  `name` and `requestId`; submissions over Connect can't send them) once
  no stored execution has them: `submissionRequest` in
  `console/src/kernel/client.ts`, `withCurrentFieldNames` in
  `console/src/core/executions.ts`,
  `storedDag` in `console/src/rpc/services/execution.ts`, and the
  frontend's `dagCheck.ts`.

## Products and catalog

- [ ] **API products and the gateway** (decision 20, `docs/assessment.md`;
  mocked up 2026-10-21 in the console mockups, boards 12–16). A team
  publishes a backend it already runs: `teams/<team>/apis/<name>/api.yaml`
  (`kind: Api`) and its `openapi.yaml`; the gateway forwards exactly what
  the spec describes and blocks the rest (404, never forwarded). In order:
  1. ~~The format~~ (done 2026-10-22): `kind: Api` in
     `teams/<team>/apis/<name>/api.yaml` (`tools/api.schema.json`, embedded
     in vertra); `vertra catalog validate` checks the OpenAPI file (3.0 or
     3.1 by libopenapi, `$ref`s inside it only, a schema for every
     parameter and body, `servers` including `backend.url`, no two paths
     alike, nothing under `/.vertra/`) and the limits; releases carry APIs
     with their OpenAPI as JSON (`release.proto`'s `Api`).
  2. ~~The console stores them~~ (done 2026-10-22): the `apis` table
     (console migration 0012), applied and removed with releases (only the
     named teams'), each with its ServiceAccount; the chart's `gateway`
     values (`backendHosts`, `internetTeams`, its addresses); an API under
     no allowed host is held. `ApiService`: ListApis, GetApi (with the
     spec), PauseApi and ResumeApi (a maintainer of its team, with a
     message for callers).
  3. ~~The gateway~~ (done 2026-10-22): `gateway/`, a Go process of its
     own reading published APIs from the console's database, deployed by
     the console chart (`gateway.enabled`). Per request: the API (paused,
     held, closed), caller sign-in as at the console (session, bot token),
     `shareWith` (and `Vertra-Team` to pick among the caller's teams), size,
     the spec (404 not in it, 400 unfit; libopenapi-validator), the calling
     team's rate (429), then forwarded with the caller's `Authorization`,
     hop-by-hop and `Vertra-*` headers removed, the backend credential and
     a signed `Vertra-Caller` (EdDSA, `/.vertra/jwks.json`) added, the
     answer streamed back. `Vertra-Answered-By` on every answer; logs and
     metrics without bodies or credentials. Proven on kind with an echo
     backend: forwarded, blocked, invalid, limited, not shared, paused, and
     its token fence. Keyless bots' sessions are ordinary console
     sessions, so it takes them as is (2026-10-24). Left: a read-only
     database role for it.
  4. Backend credentials, minted per request (done and proven
     2026-10-22: a GKE install's gateway called a Cloud Run service that
     requires Google sign-in with an ID token for its invoker account, and
     a Lambda function URL that requires IAM signed as a role trusting the
     GKE cluster's issuer, both forwarded with Vertra-Caller; both torn
     down after): a token for the API's own ServiceAccount
     (TokenRequest), a Google ID token (its token federated at Google's
     STS, then generateIdToken), AWS SigV4 (AssumeRoleWithWebIdentity,
     then signing). AWS only besides Google, no Azure (decided
     2026-10-22); no static-secret fallback (the gateway reads no
     Secrets). Then Google ID tokens,
     AWS SigV4 and Azure tokens through I1's federation. A Secret from the
     team's store only as a fallback, read by name. The gateway's RBAC is
     `serviceaccounts/token` on the API ServiceAccounts alone.
  5. ~~Its chart~~ (done 2026-10-22): Deployment, Service, an Ingress for
     the public listener, egress anywhere but the cloud metadata server
     (`gateway.egress` to narrow); pausing an API and closing the gateway
     from the console (`gateway_state`, console migration 0013).
  6. The pages: ~~the APIs list and an API's page~~ (done 2026-10-22:
     endpoints from its spec, how to call it, the caller's limit, sharing,
     its backend for its own team, pausing for its maintainers, its OpenAPI
     file to download); traffic and blocked requests (the gateway counts
     them into `api_traffic`, kept a week), a team's APIs tab, and the
     admin's gateway card (done 2026-10-22).
  Proven on kind with a backend in a team namespace, then on GKE with a
  Cloud Run backend and a Lambda function URL (2026-10-22). Left: a
  read-only database role for the gateway (it only writes api_traffic).

- [ ] **Orders from outside the cluster** (decision 23, `docs/assessment.md`,
  decided 2026-10-27). Through the console's public `/api`, as a bot signed
  in keylessly; kernel-api stays private. To build:
  1. An order is for the bot's own team (its caps, quota and approvals; its
     maintainers see and cancel it).
  2. A per-bot list of templates it may order, set by its team's
     maintainers; RunTemplate refuses any other for a bot with a list.
  3. Hearing back: polling (`GetExecution`, there today) and a per-bot
     callback URL (allowed hosts, HMAC-signed per bot, retried as webhooks
     are).
  4. A request rate per bot (429 past it).
  5. Possibly: an outcome webhook a team subscribes to (JSON for systems,
     beside its chat webhook).
- [ ] **Order builder (exploratory):** turn a cart of products into a DAG
  from their schemas. The console stores products' descriptions and wiring
  types already; next, the generator (an `OrderService/PreviewOrder`
  method), then a page, opening the DAG in Compose (decision 23).
- [x] **Base images the platform maintains** (done 2026-10-27, decided:
  mirror and pin, not required): a catalog's `bases.yaml` lists approved
  bases; catalog CI copies each weekly into `<registry>/bases/<name>` (same
  digest, every platform), scans it (reported, not blocking) and signs it
  (`vertra catalog bases mirror`), and `vertra catalog bases --use-mirror`
  points Dockerfiles at the copies. Copying is tested against a registry;
  the weekly run itself isn't seen yet (the next cloud catalog run).
- [x] **One provider identity per team** for SecretStores (done
  2026-10-27): the console records each team's store identities
  (`secret_store_identities`) and refuses another team's store naming one
  (`IDENTITY_IN_USE`), and the catalog's `secret-stores check` says so in
  the pull request. Bindings made only on the cloud's side (EKS Pod
  Identity) stay the cloud administrator's to keep per team.

## Testing and housekeeping

- [x] **`vertra catalog publish` from a laptop builds for the laptop's
  platform** (done 2026-10-25): a catalog's `platform` (`VERTRA_PLATFORM`)
  says what to build for; unset, a local registry gets this machine's, any
  other `linux/amd64`, so a Mac's publish runs on a cloud cluster (found
  proving the gcp cleanups on GKE). One platform per catalog, not
  multi-platform images.
- [x] **`vertra` sets up a signed catalog** (done 2026-10-26): `signing`
  (none, kms, keyless), asked at init; apply makes the KMS key (gcp, aws)
  only the catalog's CI may sign with, installs policy-controller bound to a
  registry reader, and gives both charts the signer; `vertra catalog create`
  sets the repository's VERTRA_SIGNING_* variables. Proven on GKE, kms then
  keyless, and on EKS, AWS KMS with policy-controller reading ECR through
  Pod Identity (see docs/security-model.md). Found on the way, and fixed:
  the template pinned a vertra too old for its own samples (released 0.3.0
  and pinned it; CI now validates the template with its pinned vertra), and
  keyless signing failed with cosign 3 (0.3.1), and an AWS kms apply read
  no public key (the CLI's `--output json` won over `--output text`).
- [x] **An intermittent console test** (fixed 2026-10-25):
  `product-ownership.test.ts`'s startup claim read every product, then
  inserted for a team another file had deleted meanwhile. The claim now
  reads the team, locked (`FOR KEY SHARE`), in the same statement as its
  insert (reading it unlocked still raced, once).
- [x] **The docs page's diagrams under mermaid 12** (done 2026-10-27):
  every one parses under 12.2.0, and a frontend test
  (`src/docsDiagrams.test.ts`) keeps it so for the next bump. How they look
  hasn't been checked by eye.
- [ ] **Rare console test failures in a full parallel run** (2026-10-27):
  one at a time, in different files (apis, team-lifecycle, readiness), each
  passing alone and in most full runs; likely two files sharing database
  state. Find which.
- [ ] **An end-to-end secret test** with a product registered by catalog CI:
  proven by hand on EKS (2026-10-27: a catalog-registered product mounting
  a secret ESO synced); an automated one, on kind, remains.
- [ ] **Re-pin `rot13`'s distroless base** once Google rebuilds
  `cc-debian12` with Debian's libssl3 fix (CVE-2026-84782), and delete its
  `.trivyignore` line (it expires 2026-11-27 by itself, failing the check
  again if the base still has it).
- [x] **actionlint in the catalog template's own CI** (done 2026-10-27):
  its pull-request check lints the workflows, with actionlint installed
  pinned as the scanners are.
- [x] **`make up` mistakes any console port-forward for its own** (done:
  `PORT_FORWARD` names the context and port, which `pgrep`/`pkill` match).
- [ ] **Switch to Sigstore's newer signature format** once policy-controller
  reads it (catalog CI signs with `--new-bundle-format=false`).

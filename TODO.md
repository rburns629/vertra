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
    that couldn't be applied). Left: each image's signer and SBOM.
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
    `networkPolicy.metricsFrom`. Left: proving the PodMonitors, rules and
    dashboard against a real Prometheus Operator and Grafana (checked
    with promtool, and scraped by hand on kind). And GKE's Managed Service for Prometheus,
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
  Just Ship It was left empty afterwards (2026-10-19). The test catalog
  repositories (rburns629/vertra-catalog-test, -aws-test) are kept for
  now. Still to do: the AWS sample's SecretStore. The sizes' figures are first estimates, to be
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
- [ ] **Prove the AWS and Azure samples** (`catalog-template/samples/aws`,
  `azure`): they build and their tests pass with the SDKs mocked, but they
  haven't called a real account. On EKS and AKS: bind each product's
  ServiceAccount, run each DAG, check the resources and the password-free
  databases, delete them; and their SecretStores through ESO.
- [x] **Let a deployment label step Pods** (I2, done 2026-10-21):
  `scheduler.taskPodLabels` (`TASK_POD_LABELS`), on the step Pod only; the
  scheduler refuses to start with `app` or a `vertra.dev/*` key. Proven on
  kind (a step's Pod carried them). The identity policy checks Jobs, not
  Pods, so the volume AKS's webhook adds to the Pod isn't checked by it.
  Left: the Azure sample signing in, when Azure is proven.
- [ ] **Prove backups on each cloud.** `backup.destination` takes `gcs`,
  `s3`, `azure` or `pvc`; `pvc` and S3-compatible storage are proven on
  kind, GCS, S3 on AWS (Pod Identity or IRSA) and Azure Blob aren't. On each:
  run one, download it, restore it into a throwaway database. Also: the GCS
  backup image (`google/cloud-sdk:*-slim`) is amd64 only, so Arm nodes need
  another image.
- [ ] **Example values for EKS and AKS** next to `helm/values/gke/`, and a
  per-cloud guide to binding identities (console scanning and registry
  checks, ESO, products).
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

## Agreed direction

From the assessment of 2026-10-19 ([docs/assessment.md](docs/assessment.md);
IDs refer to its findings). P0 first; none of it needs a new service.
This comes before Azure and GitLab, which are deferred (the Azure items
elsewhere in this file wait until then).

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
- [ ] **Cross-building the console on Apple silicon** broke under amd64
  emulation (npm's cache size computed as 0: emulated floating-point); the
  console's Dockerfile now runs its npm stages on the build platform. The
  catalog's Node samples (reverse) still build under emulation when
  published from a Mac for amd64: publish from CI, or give their
  Dockerfiles the same split.
- [ ] **P2: readiness per install.** Each product may ship a `check` action
  (who am I, may I do this); the console runs it per install on
  registration and daily, records the principal, and shows what's missing.
- [ ] **P2: caps per product, and schedules** (a template on a cron, run as
  a bot).
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
  (`approval: otherTeams`). Left: approval for one consumer team and not
  another without a target rule; notifying approvers (P2 notifications);
  showing an action's Preview to the approver (with Preview).
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
  ran one after the other, a third on another value alongside. Left:
  showing "waiting for <key>" on the run page.
- [ ] **P2: the marketplace pages** (eleven mocked up 2026-10-19): Catalog
  with readiness and runnable examples, Runs list and run timeline, Compose
  (type-matched wiring, drafts, Propose as a template from the person's
  browser), Teams (another team's page; own team with readiness),
  Schedules, Admin.
- [ ] **P2: preview.** An optional `plan` action; the form offers Preview
  and approvers see it.
- [ ] **P2: what a run created.** A `resources` output convention (type,
  id, link), shown per run and searchable; cleanup runs products' `delete`
  actions in reverse.
- [ ] **P2: notifications** (failure, finish, a product not ready, the
  catalog not pulled), **copy as API call**, **run again with changes**.
- [ ] **Scale-down for development installs only**: say so in
  `vertra init`, and let schedules wake a sleeping install.
- [ ] **Trace what a retired team's running executions do** (not checked in
  the assessment).

## Security

- [ ] **TLS in front of the console** in the charts. Done 2026-10-22, proven
  on kind (`make kind-tls`): the Ingress takes a certificate from
  cert-manager (an issuer of yours, or Let's Encrypt through the chart's own
  Issuer) as well as a Secret or the cloud, and refuses plain HTTP for
  Traefik, NGINX and GKE; or an HTTPRoute on a Gateway you run, with a
  redirect from its HTTP listener. Left: `vertra` offering cert-manager on
  existing clusters; Let's Encrypt proven on a real public host.
- [ ] **SSO/OIDC sign-in**, with groups mapped to teams. Sign-in with
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
  admin's password kept working. Left: Google Groups mapped to
  teams (Cloud Identity's Groups API, with the Groups Reader role); Entra ID
  and Okta (the flow is generic, untried); `vertra` setting it up.
- [x] **Force a password change on first sign-in** for admin-created
  accounts (done 2026-10-22): a password someone else set (a new account's,
  an admin's reset of someone else's, `vertra admin reset-password`) marks
  the account (`users.must_change_password`); until its owner changes it,
  a password session may only GetMe and ChangePassword
  (`PASSWORD_CHANGE_REQUIRED`), the gateway refuses it, and the console
  sends them to their account page. Single sign-on and bots aren't held
  back. The chart's bootstrap admin isn't marked (kind's fixed password).
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
  stopping the copy and Observe saying where. Left: the GCS and S3 buckets
  proven on a cloud; checking the database against the copies.
- [x] **Decide who may read a multi-team execution** (decided and done
  2026-10-22, `console/src/core/runView.ts`): a run's owners (admins, its
  submitter, the team a template run was for; a raw DAG's every team) see
  every step; a provider team's member sees their own steps in full and, of
  the rest, only product, state, timing and failure code, never inputs,
  outputs, failure messages, template parameters or logs, in the run's
  details, events, logs and Observe's log search. Cancel and retry still
  need every team.
- [ ] **Have the GKE deploy use released images** (`make gke-deploy` still
  builds from the working copy with Cloud Build); the release workflow
  builds, scans and signs them in CI.
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

- [ ] **A page for image scans** (`ImageService/ListImageScans`), which
  has an API only (Observe's security checks show each image's latest
  verdict). The audit log's is Observe's Audit log tab (2026-10-22).
- [ ] **Usable on a phone:** the sidebar is a permanent drawer
  (`layout/AppLayout.tsx`); collapse it into a menu below `md`.
- [ ] **Connect a team's `owner` to its console team**: membership is
  managed on the team's page, separately from the catalog's CODEOWNERS.
- [ ] **Set the catalog repository on the Admin page** instead of the
  `secretSources.catalogRepo` Helm setting, for the secret-setup guides.
- [ ] **Run forms generated from each action's input schema** (agreed
  2026-10-19). `product.yaml` already declares an input and output JSON
  Schema per action, and the console stores them, but no page builds a
  form from them and no submission is checked against them. Render them
  with `@rjsf/mui` (react-jsonschema-form, MUI theme): labels from
  `title`, help from `description`, `default`, `enum` as selects,
  `pattern`/limits as inline validation, `required`, key/value lists for
  string maps, repeatable rows for arrays. Template parameters use the
  same schema shape, so one renderer serves products and templates. A
  short, validated `x-vertra` hint vocabulary in `product.schema.json`
  for what JSON Schema can't say: `patternMessage`, `options: targets`
  (the owning team's allowed projects or folders for the caller's team),
  `order`, `group`, `widget: textarea`. Never render a secret field
  (secrets come from `secretRefs`); hide inputs a template binds itself.
  The same schema then validates the submission in the console and the
  resolved inputs before a step starts.
- [ ] **Show a product's latest tag** where people build DAGs.
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
     its token fence. Left: keyless bots (with them in the console);
     a read-only database role for it.
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
  Cloud Run backend and a Lambda function URL (2026-10-22). Left:
  keyless bots; a read-only database role for the gateway (it only
  writes api_traffic).

- [ ] **Submit orders from outside the cluster** (a storefront, an event
  bus): a public HTTPS front door for the console's `/api`, keyless sign-in
  for services (OIDC tokens from trusted issuers, mapped to a bot), orders
  rather than raw DAGs, and a decision on who an order is for. kernel-api
  stays private.
- [ ] **Order builder (exploratory):** turn a cart of products into a DAG
  from their schemas. The console stores products' descriptions and wiring
  types already; next, the generator (an `OrderService/PreviewOrder`
  method), then a page.
- [ ] **Base images the platform maintains**: copy approved base images into
  a registry on a schedule, scanned and pinned, for products to build from.
- [ ] **One provider identity per team** for SecretStores: two teams'
  stores must not sign in as the same cloud identity.

## Testing and housekeeping

- [ ] **`vertra catalog publish` from a laptop builds for the laptop's
  platform** (arm64 on a Mac), which an amd64 cluster can't run;
  `DOCKER_DEFAULT_PLATFORM=linux/amd64` works around it. Build for the
  target's platforms (a setting in vertra.yaml, multi-platform with buildx).
- [ ] **`vertra` can't set up a signed catalog yet**: `vertra catalog create` sets
  signing mode none, and nothing puts a public key in the console's
  `catalog.signature` (the GKE proof set it with Helm). Generate or take a
  key (or keyless with the repository's identity) and set both sides.
- [ ] **Another intermittent console test:** `retention.test.ts` failed once
  in a full parallel run (2026-10-22) and passes alone; likely another
  suite's rows meeting its retention cut-off.
- [ ] **An intermittent console test:** `product-ownership.test.ts`'s "is
  claimed at startup for products registered before repositories had
  owners" failed once in a full run (2026-10-20) and passes alone and on
  reruns. It claims every product's repository, so another test file
  registering products in the same database at the same time can race it:
  scope it to its own products, or run that file on its own.
- [ ] **The frontend's two low-severity advisories** (KaTeX, through
  mermaid): `npm audit` offers only mermaid 12, a major version; take it
  when the docs page's diagrams are checked against it.
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

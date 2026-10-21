# TODO

Open work, roughly by area. Before starting something here, check the code:
an item may be partly done. When you finish one, remove it; when you find a
new one, add it. Larger items are worth an issue first, to agree on the
design.

## Installing and operating

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
    template then ships GitLab CI wrappers over catalogctl alongside its
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
generated clients for the frontend, `vertra` and `catalogctl`), the
catalog format version 2, `catalogctl` ported to Go in the CLI's module,
the compatibility check. **Kernel track:** the kernel in Go, Python
removed (done 2026-10-20). **2** Pull-based registration. **3** Roles,
consumers, templates, exports, targets. **4** Schema checks and forms.
**5** Default-deny networking, projected tokens, identity references from
secrets. **6** Kernel features, in Go: retry policy, concurrency keys,
approvals, attempts, `WatchRun`. **7** The console pages. **8** Invoke, bots
with keyless sign-in, per-product protos. **9** Preview, what a run
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
  token rotation, submit and watch); `catalogctl` ported to Go
  (`cli/cmd/catalogctl`; the same verdicts as the Python tool on 37
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
  checked by catalogctl; `catalogctl migrate`, which converted the
  template); the compatibility check (C2: `catalogctl check --changed`
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
  kind cluster (`vertra-local`). `catalogctl migrate` converts a catalog
  from before; `vertra catalog` removes a repository's `ACYCLIX_*`
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
- [ ] **Release `catalogctl` binaries, and pin one in the catalog
  template's `./catalogctl`** (version and per-platform SHA-256). Until
  then the wrapper refuses to run without `VERTRA_CATALOGCTL`, so a
  catalog repository created now (`vertra catalog`) has CI that can't
  run; this checkout's CI and `make catalog-publish` build it from source.
  Needs somewhere public to download from (the platform repository's
  releases once it's public), and a release workflow that builds
  linux/darwin × amd64/arm64 and writes the checksums.
- [ ] **`buf breaking` in CI at the first release**, against the released
  protos: until then contracts change freely (decided 2026-10-19).
- [x] **P0: pull-based catalog registration (M1, S1)** (done 2026-10-20).
  Catalog CI publishes, then `./catalogctl release` pushes the whole
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
  (`TeamService/SetSecretStoreCredential`). The push workflows, catalogctl's
  `teams` commands and every console token in the catalog are gone;
  `delete-team-images` keeps the registry clean-up; `vertra catalog`
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
- [ ] **P1: exports (X2).** Each team lists which of its actions other
  teams' templates may include, and for which teams; checked when a
  template is loaded and at submit.
- [ ] **P1: allowed targets per team (X1).** Which projects, folders or
  accounts each consumer team may aim a team's templates at; forms offer
  only those. Owner identities scoped to the folders they serve, and later
  steps acting on a project an earlier step outputs.
- [ ] **P1: retry policy and idempotency per action (R3)** in
  `product.yaml`; platform failures (a reclaimed node, a lost Job) retried
  for idempotent actions. Default `maxAttempts` is 1 today.
- [ ] **P1: who asked and who acted, per attempt**, and attempts in the API
  (`task_attempts` is stored; the API returns only `attemptCount`).
- [ ] **P1: samples read identity references from team secrets (S2)**,
  not the deployment-wide `GCP_TARGET_SERVICE_ACCOUNT`
  (`TASK_EXTRA_ENVIRONMENT`, `kernel/internal/config`), which gives every team the same
  identity; then drop that setting from the docs.
- [ ] **P1: registry access across clouds (M2)**: an install on another
  cloud reading the catalog's one registry, federated where possible, and
  trusting its signing identity.
- [ ] **P2: readiness per install.** Each product may ship a `check` action
  (who am I, may I do this); the console runs it per install on
  registration and daily, records the principal, and shows what's missing.
- [ ] **P2: caps per product, and schedules** (a template on a cron, run as
  a bot).
- [ ] **P1: roles** (admin, maintainer, consumer), then SSO with groups
  mapped to them.
- [ ] **P1: `visibility` on actions** and "not shared with you" with Ask
  for access, which opens GitHub's prefilled page in the person's browser
  (the console keeps read-only catalog access). New actions are shared
  with their own team only.
- [ ] **P1: approvals.** An owner marks an action, or sharing with a team or
  into a target, as needing approval; the step waits (a new state in the
  kernel) until a maintainer approves or declines, audited; withdrawn after
  3 days.
- [ ] **P1: failure help from the owner.** Error codes with what they mean
  and what to do in `product.yaml`; where to ask for help in `team.yaml`;
  shown on the run page with whether a retry is safe.
- [ ] **P1: concurrency keys.** A product names inputs that identify what
  it changes; the scheduler holds a second step with the same key.
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

- [ ] **Pages for the audit log and image scans**
  (`AdminService/ListAuditEntries`, `ImageService/ListImageScans`), which
  have an API only.
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

- [ ] **`catalogctl publish` from a laptop builds for the laptop's
  platform** (arm64 on a Mac), which an amd64 cluster can't run;
  `DOCKER_DEFAULT_PLATFORM=linux/amd64` works around it. Build for the
  target's platforms (a setting in vertra.yaml, multi-platform with buildx).
- [ ] **`vertra` can't set up a signed catalog yet**: `vertra catalog` sets
  signing mode none, and nothing puts a public key in the console's
  `catalog.signature` (the GKE proof set it with Helm). Generate or take a
  key (or keyless with the repository's identity) and set both sides.
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

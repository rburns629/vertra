# Architecture assessment (2026-10-19)

An assessment of Vertra against what it's meant to become: a Git-governed
marketplace where platform teams publish automation products and anyone in
an organization runs them, reliably and with each team's identities kept to
that team. It compares the kernel with Temporal and Inngest, borrowing their
reliability and usability lessons without their programming models. It
records the agreed direction for the work after the installer CLI.

Everything here was checked against the code on 2026-10-19; file and line
references are to that state. Status words: **built** (implemented and
tested), **partial**, **missing**, **planned** (agreed, not built). The
actionable items are in [`TODO.md`](../TODO.md) under "Agreed direction";
the decisions are summarized in [architecture.md](architecture.md#agreed-direction).

## Contents

1. [Summary](#1-summary)
2. [The intended model](#2-the-intended-model)
3. [What exists today](#3-what-exists-today)
4. [Findings](#4-findings)
5. [Compared with Temporal](#5-compared-with-temporal)
6. [Compared with Inngest](#6-compared-with-inngest)
7. [The Git catalog](#7-the-git-catalog)
8. [Team authorization and secrets](#8-team-authorization-and-secrets)
9. [Cloud identity](#9-cloud-identity)
10. [Hosting and target clouds](#10-hosting-and-target-clouds)
11. [Keeping cloud permissions from creeping](#11-keeping-cloud-permissions-from-creeping)
12. [Which targets a consumer may use](#12-which-targets-a-consumer-may-use)
13. [Golden paths and compatibility](#13-golden-paths-and-compatibility)
14. [The console as a marketplace](#14-the-console-as-a-marketplace)
15. [Execution reliability, traced](#15-execution-reliability-traced)
16. [Before production](#16-before-production)
17. [Decisions](#17-decisions)
18. [Roadmap](#18-roadmap)
19. [The smallest architecture that does it](#19-the-smallest-architecture-that-does-it)
20. [What should not change](#20-what-should-not-change)
21. [Answers in brief](#21-answers-in-brief)

## 1. Summary

The execution core is sound and unusually well defended for a 0.x:
Postgres-only coordination with leases and adoption, deterministic Job names
per attempt, three layers of enforcement (console, admission policies, Pod
hardening and NetworkPolicy), pinned and scanned images, and identities that
come from reviewed `product.yaml` files rather than from whoever submits.
GCP and AWS products are proven on real clusters.

What's missing is mostly the marketplace layer: a consumer who isn't a
member of the publishing team, templates they run with inputs only, forms
built from the schemas teams already write, and one catalog shared by
several installs. Two scheduler defects can run a step twice or lose a
finished step's result, and are first to fix.

Highest priorities, in order:

1. Two scheduler defects (R1, R2).
2. Pull-based catalog registration (M1): several installs can share one
   catalog, and catalog CI holds no console credentials.
3. Owner-bound secret references and a consumer role (A1).
4. Default-deny networking between team namespaces (S3).
5. Federated source identities on hosts that aren't the target cloud (I1;
   I2 waits with Azure).

Azure and GitLab are deferred until the platform and its user experience
are done (decided 2026-10-19).

## 2. The intended model

- **Teams own products and their scope.** A platform team (`gcp-platform`,
  `aws-platform`, `azure-platform`, `onprem-platform`) owns its products,
  their code and releases, its secrets, and the cloud permissions those
  secrets point at. A team's scope is its secrets plus what they reach.
- **Identity references live in team secrets.** The GCP team stores
  service account emails (AWS: role ARNs; Azure: managed identity client
  IDs) as secrets and names them in its own steps. The step's code
  impersonates or assumes that identity, which works wherever the identity
  has rights: a project, a folder, the organization.
- **Consumers run what teams publish.** An engineer from any team (say,
  `azure-apps`) runs a published template, supplying only its inputs, to
  deploy into a project they have or are creating. The template's steps
  then feed each other through the DAG. The consumer never chooses
  identities or secrets and never sees their values.
- **The owning team writes the dependency map** (`dependsOn`) in its
  templates; the service may draft one, never decide it.
- **One catalog, many installs.** The same catalog repository may feed
  several Vertra installs (GKE, EKS, AKS, kind). Each install allows the
  registries it pulls from and binds the catalog's identities to its own
  cloud accounts.
- **Products stay plain containers.** Any language, no SDK: inputs in,
  `result.json` out.

## 3. What exists today

| Capability | Status | Where |
| --- | --- | --- |
| DAG validation: cycles, references, credential-shaped inputs | Built | `kernel/internal/domain/dag.go` |
| Claim, lease, adopt; several schedulers | Built | `kernel/internal/scheduler/claiming.go`, `concurrent_test.go` |
| A Job name per attempt; adopting on conflict | Built | `kernel/internal/executor/kubernetes.go` (`JobName`, `createJob`) |
| Retries with backoff, `maxAttempts` (default 1), timeouts | Built | `kernel/internal/scheduler/tick.go` (`handleFailure`, `poll`) |
| Cancel, idempotent | Built | `kernel/internal/api/service.go` (`CancelExecution`) |
| Append-only event history | Built, shown in the console | `execution_events` |
| History per attempt | Partial: stored in `task_attempts`; the API returns only `attemptCount` | `proto/vertra/kernel/v1/kernel.proto` |
| Running-step caps, platform-wide and per team | Built | `kernel/internal/config/config.go` (`MaxRunning`, `MaxRunningPerTeam`) |
| Caps per product, priorities, fairness | Missing | |
| Inputs checked against `inputSchema` | Missing: structure only | `console/src/core/executions.ts`, `console/frontend/src/dagCheck.ts` |
| Outputs checked against `outputSchema` | Missing | |
| Forms from input schemas | Missing: schemas stored, not rendered | `console/src/db/schema.ts:134` |
| Product versions | Partial: a git-SHA tag plus `latest`; `product_releases` lists images | `cli/internal/catalogctl/publish.go` (`versionTag`, `push`) |
| Schema compatibility, deprecation | Missing | |
| A product's ServiceAccount enforced by policy | Built; proven on EKS 2026-10-19 | `helm/charts/execution-kernel/templates/identity-policy.yaml`, `executions.ts:352` |
| Team secrets chosen per step, enforced twice | Built | `executions.ts:522-546`, identity policy |
| Identity references read from a team secret | Missing: the samples read one deployment-wide variable instead | `TASK_EXTRA_ENVIRONMENT` (`kernel/internal/config`), `catalog-template/samples/gcp` |
| A consumer role; templates with parameters; exports | Missing: running a team's step requires membership of that team | `executions.ts:494-497` |
| Triggers: console, API with bot tokens | Built | `console/src/core/tokens.ts` |
| Schedules, webhooks | Missing | |
| Re-running a stored DAG | Built | execution page |
| Order builder (cart → DAG) | Exploratory: wiring types stored | `wiringTypes` table |
| Several installs per catalog | Missing: one console URL, one token, one registry per repository | `cli/cmd/vertra/catalog.go:261-263`, the catalog's workflows |
| GCP products | Proven | |
| AWS products | Proven 2026-10-19 (not their SecretStore) | |
| Azure products | Unproven, and blocked: AKS Workload Identity needs a Pod label the kernel can't set | |
| A ServiceAccount token in step Pods | Missing: `automountServiceAccountToken: false`, no projected token | `kubernetes.py:594` |
| Default-deny between team namespaces | Missing (documented) | [security-model.md](security-model.md#not-yet-enforced) |
| SSO sign-in | Missing (documented) | same |
| GitLab | Planned | `cli/DESIGN.md` |

## 4. Findings

Each finding: category, severity, confidence; then what happens, why it
matters and what to do.

### Scheduler

**R1. A finished step's result can be lost and the step run again.**
Confirmed defect; high; high confidence. *Fixed 2026-10-20: Jobs are
released after the commit; proven on kind.* `get_status()` reads a finished
Job's result and deletes the Job and its ConfigMap while the scheduler's
transaction is still open, keeping the result only in memory for 15 minutes
(`kubernetes.py:305-310`). If the commit fails and that scheduler then
stops, or its lease passes to another, the next owner finds no Job and
fails the attempt as retryable `JOB_NOT_FOUND` (`kubernetes.py:690-711`).
A step that created a database is then marked failed and its outputs lost;
a retry runs it again. **Do:** delete Jobs only after the commit (on a
later pass, for tasks already finished) or leave them to
`ttlSecondsAfterFinished`, already 3600 (`:646`). **Test:** a commit that
fails after finalizing, then a lease takeover, still ends `SUCCEEDED` with
outputs.

**R2. A failed status read fails the attempt but leaves its Job running.**
Confirmed defect; high; high confidence. *Fixed 2026-10-20: a failed read
leaves the task running; a timed-out one is retried only once its Job is
stopped or past its own deadline. Proven on kind with the scheduler's
permission to read Job status removed: the step stayed running with one
attempt, and succeeded once the permission was back.* When `get_status()` raises (an API
timeout, throttling, an API server restart), the step fails as retryable
`EXECUTOR_STATUS_FAILED` (`service.py:465-478`), its handle is cleared, and
its Job is never stopped (`service.py:546-554`). With retries, a second
attempt runs beside the first; without, the step is marked failed while its
Job may still succeed. A timed-out step's cancel is also best-effort
(`service.py:447-448`). **Do:** treat a failed read as unknown (keep the
step running and its lease renewed; fail only after several failures in a
row), and stop an attempt's Job, confirmed, before any retry. **Test:** a
read that fails once leaves one attempt that succeeds; one that keeps
failing cancels before retrying.

**R3. Platform failures are final by default.** Reliability weakness;
medium. `maxAttempts` defaults to 1, so a reclaimed Spot node or a lost Job
fails the step outright. Right for a product that isn't idempotent; wrong
for one that is, and the platform can't tell which. **Do:** let each action
declare its retry policy and whether it's idempotent in `product.yaml`, and
retry platform failures automatically for idempotent ones.

**R4. A Job can outlive its cancelled execution.** Reliability weakness;
low. *Fixed 2026-10-20: every five minutes the scheduler releases attempts'
Jobs that no task can use; proven on kind.* A Job created in a pass whose commit failed, for a step then
cancelled, runs until its deadline. **Do:** on cancel, delete by the next
attempt's deterministic name, or sweep `ek-` Jobs whose step has finished.

### Security

**S1. The catalog's console token can be read by pull-request workflows.**
High in organizations with several teams. Where GitHub Environments aren't
available (private repositories on a free plan), the catalog's console
token is a repository secret, readable by a workflow anyone with push
access can change on a branch. With it: register an existing image under
another ServiceAccount, apply a SecretStore, retire teams. Cloud publishing
is safe (its trust is pinned to `main`). **Resolved by M1**: with pull-based
registration, CI holds no console credentials at all (done 2026-10-20).

**S2. The samples use one deployment-wide target identity.** Medium. The
GCP samples impersonate `GCP_TARGET_SERVICE_ACCOUNT` from the kernel's
`TASK_EXTRA_ENVIRONMENT` (`config.py:72-76`), so every step of every team
gets the same one. **Do:** read the target from the team secret the step
names (`/platform/secrets/<name>/value`), as the intended model says, and
drop the deployment-wide setting.

**S3. Steps can reach other teams' Pods.** High for production; documented.
**Do:** a default-deny ingress NetworkPolicy in every team namespace,
created with it.

**S4. Reads in a multi-team execution.** Medium; documented. Any member of
one team in a shared execution sees every step's outputs and logs. **Do:**
consumers see status, errors and outputs; each step's logs stay with its
owning team.

### Consumers and the catalog

**A1. No consumer role; secret references chosen by whoever submits.**
Requirements mismatch; high. Running a step in a team requires membership
of that team (`executions.ts:494-497`), and a member can attach any of the
team's secrets to any of its products (`executions.ts:522-546`) and
register new ones. The marketplace model (a consumer runs the GCP team's
steps without choosing its identities) can't be expressed. **Do:** a
consumer role that may run published templates with inputs only; secret
references fixed in the owning team's template.

**M1. One catalog repository serves one install.** Architectural
limitation; high. The catalog's workflows push to one
`VERTRA_CONSOLE_URL` with one `VERTRA_TOKEN`, and `vertra catalog`
overwrites both (`catalog.go:261-263`), so a second install pointed at the
same repository silently takes registrations away from the first. **Do:**
pull-based registration: each console reads `main` (a read-only deploy key
or GitHub App), verifies each image's signature against the catalog's
main-only CI identity, and registers products, templates, teams and
SecretStores itself. CI builds, tests, scans, signs and pushes. Adding an
install changes nothing in the repository. **Done 2026-10-20**, with one
change: consoles read a signed release artifact CI pushes beside the
images, not `main` itself, so an install needs registry access only (see
`TODO.md`).

**M2. One registry per catalog.** Medium. CI publishes to one registry;
other installs pull from it through their allowed sources. An install on
another cloud needs read access to it (federated, or the `vertra-pull`
copy) and must trust the catalog's signing identity.

**M3. Per install: values and bindings; in the catalog: names.** A design
note, and a strength. Secret values, ServiceAccount bindings and target
lists differ per install; the catalog only names them. So "does this
product work here?" is a question per install, answered by a readiness
check (section 12).

**X1. A consumer can aim an owner's identity at the wrong target.**
Security; high. A project ID typed by a consumer, or passed from step to
step, directs the owning team's identity. If that identity has rights over
a folder or the organization, a consumer can point it at someone else's
project. **Do:** scope owner identities to the folders they serve; give
each team a list of allowed targets per consumer team (section 12); have
later steps act on the project an earlier step outputs, not a typed one.

**X2. Any template could include any team's step.** Medium. The team whose
identity does the work should consent. **Do:** each team exports the
actions other teams' templates may include, and to which teams; the console
checks this when it loads a template and again at submit.

**C1. Schemas declared but not enforced.** Missing capability; medium. The
console stores each action's input and output schemas but checks
submissions for structure only, and nothing checks outputs. A bad input
fails minutes later inside the container; a missing output fails the step
after it. Across teams, one service's outputs are another's inputs.
**Do:** check literal inputs at submit; check resolved inputs before each
step starts (the console attaches the schema to the task, so the kernel
checks a schema it's given and stays product-agnostic, failing with
`INPUT_INVALID`); check outputs against the output schema.

**C2. No versions or compatibility checks.** Missing capability; medium.
Other teams' templates depend on a product's outputs. **Do:** `catalogctl
check` compares a product's schemas with its last release and fails on a
removed action, a new required input, or a removed or retyped output,
unless the change is marked breaking; add `deprecated: <message>`.
Meaning can't be checked statically: that's what the product's own test
cases are for.

### Cloud identity

**I1. Steps get no ServiceAccount token.** High for multi-cloud. Without
one, a step can't federate through OIDC (AWS web identity from GKE, AKS or
kind; Entra from GKE or EKS; GCP federation from AKS). Native paths still
work because they bring their own (GKE's metadata server, EKS Pod
Identity's webhook). **Do:** a product declares the token audiences it
needs (`tokenAudiences: [sts.amazonaws.com]`); the kernel adds a projected,
short-lived token for those only; the identity policy allows that volume
and nothing more.

**I2. AKS Workload Identity needs a Pod label the kernel can't set.**
Blocker for Azure; in TODO already.

**D1. Documentation behind the model.** Low. The samples and
[security-model.md](security-model.md) describe a deployment-wide target
identity and team-member choice of secrets; the intended model has
identity references in team secrets, bound by the owning team.

## 5. Compared with Temporal

| Temporal | Vertra | Verdict |
| --- | --- | --- |
| Durable state, crash recovery | Postgres rows, one transaction per pass, leases adopted | Have it |
| Activity fencing | Row locks, `lease_owner`, a Job name per attempt | Have it, once R1 and R2 are fixed |
| Workflow ID reuse | `requestId` | Have it |
| Retry policy per activity | Global backoff; `maxAttempts` per task; `retryable` from the product | Adopt per action, in `product.yaml` (R3) |
| Start-to-close timeout | `timeoutSeconds` and the Job's deadline | Have it |
| Schedule-to-start timeout | None: a ready step can wait indefinitely behind the caps | Adopt: a maximum queued age |
| Heartbeats | None | Adopt lightly: an optional progress line for people, not for leases |
| Event history | `execution_events`, append-only | Have it; add per-attempt records to the API |
| Deterministic replay, SDKs, signals and queries, dynamic workflows, workers | | Avoid: DAGs are data resolved before they run, and an SDK would end language independence |
| Sagas | | Later, if needed: a product's `delete` action, offered in reverse order after a failure, started by a person |

Running a Job isn't provisioning anything: a step can create a resource and
stop before it reports. No scheduler can make that exactly-once; products
that look before they create can, and every sample does.

## 6. Compared with Inngest

| Inngest | Vertra | Verdict |
| --- | --- | --- |
| Run timeline, step status, logs, retry | Execution page: graph, events, logs, durations, retry, re-run | Have most; add attempts |
| Failure classification | `{code, message, retryable}` everywhere | Have it |
| Concurrency keys | Platform-wide and per-team caps | Add per product: one column, one condition in the claim |
| Priorities, fairness | First in, first out | Later: claim round-robin by team |
| Throttling, debounce | | Later; product caps cover cloud API quotas |
| Durable steps | Each DAG step is a checkpoint; outputs kept when a later step fails | Have it; no SDK checkpoints |
| Cron triggers | | Add: schedules that run a template as a bot |
| Event triggers | Bot tokens and the API | API and CI cover it; webhooks with the outside front door (TODO); no event bus |
| Run one function | A one-task DAG | Add: every action is a one-step template with a form |

## 7. The Git catalog

- **Git stays the source of product definitions.** Review, CODEOWNERS,
  history and CI are the collaboration a marketplace needs. Postgres stays
  the source of truth for runtime state; the console keeps an index.
- **One repository, many installs.** One repository keeps one CODEOWNERS,
  one set of workflows and discovery across teams. Several repositories give
  teams autonomy but need per-repository trust and a mapping from team to
  repository. Stay with one; make each console's trust per (repository,
  team folder) so another repository can be allowed for some teams later.
- **Pull, not push** (M1): consoles read `main` and verify signatures.
- **Templates and exports join products** in each team's folder: `dags/`
  templates with parameters; an `exports` list in `team.yaml`.
- **Ownership:** CODEOWNERS is required per team folder and checked. The
  console's team owner isn't linked to it yet (TODO).
- **Provenance:** pinned digests, scans at registration and daily,
  signatures where configured, enforced by admission. Build provenance
  attestation (SLSA) is optional later: a signature from main-only CI
  already says "built from reviewed `main`". A clean scan or a valid
  signature doesn't prove an image harmless.
- **Team lifecycle:** create, retire (reversible), purge (by hand, namespace
  left for an administrator). Not yet traced: what happens to a running
  execution when its team is retired.
- **GitLab:** planned behind the git-host layer.

## 8. Team authorization and secrets

Built and enforced in two layers: a step mounts only Secrets in its own
team's namespace, only ones registered for that team, only if it's a
registered product of that team running as its declared ServiceAccount,
and only as volumes; steps have no API token; the console can write Secrets
but not read them. Cross-team secret access is impossible by construction.

The model going forward:

- **Maintainers** of a team keep today's rights: register secrets, choose
  them per step, write templates (decided 2026-10-17, unchanged).
- **Consumers** run published templates. The template fixes each step's
  `secretRefs`; the consumer supplies parameters.
- **A product trusted to read a secret can misuse it.** Explicit selection
  doesn't stop an approved product from abusing what it's given. The
  controls are review of its code and `product.yaml`, an immutable digest,
  a main-only build identity, review of templates that bind secrets, and
  narrow cloud grants behind each identity reference (section 11).

## 9. Cloud identity

Two layers:

- **Source:** the product's own Kubernetes ServiceAccount, declared in its
  `product.yaml` and bound per install to a cloud identity: GKE Workload
  Identity, EKS Pod Identity, AKS Workload Identity, or OIDC federation on
  other hosts (I1). It holds only the right to act as specific targets.
- **Target:** the identity a team secret names, chosen by the owning team in
  its templates.

The cloud's grant from source to target is the boundary; knowing an email or
an ARN grants nothing.

- **GCP:** `roles/iam.serviceAccountTokenCreator` granted on each target
  service account, never at project or organization level. Product
  identities never get `iam.serviceAccountKeys.create` or `setIamPolicy`.
- **AWS:** the source role may `sts:AssumeRole` on named target ARNs only;
  each target's trust policy names the source role. Pod Identity trust:
  `pods.eks.amazonaws.com`, conditioned on `aws:SourceAccount` and
  `aws:SourceArn` (proven). No wildcard `sts:AssumeRole`; `iam:PassRole`
  scoped with `iam:PassedToService`; permission boundaries on any role a
  product creates.
- **Azure:** a user-assigned managed identity or app registration with a
  federated identity credential whose issuer is the cluster's and whose
  subject is `system:serviceaccount:<team>:<product-sa>`. RBAC scoped to
  resource groups; no product identity with Owner or User Access
  Administrator. A client ID alone authenticates nothing.

Per-product source identities matter: if a team's products share one
source, every product can act as every target the team stores, and a secret
attached to the wrong step works instead of failing.

## 10. Hosting and target clouds

**P**: proven. **F**: possible today in product code. **K**: needs projected
tokens (I1). **W**: needs Pod labels (I2).

| Host ↓ / target → | GCP | AWS | Azure |
| --- | --- | --- | --- |
| GKE | **P**: Workload Identity | **F**: the GSA's Google ID token from the metadata server, then `AssumeRoleWithWebIdentity` trusting `accounts.google.com`; or **K** with the GKE issuer | **F**: a federated credential with issuer `accounts.google.com`; or **K** |
| EKS | **F**: GCP Workload Identity Federation with an AWS provider, from the Pod Identity role | **P**: Pod Identity | **K**: a federated credential on the EKS issuer |
| AKS | **W+K**: federation with the AKS issuer | **W+K**: an IAM OIDC provider for the AKS issuer | **W**: Workload Identity |
| kind | No public issuer: publish its discovery document and keys, then **K**; or a static credential synced from a vault | the same, or IAM Roles Anywhere | the same |

Every **F** path is the product exchanging tokens with its cloud's own SDK:
no broker in Vertra. Static credentials are a documented fallback for local
use, never the default. Only the **P** cells are proven; treat the rest as
supported once each has been run for real.

## 11. Keeping cloud permissions from creeping

Vertra enforces, or will:

- an image runs only as the ServiceAccount its reviewed `product.yaml`
  declares (built);
- one source identity per product, holding only the right to act as its
  targets;
- no deployment-wide identities (S2);
- consumers can't choose identities or secrets (A1);
- changes to what binds which secret are reviewed Git changes (templates);
- each attempt records who requested it and which principal acted, never
  credentials.

Cloud IAM and the organization keep: what each identity may do, trust
scopes, Token Creator, PassRole and role-assignment rights, SCPs and
organization policies. Vertra doesn't provision IAM.

Drift: each product may ship a `check` action (who am I, may I do X); the
console runs it per install on registration and daily and records which
principal answered. A binding changed outside review shows up there.

Granularity: one identity per product by default; per action only where
one action is destructive (`actions[].serviceAccount`, optional); never per
step or per attempt.

## 12. Which targets a consumer may use

Not live discovery: listing projects, accounts or subscriptions needs broad
rights, differs by cloud, and seeing an account doesn't prove a product can
deploy there. Instead:

- **Allowed targets per team**, in the catalog: which projects, folders,
  accounts or subscriptions each consumer team may aim the team's templates
  at. The form fills its choices from this (`options: targets`).
- **Readiness per install**: each product's `check` action, run by the
  console, shown as "checked on (date) as (principal)", or what's missing.
  It's a provisional check, and says so.

The console answers separately: is it published (catalog), may I use it
(exports, consumer role), where (targets), will it work here (readiness).

## 13. Golden paths and compatibility

- **Contracts:** schemas enforced (C1), wiring checked by output and input
  types. Mostly finishing what exists.
- **Who may call whom:** exports (X2), the first and simplest rule.
- **Architecture:** later. Optional `provides` and `requires` tags in
  `product.yaml` (provider, capability, whether it's a runtime dependency)
  and one rule table in the catalog (approved, conditional, blocked per
  pair), checked at submit. No policy engine until a table isn't enough,
  and no rules until there are real products to write them for.
- `dependsOn` is execution order. A runtime dependency (a service using a
  database in another cloud) can only be declared by products, through
  their output types.

## 14. The console as a marketplace

Definitions are managed in Git, runtime in the console; the console shows
definitions with links to them and never edits them.

| Area | Who | What |
| --- | --- | --- |
| Catalog | Everyone | Templates and products by team: inputs, outputs, owner, release, readiness on this install, runnable examples from the product's test cases; Run opens a form built from the input schema |
| Compose | Everyone | Build a DAG from actions shared with you: each input a value or a type-matched output of an earlier step, `dependsOn` filled in from that wiring, the same checks as a template; save as a draft, or propose it as a template (a pull request to the owning team) |
| Runs | Everyone | List with filters and search (including by something a run created); a timeline per run: steps, attempts and their errors, durations, outputs, who asked and who acted, what it created; logs for the owning team |
| Teams | Everyone | Another team's page: what you may use and its readiness, what isn't shared with you (with "Ask for access"), where you may deploy with them, how to get help, how their products are doing |
| Team (own) | Maintainers | Members and roles, secrets, readiness per product with the fix for anything missing, templates and sharing (from Git) |
| Schedules | Maintainers | A template or composition on a timetable, as the team's bot, with saved inputs and a rule for overlapping runs |
| Submit | Maintainers | Raw DAGs, the advanced path |
| Admin | Admins | The catalog connection, sign-in and roles, limits, allowed registries and image scans, notifications, the audit log |

Forms come from the schemas teams already write (TODO, Console). Every
action is a one-step template, so a team is in the marketplace as soon as it
publishes a product. Eleven screens were mocked up on 2026-10-19: Catalog,
run form, run timeline, Compose, own Team, Admin, Runs, Schedules, another
team's page, preview and approval, and a failed step explained.

### Custom DAGs and discovery

- **Secret bindings belong to the action**, in `product.yaml`
  (`actions[].secretRefs`), so an exported action keeps its owner's
  bindings in any DAG. Templates are compositions a team reviewed and
  published; a consumer's own composition is the same thing, unreviewed.
- **Every action is discoverable; not every action is runnable.** Shared
  with everyone: anyone runs it. Shared with some teams: shown to all, with
  "shared with: …". Not shared: shown, marked "not shared with you", with
  "Ask for access". `visibility: hidden`: its own team only.
- **Pull requests come from the person**, never the console: "Ask for
  access" and "Propose as a template" open GitHub's prefilled page in their
  browser, so the console keeps read-only access to the catalog.
- **Steps use a product's latest release**, protected by the compatibility
  checks (C2); every run records the exact digests it used.

### Management

| Area | Where | Who | Rule |
| --- | --- | --- | --- |
| Run state | Kernel database | — | Never edited by hand: every change is an action that records an event |
| Run actions: cancel, retry a step, re-run | Console | The requester for their own runs; maintainers for their team's steps | Retry says whether it's safe, from the action's idempotency |
| Retries | Policy in `product.yaml`; manual in the console | Owners set the policy | |
| What a run created | A `resources` output convention (type, id, link) | — | Vertra records references; it doesn't track infrastructure state. Cleanup runs products' `delete` actions in reverse |
| Users, teams, roles | Console; teams also in Git | Admins, maintainers | Roles: admin, maintainer, consumer; SSO groups map to them. Everyone signed in is a consumer |
| Step logs | Kernel database | The owning team | Consumers see status, errors and outputs |
| Platform logs, metrics, alerts | stdout, `/metrics` | Operators | |
| Audit | Console database, copied to a write-once store | Admins | Every change, by a person or a bot |
| Limits, retention | Settings | Admins | Caps per platform, team and product; runs kept 90 days |
| Notifications | Console | Requesters, owning teams, admins | On failure, on finish, a product not ready, the catalog not pulled |

### What else shapes the experience

In order of value for the work:

1. **Approvals.** An owner marks an action, or sharing with a team or into
   a target, as needing approval; the run waits at that step until a
   maintainer approves or declines (audited); unanswered requests are
   withdrawn after 3 days. Needs a waiting state in the kernel.
2. **Failure help from the owner.** Products declare their error codes with
   what they mean and what to do; teams declare where to ask for help. The
   run page shows the owner's explanation, whether retrying is safe, and who
   to ask.
3. **Preview.** An optional `plan` action reports what a step would create,
   change or leave alone; the form offers Preview, and an approver sees it.
4. **One run per target at a time.** A product declares a concurrency key
   from its inputs; the scheduler holds a second step with the same key.
5. **Runnable examples** from each product's test cases.
6. **Copy as API call** on every form and composition.
7. **Ask for access** on anything not shared with you.
8. **Run again with changes**, open a run in Compose, saved inputs,
   environments with promotion, live updates, success rates, changes between
   releases, find what created something, cost hints, a getting-started
   checklist per role.

Preview, failure help, readiness and cleanup are only as good as the
metadata product teams write; the UI says plainly when a product has none.

### Sleep

A sleeping install can't answer, so scale-down is offered for single-person
and development installs, with that warning in `vertra init`. Schedules
wake the platform (a CronJob can); there's no always-on page.

Onboarding stays short per role: an installer runs `vertra` and, for an
existing catalog, connects to it; a platform team adds its folder, its
secrets and its products, guided by readiness; a consumer signs in, picks a
template, fills a form.

## 15. Execution reliability, traced

| Situation | Behavior | |
| --- | --- | --- |
| Submit | One transaction, idempotent by `requestId` | ✔ |
| Claim | `SKIP LOCKED`, a lease, an attempt row | ✔ |
| Job created, commit fails | The step is claimed again with the same attempt number, so the same Job name, and the Job is adopted | ✔ |
| Scheduler stops after creating | The same | ✔ |
| Create times out but succeeded | Retried a bounded number of times, then adopted | ✔ |
| Lease expires while the old scheduler lives | The old one only loads steps it still owns, locked; a new owner never overlaps a pass | ✔ |
| Job gone before its result is recorded | R1 | ✘ |
| Status read fails | R2 | ✘ |
| Timeout | Best-effort cancel, then retry | R2 |
| Cancel | Marked by the API, Jobs stopped on the next pass | R4 edge |
| Clean-up | Retention sweep hourly; Jobs deleted at once (should wait, R1) or after their TTL | ✔ |

## 16. Before production

1. R1 and R2.
2. M1 (and with it S1).
3. A1, with X1's target scoping.
4. S3.
5. I1 and I2, wherever host and target clouds differ.

Then: SSO sign-in; TLS in the charts; the audit log in a write-once store;
alerts; the scheduler proven at scale on a cloud; a lock file for the
kernel; Azure proven; backups proven per cloud; a ResourceQuota per team.

## 17. Decisions

**1. Postgres stays the only coordinator.** Its claim, lease and history
semantics are correct apart from R1 and R2, which a broker wouldn't fix.
Rejected: Temporal, a message broker, Redis.

**2. Kubernetes Jobs stay the unit of execution.** They bring deadlines,
TTLs and admission control. Rejected: a custom resource and operator, which
would move state out of Postgres.

**3. Identity in two layers.** The source is the product's ServiceAccount,
bound per install and holding only the right to act as specific targets; the
target is an identity reference in a team secret, chosen by the owning team
in its templates. The cloud's grant between them is the boundary. Rejected:
a credential broker; one deployment-wide identity.

**4. Consumers run templates.** A consumer runs a team's published template
with inputs only; templates may include other teams' steps where those teams
export them; the owning team writes the dependencies, and the service may
draft them. Maintainers keep choosing secrets per step.

**5. One catalog, many installs, pulled.** Each console reads `main`,
verifies signatures and registers what it finds; CI holds no console
credentials. Rejected for now: several catalog repositories.

**6. Targets are allowed per team; readiness is checked per install.**
Rejected: discovering accounts and projects live.

**7. Golden paths later, as a rule table in Git.** Rejected: a policy
service or language.

**8. Forms from schemas.** The input schemas teams write drive the form,
submit-time and run-time validation and wiring, with a few `x-vertra`
hints; no custom forms per product.

**9. Bindings in `product.yaml`.** Each action names the team secrets it
uses (`actions[].secretRefs`), reviewed with the code that reads them, so
an exported action keeps its owner's bindings in any DAG. Rejected: a
separate team bindings file.

**10. Steps use the latest release.** Compatibility checks block breaking
changes; each run records its digests. Rejected: pinning releases in
templates, which makes owners chase every template with every fix.

**11. Pull requests from the person's own browser.** The console opens
GitHub's prefilled page and keeps read-only access to the catalog.
Rejected: a GitHub App that can write to the catalog.

**12. Signatures required on cloud installs.** A kind install, whose
catalog publishes unsigned, trusts the registry and `main` instead.

**13. Sleep is for development installs**, and schedules wake them.
Rejected: an always-on page.

**14. Contracts may change freely until a first release.** No
compatibility shims while nobody depends on them.

**15. Azure and GitLab wait** until the platform and its experience are
done (decided 2026-10-19).

**16. The console's API on Connect** (decided 2026-10-20). Protos written by
maintainers; clients generated for the frontend, `vertra` and
`catalogctl`; JSON over HTTP for `curl`, and gRPC for callers that want it,
from the same endpoints. Resources and actions alike are RPCs; health,
metrics, static files and outside webhooks stay plain HTTP. Chosen for its
schema and generated clients, not for speed: neither protocol is the
bottleneck. Rejected: tRPC, which only TypeScript callers can use.
Product actions keep JSON Schema as their source; Invoke is one generic
method, and catalog CI later generates a proto per product (stable field
numbers, protovalidate rules, `buf breaking` as the compatibility check).

**17. The kernel in Go** (decided 2026-10-20), for `client-go`'s informers,
goroutines, static binaries and one language with the CLI; not for speed
(steps are bound by container start, the scheduler by database round
trips). R1 and R2 are fixed in Python first. Then the scheduler is replaced
against the same schema, proven by the existing scenarios, then kernel-api
(on Connect), then the migrations tool; the two processes only share rows,
so each is replaced alone. New kernel features are built in Go. (Done the
same day: one binary, `kernel`, with the Python removed.)

**18. `catalogctl` in Go** (decided 2026-10-20), a binary of its own built
from the CLI's module and sharing its packages, downloaded pinned and
checked by each catalog's `./catalogctl` wrapper in place of today's
virtualenv. Ported while the catalog format changes anyway (Phase 1).

## 18. Roadmap

None of these needs a new service. All contract changes are additive.

**P0: correctness and isolation**

| Item | Changes a contract | Tests | Size |
| --- | --- | --- | --- |
| R1: delete Jobs only after the commit | No | FakeExecutor and kind | S |
| R2: failed status reads aren't failures; stop a Job before retrying | No | FakeExecutor | S–M |
| M1: pull-based registration (resolves S1) | Catalog CI and console | Console tests; a CI run | M |
| A1: consumer role and templates with fixed secret references | Additive (`dags/` parameters, a membership role) | Console authorization tests | M |
| S3: default-deny ingress per team namespace | No | Policy test on kind | S |
| I1 and I2: projected token audiences; Pod labels | Additive (`product.yaml`, kernel setting) | kind, and one proof per cloud | M |

**P1: foundations**

- Inputs checked at submit and before each step; outputs checked (C1).
- Exports (X2).
- Allowed targets per team; owner identities scoped to folders (X1).
- Retry policy and idempotency per action (R3).
- Compatibility checks and `deprecated` (C2).
- Who asked and who acted, on every attempt; attempts in the API.
- Samples reading identity references from team secrets (S2).
- Registry access across clouds (M2).

With A1 in P0: secret bindings per action in `product.yaml`, and rules
for what consumers may do to runs (cancel and retry their own).

**P1 additions**

- Roles (admin, maintainer, consumer), then SSO groups mapped to them.
- `visibility` on actions; "not shared with you" with Ask for access.
- Approvals (a waiting state in the kernel).
- Failure help: error codes in `product.yaml`, help contacts in
  `team.yaml`.
- Concurrency keys per product.

**P2: the marketplace**

- Forms from schemas (TODO, Console).
- Readiness per install.
- Caps per product.
- Schedules.
- Compose, with drafts and Propose as a template.
- The Runs list, run timeline, Teams pages and Admin, as mocked up.
- Preview (`plan` actions).
- The `resources` output convention, what a run created, cleanup.
- Notifications; copy as API call; runnable examples; run again with
  changes.

**P3: later**

- Golden-path rules; runtime-dependency metadata.
- Azure; GitLab; several catalog repositories.
- Environments and promotion; saved inputs; live updates; cost hints.
- Discovering targets; build provenance.

## 19. The smallest architecture that does it

The same pieces as today: the console and its database, kernel-api and the
scheduler and their database, the admission policies, one Git catalog, Jobs.
Everything above is columns, tables, `product.yaml` and `team.yaml` fields,
entries in the policies' lists and console pages.

- **Console:** consumer role, templates, exports, targets, readiness,
  schedules, schema forms and checks, pulling the catalog.
- **Kernel:** deleting Jobs after the commit, read errors, projected tokens,
  attempt history, checking resolved inputs against a given schema.
- **Identity policy:** projected token volumes; secret references bound by
  templates.

## 20. What should not change

- Postgres-only coordination; leases with adoption; a Job name per attempt.
- The kernel knowing nothing of users, teams or credentials, and accepting
  only the console.
- The container contract: files in, `result.json` out, the action as its
  argument, no SDK.
- Identity from reviewed `product.yaml`, enforced by the console and the
  cluster.
- Pinned, scanned and signed images; policies with their lists as CEL
  literals.
- Team, namespace and catalog folder as one name; retire and purge, with the
  right to purge withheld.
- A console that can't read Secrets, creates no RBAC and writes only inside
  its fence.
- Git for definitions, Postgres for runtime state.
- At least once, with idempotent products, said plainly.

## 21. Answers in brief

1. **Git as the catalog?** Yes, with consoles pulling reviewed `main`.
2. **Kubernetes Jobs?** Yes.
3. **Postgres for scheduling?** Yes, once R1 and R2 are fixed and it's
   proven at scale.
4. **From Temporal:** retry policy per action, a maximum queued age,
   per-attempt history, optional progress. Not replay or SDKs.
5. **From Inngest:** caps per product, schedules, forms for single actions,
   the run timeline. Fair claiming later.
6. **Team secrets holding identity references?** Sustainable, with owners
   binding them in templates and consumers never choosing.
7. **AWS and Azure equivalents of GCP impersonation:** a role ARN or managed
   identity client ID in a team secret; the product's ServiceAccount as the
   source (Pod Identity, web identity, Workload Identity Federation); the
   target's trust policy or federated credential as the grant.
8. **Permission creep:** one source identity per product with rights only
   to its targets, owner identities scoped to folders, no deployment-wide
   identities, bindings changed in Git, the acting principal recorded,
   readiness checks for drift.
9. **Which accounts are available:** allowed targets per team in the
   catalog, plus readiness per install. No live discovery.
10. **Golden paths:** exports now; a rule table in Git later.
11. **Five changes before production:** R1 and R2, M1, A1, S3, I1 and I2.
12. **Postponed:** golden-path rules, runtime-dependency metadata, several
    catalog repositories, live discovery, priorities, compensation, GitLab,
    anything shaped like an SDK or an event bus.

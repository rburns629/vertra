# Repository map

Every folder and file in this repository, and what it's for. For how the pieces work together, read [`architecture.md`](architecture.md) and the diagrams in [`architecture/`](architecture/README.md); this page is the index.

The repository holds two independent projects that are deployed together and share no code:

- **`kernel/`** runs DAGs: an API that accepts them, and a scheduler that runs each task as a Kubernetes Job.
- **`console/`** is the authenticated front door: sign-in, teams, secrets, products, and the web UI.

Around them: `helm/` packages both for Kubernetes, with each cluster's settings, and `docs/` explains it all.

```
.
├── kernel/        the execution engine (Go): kernel-api, kernel-scheduler
├── console/       the web console and its API (TypeScript)
├── helm/          Helm charts for both, and each cluster's settings
├── docs/          maintainer documentation and diagrams
├── examples/      demo products (not real catalog products)
├── catalog-template/  what a new catalog repository starts as
├── cli/           vertra, the installer CLI (Go)
├── proto/         the console's API as protobuf (Connect); `make proto` generates its code
├── .github/       CI and security workflows
├── Makefile       everyday commands: run, deploy, logs
└── _local/        your own scratch space (gitignored)
```

## Top level

| Path | What it's for |
| --- | --- |
| `README.md` | What Vertra is, a first example DAG, trying it locally on kind, and how the parts fit together. |
| `LICENSE` | The MIT license. |
| `SECURITY.md` | How to report a vulnerability privately, response times, supported versions, scope. |
| `CONTRIBUTING.md` | Setting up, testing, what a pull request needs, DCO sign-off. |
| `CODE_OF_CONDUCT.md` | Adopts the Contributor Covenant 2.1, and where to report problems. |
| `AGENTS.md` | Guide for AI coding assistants (and a quick orientation for people): layout, core contracts, commands, things that bite, engineering principles. |
| `CLAUDE.md` | One line that imports `AGENTS.md`, so Claude Code reads the same guide. |
| `TODO.md` | The actionable follow-up list: security, access, operations, housekeeping. Check it before starting work. |
| `Makefile` | Everyday commands: `make quickstart` (a local install from nothing), `make up`/`down`/`logs` for the kind cluster, `make kind-deploy*` and `make gke-deploy*`, building the demo products, and `make test`/`test-db`/`test-db-down` (a throwaway test Postgres, separate from any install), and `make proto` (lint the API's protos and generate their code). |
| `.gitignore` | Keeps `_local/`, build output and dependencies out of git. |
| `buf.yaml` | buf's module (`proto/`) and lint rules for the APIs. |
| `buf.gen.es.yaml`, `buf.gen.frontend.yaml`, `buf.gen.go.yaml`, `buf.gen.kernel.yaml` | What `make proto` generates: TypeScript for the console (`console/src/gen/`: its API and kernel-api's, which it calls) and for the frontend (`console/frontend/src/gen/`, the console's API only, JavaScript with type declarations), Go for the CLI (`cli/internal/gen/`, the console's API and the catalog release) and for the kernel (`kernel/internal/gen/`, its own), each from plugins pinned in that project. |
| `proto/vertra/console/v1/` | The console's API as Connect services: one file per service (`execution.proto`'s `ExecutionService` streams `WatchExecution`), and `common.proto` (failures, problems, paging). The API reference page is built from these. |
| `proto/vertra/catalog/v1/release.proto` | A catalog release: every team (with its SecretStore files) and product action of a catalog's `main`, which `vertra catalog release` pushes as an OCI artifact and each console pulls. |
| `proto/vertra/kernel/v1/kernel.proto` | kernel-api's `KernelService`, internal: only the console calls it. |
| `gateway/` | The API gateway (its own section, below). |
| `.semgrep/malicious.yml` | Semgrep rules for code that has no business in a product (running remote code, hidden payloads, reverse shells, mining). Run by `security.yml`. |

## `.github/`: CI

| Path | What it's for |
| --- | --- |
| `workflows/ci.yml` | Every PR: the kernel's `gofmt`, `go vet`, migrations and tests (`-race`), with its kind tests in the kubernetes job; console tests, lint and build; the API's protos linted and their committed generated code checked against `make proto`; Helm lint and render of `helm/values/*`; `actionlint` (this repo's workflows and the catalog template's); the catalog template's checks; building both platform images and scanning them (Trivy, OSV-Scanner). |
| `dependabot.yml` | Weekly, grouped update pull requests (a week's cooldown) for the kernel's and the CLI's Go, the console's npm, every Dockerfile, the workflows, and the catalog template's starters. |
| `workflows/release.yml` | On a version tag: builds both platform images for amd64 and arm64, scans them, pushes them to GHCR, signs them keyless; packages, pushes and signs both charts; creates the GitHub release; builds `vertra` for linux and macOS (amd64, arm64), pushes each binary to GHCR as a blob a catalog's `./vertra` downloads by SHA-256, signs them, and attaches them with their checksums. |
| `workflows/security.yml` | Secret scanning (gitleaks) and code scanning (Semgrep, including `.semgrep/`). |
| `scripts/install-scanners.sh` | Installs pinned, checksum-verified tool binaries (Trivy, OSV-Scanner, gitleaks, actionlint, cosign, oras) for the workflows. |
| `scripts/pin-vertra.sh` | Pins a released `vertra` in a catalog's `./vertra` (default `catalog-template/vertra`): its version and each platform's SHA-256 from the release, after checking each downloads anonymously and matches. |
| `scripts/catalog-template.sh` | Runs `vertra catalog` (vertra built from this checkout) in `catalog-template/` with its samples (all, or `SAMPLES=`) installed as teams: CI's `validate` and `check`, and `make catalog-publish`'s `publish -- release` (commands separated by `--` run in the same assembled catalog). |
| `scripts/build-vertra.sh` | Builds `vertra` for this machine in the pinned Go image (no Go needed) into `cli/bin/`, and prints its path, for `VERTRA_BIN`. |
| `scripts/scan-image.sh` | Scans one built platform image and fails if it must not ship (fixable high or critical vulnerabilities, and more). |
| `ISSUE_TEMPLATE/bug_report.yml`, `feature_request.yml` | Issue forms for bugs and feature requests. |
| `ISSUE_TEMPLATE/config.yml` | Turns off blank issues and points security reports to private reporting. |
| `pull_request_template.md` | What every pull request describes, and its checklist. |

## `kernel/`: the execution engine

Go (pgx, client-go, Connect). One binary, `kernel`, run as processes that never call each other and meet only in Postgres: **kernel-api** (`kernel api`), **kernel-scheduler** (`kernel scheduler`), the migration hook (`kernel migrate`) and the sleeper (`kernel sleep`). Python until 2026-10-20 (decision 17 in `docs/assessment.md`). The package rules and a call-by-call trace are in [`ARCHITECTURE.md`](../kernel/ARCHITECTURE.md).

| Path | What it's for |
| --- | --- |
| `README.md` | What the kernel is and how to run and test it. |
| `ARCHITECTURE.md` | The package rules, and a call-by-call trace of submit → claim → dispatch → poll → finish. |
| `go.mod`, `go.sum` | The kernel's Go module (`github.com/rburns629/vertra/kernel`). |
| `Dockerfile` | The image: a Go stage builds the binary; it runs on distroless (no shell) as a non-root user. |
| `.dockerignore`, `.gcloudignore` | Keep test binaries and local files out of the image and the Cloud Build upload. |
| `cmd/kernel/main.go` | The binary: `api`, `scheduler`, `migrate`, `sleep [--now]`, and for the chart `wait-for-postgres` (init containers) and `check-heartbeat` (the scheduler's liveness probe). |
| `internal/config/config.go` | Every setting, for every process, read from the environment (the chart's ConfigMap) and checked at startup. |
| **`internal/domain/`** | **The rules, with no I/O.** |
| `internal/domain/states.go` | Task and execution states, the retry rule and its backoff. |
| `internal/domain/dag.go` | Checks a DAG before it's stored: duplicate ids, unknown or repeated dependencies, cycles, `$fromTask` references, credentials in inputs; topological order. |
| `internal/domain/schema.go` | A product's input or output schema, as the console attaches it to a task: compiled (nothing outside it fetched) and checked against values. |
| `internal/domain/result.go` | `result.json`, what a product writes, parsed strictly; the structured error. |
| `internal/domain/task.go` | Step sizes; `{"$fromTask", "$output"}` references and resolving them; the `request.json` a product reads. |
| `internal/domain/credentials.go` | Recognizes credential shapes: redacts them from logs and error messages, fails outputs that hold one, refuses inputs that do. |
| `internal/domain/events.go` | The event types recorded for an execution. |
| **`internal/api/`** | **kernel-api.** |
| `internal/api/service.go` | `KernelService`: submit (idempotent by `requestId`), read an execution, its states, events and logs, cancel, retry a task. |
| `internal/api/stats.go` | What the steps did, from the kernel's tables, for Observe's Metrics tab: started and p95 wait by hour, failures by code, step times by image and action, ready and running now. |
| `internal/api/refusals.go` | The attempts the cluster refused to start (admission policies' codes) since a time, for Observe. |
| `internal/api/approvals.go` | Approving or declining a task awaiting approval, and listing a team's awaiting tasks. |
| `internal/api/auth.go` | Accepts only the console: checks its ServiceAccount token with a TokenReview. |
| `internal/api/server.go` | The HTTP server: the service, health, metrics, and every request logged and measured. |
| **`internal/executor/`** | **Running a task.** |
| `internal/executor/executor.go` | The `Executor` interface and the types passed through it. |
| `internal/executor/kubernetes.go` | The one executor: creates the Job and its `request.json` ConfigMap (adopting an attempt's Job, reporting a policy's refusal), reads status and the termination message, catches image-pull failures, removes a finished Job once released. |
| `internal/executor/watch.go` | Informers on the kernel's Jobs and Pods: wake the loop on a change, and skip re-reading a step that hasn't changed. |
| `internal/executor/executortest/` | `Fake`: an in-memory executor, to test the scheduler without a cluster. |
| **`internal/scheduler/`** | **The scheduling pass and the loop.** |
| `internal/scheduler/tick.go` | One pass: expire undecided approvals, claim, start each task, poll running ones, save results, retry or fail, release dependents, finish executions. |
| `internal/scheduler/claiming.go` | Takes READY tasks with `FOR UPDATE SKIP LOCKED` and a lease, within the running caps; recovers tasks whose lease expired; releases a stopping scheduler's leases. |
| `internal/scheduler/rows.go` | The task and attempt rows, events, and compare-and-set execution transitions. |
| `internal/scheduler/run.go` | The loop: a pass per transaction, finished Jobs released after the commit (held `ReleaseAfter` first, for the log collector), housekeeping, the queue gauges (`kernel_tasks`, the oldest ready task's age), the heartbeat, leases released on stop. |
| `internal/scheduler/retention.go` | Deletes finished executions past their retention (with everything of theirs). |
| `internal/scheduler/orphans.go` | Every few minutes, removes attempts' Jobs no task can use any more (a pass that rolled back, a release that failed, a deleted execution). |
| **`internal/migrate/`** | **The schema.** |
| `internal/migrate/sql/` | One SQL file per change, applied in order, each once: `0001_initial_schema.sql` (every table at the first public release), then one file per later change. A released file never changes. |
| `internal/migrate/migrate.go` | Applies them under an advisory lock, recorded in `schema_migrations`; takes over an install Alembic migrated; what kernel-api and the scheduler wait for. |
| `internal/sleeper/sleeper.go` | The sleeper: one look, and if the platform is idle, the counts to wake to recorded and every Deployment scaled to zero (the databases last), the wake CronJob armed for the console's next schedule; and `Wake` (`kernel wake`), which brings it back. |
| `internal/logging/`, `internal/metrics/` | JSON logs; the Prometheus metrics. |
| `internal/gen/` | `KernelService`'s generated Go (`make proto`). |
| `internal/dbtest/`, `internal/kindtest/` | For tests: the test database and throwaway ones; the current kind cluster and test images (`kindtest/fixture/`: a test-only product that crashes, sleeps or fails on demand). |
| `*_test.go` | Beside each package: against the real, migrated test database (`TEST_DATABASE_URL`), client-go's fake clientset, or (`TestKind*`) a real kind cluster, skipping without one or failing when `KERNEL_TESTS_REQUIRE_KUBERNETES=1` (CI). |

## `console/`: the console and its API

TypeScript, Fastify 5, Drizzle (Postgres), `@kubernetes/client-node`. One process serves the API under `/api` and the React app, from one origin.

### Project files

| Path | What it's for |
| --- | --- |
| `package.json`, `package-lock.json` | Backend dependencies and scripts (`dev`, `build`, `typecheck`, `lint`, `test`, `db:*`). |
| `tsconfig.json`, `eslint.config.js` | TypeScript and lint settings. |
| `drizzle.config.ts` | Where the schema and migrations are, for `npm run db:generate`. |
| `vitest.config.ts` | Test settings, including the test database. |
| `Dockerfile` | Builds the backend and frontend into one image, with `docs/` copied in. Runs as a non-root user. |
| `.gcloudignore` | Keeps local files out of the Cloud Build upload. |

### `console/scripts/`

| Path | What it's for |
| --- | --- |
| `api-reference.ts` | Turns the protos (a `buf build` image, comments included) into the API reference's data, `frontend/src/gen/api-reference.json`; run by `make proto`. |

### `console/src/`: the backend

| Path | What it's for |
| --- | --- |
| `gen/` | Generated from `proto/` by `make proto`; never edited (and not linted). |
| `index.ts` | Builds the app: the global error handler (hides server errors' details), auth, rate limits, every route under `/api`, the static frontend. |
| `config.ts` | Every setting, read and checked once at startup. |
| `k8s.ts` | **Every write to Kubernetes:** product ServiceAccounts (create-only), Secrets, ExternalSecrets, removing the per-secret Roles older versions made, the image policy; also reads namespaces, SecretStores and task Pods. Security-sensitive. |
| `kernel/client.ts` | Calls kernel-api's `KernelService` over Connect (with the console's projected ServiceAccount token): submit, read, states, events, logs, cancel, retry. Turns a DAG's JSON into the request strictly, under the names the console checked, and kernel-api's refusals into the statuses the console relays. |
| `imagePolicy.ts` | The allowed image sources: the same matching rules as the cluster's image policy, and reading and saving it. |
| `imageRef.ts` | Reading an image reference the way the kubelet does (`normalizeImage`, `imageRepository`); pure, used by the image policy and repository ownership. |
| `secretStores.ts` | What a team's SecretStore file may hold, checked before the console applies it (`PUT /teams/:team/secret-store`): the same rules as the catalog's own check. |
| `scanning.ts` | Scanning every image before it's registered or run: a Trivy client Job per digest, verdicts in `image_scans`, daily rescans, the failed digests written into the kernel's scan policy; idling the Trivy server when no scan is wanted. |
| `activity.ts` | Records when the console was last used (any signed-in request, once a minute at most) for the kernel's sleeper. |
| `audit.ts` | Who changed what: every changing `/api` request, allowed or refused, recorded in `audit_log`, hash-chained, and logged (never a secret value, password or token). |
| `metrics.ts` | The console's Prometheus metrics (Connect calls by procedure and code, catalog syncs, image scans, the process), on a port of their own. |
| `auditExport.ts` | The audit log's write-once copy: every few minutes, new entries, their hash chain checked, to a GCS or S3 bucket that refuses deletes and overwrites. |
| `catalogSync.ts` | Pulls the catalog's release (its tag, or the newest version) every few minutes (and on Sync now), verifies its signature with a cosign Job, and applies it: teams, products, SecretStores; unregisters and retires what it drops; leaves teams it didn't make alone until an admin adopts them. |
| `jsonSchema.ts` | Checking values against the JSON Schemas teams write (ajv, draft 2020-12, nothing fetched): template parameters and products' inputs. |
| `tokenAudiences.ts` | Which audiences a product's steps may get a projected token for: refuses the Kubernetes API's (from the console's own token) and kernel-api's, and names each token's file. |
| `policySync.ts` | Rewrites the identity and scan policies and the teams' pull Secrets every few minutes, so drift doesn't last; keeps each sync's outcome for admins. |
| `logLevels.ts` | Who sees which of a step's log lines: INFO to everyone who can see the run, the rest to the step's team. |
| `registryFederation.ts` | Reading a Google Artifact Registry from another cloud: the console's projected token exchanged at Google's STS (Workload Identity Federation), and the Docker config it hands out. |
| `pullSecret.ts` | Copies the platform's registry pull Secret into every team namespace (`vertra-pull`), for steps' images in private registries. |
| `failureHelp.ts` | What a failed step's error means, what to do, whether a retry is safe and whom to ask: the owner's words, else the platform's. |
| `targets.ts` | Allowed targets (X1): which projects, folders, accounts or subscriptions another team may aim a team's products at, from its `allowedTargets`. |
| `teamNetwork.ts` | Keeps the default-deny NetworkPolicy (`vertra-default-deny`) in every team namespace, so teams' steps can't reach each other. |
| `retention.ts` | Deletes, hourly, submitted-execution records, audit entries and unused scan verdicts past their retention. |
| `notifier.ts` | Notifications: making each event once (a run that failed or finished, a step waiting for an approval, the catalog not pulled, a product not ready, a step the cluster refused, a platform alert), fanning it out to inboxes, email (SMTP, the kinds each person chooses) and teams' chat webhooks, and sending those (webhook URLs encrypted, allowed hosts only). |
| `readiness.ts` | Whether each product is ready on this install: runs its check action (as the console, as the product) when it's new or changed, daily or on Check now, and records the answer. |
| `scheduleRunner.ts`, `cron.ts` | Starting teams' schedules when they're due, each as its bot (claimed by moving its next run on, so one console starts it), and the cron expressions they use (five fields, IANA time zones). |
| `resourceRecorder.ts` | Every 30 seconds, copies what finished runs' steps reported as `resources` (with each step's inputs and outputs) into the `resources` table, and marks what cleanup runs deleted. |
| `productPolicy.ts` | Writes the registered products into the cluster's identity policy, after every product change and at startup. |
| `registry.ts` | Asks a container registry whether an image still exists, before a run, pins tags to digests, and fetches the catalog's release (digest-checked) and lists its tags, for its newest version. |
| `apiError.ts` | `ApiError`: a refusal (HTTP status, stable code, message, Connect code, extra fields) thrown by `core/` and turned into a Connect error (its code, a `Failure` detail with any extra fields) by Connect's interceptor. |
| `guides.ts` | The guides in `console/docs/`: listing and reading them (`GuideService`). |
| **`core/`** | **What the API does**, one file per area, called by the Connect services: each function takes the caller, checks access, does the work, and throws `ApiError` to refuse. |
| `core/executions.ts` | Submitting (team, identity, secret, image and scan checks, pinning, ServiceAccounts), listing, reading, events, logs, cancel, retry, rerun. |
| `core/teams.ts` | Teams and members, their namespaces, retiring, restoring and purging, SecretStore files, running task Pods. |
| `core/secrets.ts`, `core/products.ts`, `core/images.ts` | Team secrets and their sources; the product registry, repository ownership and wiring types; the image policy and scan verdicts. |
| `core/users.ts`, `core/tokens.ts`, `core/admin.ts` | Accounts; bot and automation tokens; platform counts, the audit log, policy sync. |
| `core/templates.ts` | Templates: what a person may run (templates and shared actions), running one with parameters only, each step built from its product; reruns of a template's run; previews (runs of plan actions) and cleanup runs. |
| `auth/keyless.ts`, `core/botIdentities.ts` | Keyless bots: a CI's ID token exchanged for a bot's hour-long session (AuthService/ExchangeToken), and which CI identities sign in as which bot (TokenService). |
| `core/schedules.ts` | `ScheduleService`: a team's schedules (members see, maintainers make, pause and delete), checked as their bot. |
| `core/sso.ts` | `SsoService`: single sign-on as admins set it (the provider unless the install set it, its discovery checked, its secret write-only), where groups come from, and groups mapped to teams. |
| `core/drafts.ts` | `DraftService`: Compose's drafts, kept for their team (its members and admins), bounded, each save conditional on the version it changed. |
| `core/notifications.ts` | `NotificationService`: your inbox, and your teams' chat webhooks (members see, maintainers set, test and remove). |
| `core/resources.ts` | What runs made (`ResourceService`): who sees and deletes each resource, and deleting them by running their products' cleanup actions, newest first. |
| `core/runView.ts` | How much of a run a caller sees: its owners every step; a provider team's member only its own steps in full (the rest: state and failure codes). |
| `core/logs.ts` | Observe's log search over Loki, each query carrying the caller's visibility: a step's lines to its team, its INFO to anyone who may see its run, the platform's to admins. |
| `core/observe.ts` | Observe for everyone: the security checks (what this install enforces and doesn't yet, what the cluster refused this week, a run linked only for those who may see it, every image allowed to run and its scan), the metrics (from kernel-api's `GetStats`, each image named by its product, a hidden one only for its team), and the audit log as each caller may see it (`listAudit`). |
| `core/apis.ts` | API products: who sees and may call each, whether it's live, held (its backend's host isn't allowed) or paused, and pausing one. |
| `core/approvals.ts` | Approvals: a maintainer of a step's team, never whoever ran it, approves or declines it; the steps awaiting one. |
| `core/retired.ts` | The shared "this team is retired, it's read-only" refusal. |
| **`rpc/`** | **The API**: Connect services from `proto/`, at `/api/vertra.console.v1.<Service>/<Method>`. |
| `rpc/server.ts` | Mounts every service on Fastify with `@connectrpc/connect-fastify`, resolving each call's caller from its bearer token. |
| `rpc/interceptors.ts` | Masking unexpected errors as `internal`, auditing every changing call (with the run it started), requiring a caller outside the public methods. |
| `rpc/errors.ts`, `rpc/context.ts`, `rpc/validate.ts`, `rpc/rateLimit.ts`, `rpc/convert.ts` | Connect errors with `Failure`/`Problem` details; the caller, log and request in the handler context; checking requests against REST's TypeBox schemas; fixed-window rate limits; timestamps. |
| `rpc/services/*.ts` | One file per service in `proto/vertra/console/v1/`, each mapping messages to and from `core/`. `execution.ts` also streams `WatchExecution` (re-reading and re-authorizing every 2 seconds). |
| **`auth/`** | **Who's calling.** |
| `auth/plugin.ts` | Checks every request's session or bot token and loads the caller's teams and admin flag. |
| `auth/oidc.ts` | Single sign-on (any OpenID Connect provider): the authorization code flow with PKCE, the ID token's checks, each account bound to its provider identity once, then its groups and mapped teams (`sso.ts`). |
| `sso.ts` | Single sign-on's settings in effect (the install's, else admins', read every few seconds); a person's groups (the ID token's claim, Google Workspace's Groups API); mapped teams following them at each sign-in. |
| `teamQuota.ts` | Each team namespace's ResourceQuota and LimitRange: its own limits (an admin's) or the install's, written with the namespace and on every policy resync. |
| `sealed.ts` | Values the console keeps and uses itself (webhook URLs, the SSO client secret), sealed with AES-256-GCM under a key derived from `JWT_SECRET` per purpose. |
| `auth/access.ts` | The authorization rules: who may act for a team, and see (any of its teams) or cancel (every team) an execution. |
| `auth/password.ts` | Password hashing (argon2), and the dummy check that makes failed logins take the same time. |
| `auth/apiToken.ts` | Bot and automation tokens (`mp_…`): generating and hashing them. |
| `auth/scopes.ts` | Platform-wide permissions for automation tokens (`teams:create`, `products:register`, …). |
| `auth/loginThrottle.ts` | Slows down repeated failed logins. |
| **`db/`** | **The console's Postgres.** |
| `db/schema.ts` | The tables: teams, users, memberships, tokens, products and releases, secret grants, submitted executions, wiring types. |
| `db/queries.ts` | Every database query the routes use. |
| `db/client.ts` | The database connection. |
| `db/migrate.ts` | Applies migrations and creates the first admin; run by the migration Job on deploy. |
| `db/bootstrapAdmin.ts` | Creates the first admin once: a generated password is printed once and must be changed at the first sign-in; one the operator set isn't. |
| `db/resetAdmin.ts` | Gives an admin a new random password from inside the console's Pod (`vertra admin reset-password`): printed once, every session revoked, audited. |
| `db/migrations/` | The schema: `0000_initial_schema.sql` (every table at the first public release), then one SQL file per later change, generated by `npm run db:generate` (`0002_catalog_sync.sql`: the catalog release applied, and which teams and products it made; `0003_token_audiences.sql`; `0004_templates.sql`: templates, and which template a run came from; `0005_team_roles.sql`: maintainer or member; `0006_visibility.sql`; `0007_allowed_targets.sql`; `0008_retries.sql`; `0009_concurrency_keys.sql`; `0010_failure_help.sql`; `0011_approvals.sql`; `0012_apis.sql`; `0013_gateway_traffic.sql`; `0014_oidc_subject.sql`: each account's single sign-on identity; `0015_team_require_sso.sql`: a team requiring it; `0016_must_change_password.sql`; `0017_audit_chain.sql`: the audit log's hashes and its copy's progress; `0018_last_signed_in.sql`: each account's last sign-in; `0019_audit_broken_at.sql`: where the audit chain broke; `0020_resources.sql`: what runs made, and products' cleanup; `0021_notifications.sql`: notifications and teams' chat webhooks; `0022_plans.sql`: products' plan actions, for Preview; `0023_readiness.sql`: products' checks and their answers; `0024_schedules.sql`: teams' schedules; `0025_bot_identities.sql`: bots' keyless identities; `0026_examples.sql`: actions' examples, from their tests; `0027_email.sql`: notifications by email; `0028_drafts_and_template_examples.sql`: Compose's drafts, and templates' examples; `0029_sso_settings.sql`: single sign-on as admins set it, and groups mapped to teams; `0030_team_quota.sql`: a team's own resource limits; `0031_catalog_version.sql`: the catalog version applied; `0032_secret_store_identities.sql`: the cloud identity each team's SecretStores sign in as; `0033_alerts.sql`: refusals and platform alerts emailed by default; `0034_admin_channel.sql`: the team whose webhook gets admins' alerts); `meta/` is drizzle's bookkeeping. |

### `console/frontend/`: the web app

React 19, MUI, Vite, react-router. Its own `package.json`.

| Path | What it's for |
| --- | --- |
| `src/gen/` | Generated from `proto/` by `make proto` (JavaScript with type declarations); never edited. |
| `index.html`, `src/main.tsx` | The page and the app's entry point. |
| `src/App.tsx` | The routes; each page loads only when first opened. |
| `src/app.test.tsx` | The whole app over a fake console API: every page renders, Admin only for admins, the sign-in rules (signed out, single sign-on offered, a password to change first, an expired session), a retired team read-only. |
| `src/api.ts` | Every call to the backend, with its types: plain objects over the generated Connect clients (`src/gen/`), so pages never see the messages. |
| `src/theme.ts`, `src/index.css` | MUI theme and base styles. `theme.ts` holds every color and the mono font as named tokens (`sidebar.*`, `code.*`, `fontFamilyMono`), plus the focus ring and reduced-motion rules. |
| `src/dagCheck.ts` | Checks a pasted DAG live on the Submit page (JSON or YAML) and explains what's wrong. Tested in `dagCheck.test.ts`. |
| `vitest.config.ts`, `src/**/*.test.ts` | The frontend's tests (`npm test`); a test that renders opts into jsdom. |
| `src/dagLayout.ts` | Arranges a DAG's tasks into columns for the execution graph. |
| `src/time.ts` | Durations and times as people say them ("8m 05s", "today 14:02"), and a clock that ticks while something runs. |
| `src/statusColor.ts` | Each state's color and label, shared by the status chips and the home charts. |
| `src/auth/` | The signed-in user (`AuthContext`) and the guard that sends signed-out visitors to the login page. |
| `src/layout/` | The sidebar (the install, the places, your account and its settings menu; a top bar opens it on a phone), and `SignInLayout`, the screens before it (signing in, registering, choosing your own password). Old addresses (`/executions`, `/run`) redirect in `App.tsx`. |
| `src/environment.tsx` | The install's public settings (its label, open registration, single sign-on), fetched once for the whole app. |
| `src/components/` | Shared pieces (`Pill`, the tinted label every state and status uses; `ErrorPage`: not found, admins only, and the error boundary around each page; `CodeBlock`: commands and snippets with a copy button): tables, page headers, status badges, metric cards, team cards, empty states, confirm dialogs, inline monospace (`Mono`). |
| `src/pages/HomePage.tsx` | Home: your runs that are going, how your last two weeks went, the steps waiting for you to approve, and your teams. |
| `src/layout/NotificationBell.tsx` | The bell (the sidebar, or the top bar on a phone): how many notifications are unread, the newest, opening one goes to what it's about. |
| `src/pages/team/WebhookSection.tsx` | A team's chat notifications on its Settings tab: its webhook's host and state; maintainers set, test and remove it. |
| `src/components/ReadinessPill.tsx` | Whether a product is ready on this install (its check): Ready, Not ready, Check failed, Checking or Not checked yet, with what's missing on hover. |
| `src/pages/catalog/ScheduleDialog.tsx`, `src/pages/team/SchedulesTab.tsx` | Scheduling a run from its form (when, time zone, the team's bot), and a team's schedules on its Schedules tab (pause, delete, last start). |
| `src/pages/ComposePage.tsx`, `src/compose.ts` | Compose (`/catalog/compose`): a template built from shared actions, inputs wired by type (`x-vertra-needs`, `x-vertra-provides`), proposed to the catalog as a file (GitHub's new-file page) or run now when it's all the person's team's. |
| `src/pages/useComposeDrafts.ts` | Compose's drafts, kept by the console for their team: saved a second after a change, each save naming the version before it; a rename moves the draft; a conflict waits for the person; drafts a browser kept move over. Tested alongside. |
| `src/pages/team/KeylessSection.tsx` | A bot signing in from CI with no token, on its Automation card: its identities, adding one (GitHub Actions, GitLab), the job's snippet. |
| `src/pages/team/TeamOffers.tsx` | A team as anyone signed in sees it (its page, for those not in it; its members' What it offers tab): where to ask it, and its templates, actions and APIs, with sharing and readiness. |
| `src/pages/account/EmailSection.tsx` | Preferences' Email card: which notifications come by email too (when the install sends email). |
| `src/components/PreviewResult.tsx` | What a preview run says each step would do (its plan action's summary and changes), followed until it finishes; on the run form and an approval. |
| `src/pages/ResourcesPage.tsx`, `src/components/ResourceTable.tsx` | What runs made (`/runs/made`): every resource your teams' runs (and yours) reported, searchable, kept after the runs are gone, with Delete where its product says how. |
| `src/pages/ExecutionsListPage.tsx` | Runs (`/runs`): every run you can see, a page at a time (yours, or by team and name, filtered on the server), each with what it ran, its steps' progress and how long it took; and the steps waiting for your team to approve. |
| `src/pages/useExecutionWatch.ts` | Follows one execution over `WatchExecution` until it finishes, with its events and logs; reopens a stream that ends or drops, backs off when it can't connect; `resume()` after a retry or cancel. Tested alongside. |
| `src/pages/SubmitExecutionPage.tsx` | Paste or write a DAG, with live checking. |
| `src/pages/ExecutionDetailPage.tsx`, `src/pages/run/` | One run: who started it and from what, its steps against time (`RunTimeline`), why it failed (`FailureCard`, `FailureHelp`), what it made (`WhatItMade`, with Delete all), and the chosen step (`StepPanel`: its approval, attempts, outputs, inputs, logs (`StepLogs`), definition, and who acted); retry, approve, cancel, run again. |
| `src/pages/ProductsPage.tsx` | The product registry, by platform, with releases. |
| `src/pages/ObservePage.tsx`, `src/pages/observe/` | Observe, a tab per file (`?tab=`): the security checks (what's enforced, what was refused this week by the cluster, the catalog or the gateway, every image that may run and its scan), the metrics, log search, and the audit log (with whether its chain held). |
| `src/pages/ApisPage.tsx`, `src/pages/ApiPage.tsx`, `src/pages/api/`, `src/pages/team/ApisTab.tsx` | API products: every one you may see, and one API's page: Overview (its endpoints and how to call them) for anyone who may see it; Traffic and Definition (what its api.yaml says, what the gateway does with a request, and pausing it) for its own team. The tab is in the address (`?tab=`). |
| `src/pages/TeamsPage.tsx`, `TeamPage.tsx` | Your teams (an admin, every team), and one team's page: its tabs, the chosen one in the address (`?tab=`). |
| `src/pages/team/` | The Team page's tabs: members, secrets (adding one, connecting a cloud source, a SecretStore's stored credential in `StoredCredential.tsx`), automation (bots), running tasks. `providers.ts` describes each secret provider for the "Connect a source" wizard. |
| `src/pages/team/SettingsTab.tsx`, `QuotaSection.tsx` | A team's Settings: requiring single sign-on (and who it would lock out), its resource limits (admins set them), where the team comes from, and for an admin retiring, restoring and purging it. |
| `src/pages/CatalogPage.tsx` | The Catalog (`/catalog`): every template and action, as cards: what each asks for, Run, or, when it isn't shared with you, Ask for access; by team, and only what you can run. |
| `src/pages/RunFormPage.tsx`, `src/pages/catalog/FieldInput.tsx`, `src/schemaForm.ts` | Running one (`/catalog/run?template=` or `?action=`): a form from its schema (text, numbers, yes/no, choices, lists, name/value pairs, JSON; checked on each field before sending; ordered and grouped by its form hints), which of your teams it's for, and what will run. |
| `src/pages/AdminPage.tsx`, `src/pages/admin/` | Admin (admins only), in tabs (`?tab=`): Overview (getting a new install ready, this install's version and which optional parts are on, the catalog, the cluster's policies, the audit log's copy, image sources, the team whose chat webhook gets admins' alerts), People (how people sign in, single sign-on's provider and groups mapped to teams (`SsoCard.tsx`), adding them, everyone with how they sign in and when they last did, admin rights, password resets, deletes; automation tokens), Image scans (every digest's verdict and findings, rescanning one, accepting a failure with a reason), and the API gateway (its settings, closing it). |
| `src/pages/AccountPage.tsx`, `ChoosePasswordPage.tsx`, `src/components/PasswordChangeForm.tsx` | Preferences (`/account`): who you are, how you sign in (a password to change, or single sign-on), your teams; and the screen a password someone else set holds you on until you choose your own. |
| `src/pages/DocsPage.tsx`, `ApiReference.tsx` | The guides from `console/docs/`, and the API reference (from `src/gen/api-reference.json`, which `make proto` writes from the protos). |
| `src/pages/LoginPage.tsx`, `RegisterPage.tsx` | Sign-in and registration. |
| `public/favicon.svg` | The browser tab icon. |
| `vite.config.ts`, `tsconfig*.json` | Build settings. |

### `console/docs/`: the in-console guides

Shown on the console's Docs page, in file order. They ship inside the console image.

| File | Guide |
| --- | --- |
| `01-getting-started.md` | Try Vertra end to end: a platform, a product, a DAG. |
| `02-sync-secrets-gcp.md` | Syncing secrets from GCP Secret Manager. |
| `03-what-is-a-dag.md` | DAGs, `dependsOn` and `$fromTask`. |
| `04-secrets-explained.md` | How secrets stay locked to one product. |
| `05-calling-the-api.md` | Calling the API from a pipeline with a bot token. |
| `06-database-schemas.md` | Every table in both databases. Tests in both projects keep it in step with the code. |
| `07-how-data-moves.md` | One real value followed from one task to the next. |
| `08-under-the-hood.md` | Every unusual use of Kubernetes, Helm and Postgres, and why. |

### `console/test/`

Run against a real, migrated Postgres (`execution_console_test`).

| File | What it covers |
| --- | --- |
| `auth.test.ts`, `accounts.test.ts` | Sign-in, sessions, password changes and resets, login throttling. |
| `executions-auth.test.ts` | Who may submit what: teams, identities, team secrets, images, `requestId`. |
| `kernel-client.test.ts` | The kernel-api client against a KernelService of its own: the projected token, re-read on every call; the answers and refusals it maps; refusing field names the console didn't check. |
| `product-policy.test.ts` | The identity policy's products and team secrets: their entries, and that every change rewrites them. |
| `product-ownership.test.ts` | One team per product name and image repository, kept after deletion until an admin releases it. |
| `templates.test.ts` | Templates: what a consumer may run, the DAG built from products, parameters against the schema, sharing and on whose behalf, unshared steps, actions alone, a consumer's rights over their run, reruns. |
| `token-audiences.test.ts` | A product's token audiences: the cluster's own refused at registration, file names, what's stored. |
| `catalog-sync.test.ts` | Applying a catalog release: what it makes, what it drops, a failed item, a bad signature, teams it didn't make, the API; the stored credential. |
| `team-members.test.ts`, `team-lifecycle.test.ts` | Membership, retiring and purging teams. |
| `team-namespaces.test.ts` | The console creating, relabelling and deleting team namespaces, and applying SecretStore files: what reaches Kubernetes, and who may. |
| `image-scans.test.ts` | Reading Trivy's output, verdicts per digest, what a failed scan blocks, an admin accepting one, idling the scanner and waking it for a scan. |
| `registry-ecr.test.ts` | ECR's credential from the console's own AWS identity: fetched, sent as ECR's Basic challenge asks, kept for its lifetime. |
| `client-ip.test.ts` | Who the client is behind a load balancer: only trusted proxies' X-Forwarded-For counts. |
| `activity.test.ts` | Recording the console's last use: signed-in requests only, once a minute at most. |
| `audit.test.ts` | What the audit log records (a change, a refusal) and never records (secret values; reads; sign-in and passwords). |
| `audit-visibility.test.ts` | Who sees which audit entries in Observe: admins all; anyone else their own, and those about their teams and runs; filters within that. |
| `policy-sync.test.ts`, `retention.test.ts` | The policy resync and its reported outcome; what retention deletes and keeps. |
| `automation-tokens.test.ts` | Automation tokens and their scopes. |
| `image-policy.test.ts`, `registry.test.ts` | Allowed image sources; the registry check. |
| `product-releases.test.ts`, `product-catalog.test.ts` | Product registration, releases, full descriptions, wiring types. |
| `docs.test.ts`, `schemaDoc.test.ts` | The guides load and link correctly; the database guide matches the schema. |
| `secrets.test.ts` | Registering and revoking secrets: other teams refused, names Kubernetes would refuse, a Secret the console didn't create. |
| `apis.test.ts` | API products from releases (with their ServiceAccounts), who sees and may call them, held backends, pausing. |
| `approvals.test.ts` | Which steps wait for an approval (`always`, `otherTeams`, a target rule), and who may decide. |
| `registry-federation.test.ts` | The STS exchange, impersonation, caching and the Docker config handed out. |
| `observe.test.ts` | The security checks: what's enforced, refusals linked only for those who may see the run, images (a hidden product's for its team); the metrics, named by product, a hidden one's only for its team. |
| `logs.test.ts` | The LogQL the log search sends (a stand-in Loki records it): each caller's visibility, names checked, typed text quoted; LOGS_OFF. |
| `metrics.test.ts` | The console's Prometheus metrics: calls counted by procedure and code, served on their own port and not on the console's. |
| `log-levels.test.ts` | A step's log lines by level: INFO for everyone who can see the run, the rest for its team. |
| `audit-chain.test.ts` | The audit log's hash chain: each entry follows the one before; a changed, removed, inserted or unhashed entry breaks it. |
| `audit-copy.test.ts` | The audit log's copy as Observe shows it: off, how far it has gone and what's waiting, the bucket for admins only, and the entry where a forged one broke the chain. |
| `bootstrap-admin.test.ts` | The first admin: a generated password must be changed, an operator's isn't, an existing account is left alone. |
| `write-fence.test.ts` | The write fence's check: in force only failing closed, checking something, and bound to deny. |
| `run-view.test.ts` | Who sees what of a run across teams: the consumer and submitter everything, a provider's member their own steps in full and only codes of the rest (details, events, logs); a raw DAG all its teams. |
| `password-change.test.ts` | A password someone else set: nothing but changing it until then (an admin's own reset and single sign-on aren't held back). |
| `team-quota.test.ts` | Teams' resource limits: the install's for a new team, an admin's own written at once and undone, refused to others and for what isn't a quantity, every team's on resync. |
| `sso.test.ts`, `oidcProvider.ts` | Single sign-on as admins set it: admins only, the secret sealed and unsent, issuers checked, an install's provider read-only, signing in following the saved settings, mapped teams following the claim's and Google Workspace's groups (and untouched when they can't be read), manual edits refused; the stand-in provider it signs in against. |
| `oidc.test.ts` | Signing in with single sign-on against a stand-in provider: new accounts, binding an existing one once, every refusal (domain, unverified email, signature, nonce, state); a team requiring it refusing its members' passwords and password sessions, admins exempt, nothing while it's off. |
| `reset-admin.test.ts` | Resetting a lost admin password: printed once, sessions revoked, audited, admins only. |
| `execution-list.test.ts` | The execution list, a page at a time: every row once, only the caller's, server-side filters. |
| `access.test.ts` | The authorization rules in `auth/access.ts`. |
| `security-headers.test.ts` | The browser security headers (CSP and others) on pages and errors. |
| `rpc.ts` | Calling the Connect services as JSON through `app.inject`, and reading their error details. |
| `rpc-*.test.ts` | Each Connect service (auth, users, tokens, admin, secrets, products, teams, executions): who may call it, its refusals as Connect codes and details, and requests checked against their schemas. |
| `api-reference.test.ts` | The generated API reference marks exactly the public methods, and documents every service and method. |

## `gateway/`: the API gateway

| Path | What it's for |
| --- | --- |
| `cmd/gateway/main.go` | Reads its settings, the published APIs (every few seconds) and serves: inside the cluster, optionally a public listener, and metrics. |
| `internal/gateway/` | The request path: the API, paused or held, who's calling, shared with them, size, the spec (404 when not in it, 400 when unfit), the team's rate, then forwarded with the backend's credential and a signed `Vertra-Caller`, the answer streamed back. |
| `internal/auth/` | Signing callers in as the console does: session JWTs and bot tokens, against its database. |
| `internal/store/` | The published APIs from the console's `apis` table, each with its OpenAPI validator and endpoints; whether an admin closed the gateway; the backend host rule. |
| `internal/credentials/` | Signing a forwarded request in to its backend, from the API's own ServiceAccount: its token (TokenRequest), a Google ID token (federated at Google's STS, then generateIdToken), or AWS SigV4 (AssumeRoleWithWebIdentity); each kept for most of its life. |
| `internal/traffic/` | Counting each API's requests a minute at a time (team, endpoint, outcome) and adding them to the console's `api_traffic`. |
| `internal/caller/` | The `Vertra-Caller` header (an EdDSA JWT) and its public key at `/.vertra/jwks.json`. |
| `internal/limits/` | A token bucket per API and calling team. |
| `internal/config/` | Its settings, checked at startup. |
| `Dockerfile` | One static binary on distroless, cross-compiled on the builder's platform. |

## `helm/`: Kubernetes packaging

`helm/charts/` holds the two charts; each chart's `values.yaml` has neutral defaults. `helm/values/` holds each cluster's own settings.

### `helm/charts/execution-kernel/`

| Path | What it's for |
| --- | --- |
| `Chart.yaml`, `values.yaml`, `.helmignore` | The chart, its defaults (with resource requests), and what to leave out. |
| `sizes/{minimal,resilient,scaled,auto}.yaml` | The size presets: copies, step caps and default step size, retention, the database volume. |
| `templates/autoscaling.yaml` | kernel-api's HorizontalPodAutoscaler (`auto`), and PodDisruptionBudgets for whatever runs two or more copies. |
| `templates/sleeper.yaml` | Sleeping when idle: the sleeper's CronJobs, its narrow identity (replica counts of named Deployments only), and the ConfigMap of counts to wake to. |
| `templates/step-headroom.yaml` | Warm headroom: low-priority placeholder Pods the size of a default step, and their PriorityClass. |
| `templates/kernel-api-deployment.yaml`, `kernel-api-service.yaml` | kernel-api, reachable only inside the cluster. |
| `templates/monitoring.yaml` | With the Prometheus Operator (`monitoring`): a PodMonitor for kernel-api and the scheduler, and alerts (scheduler down or failing, steps waiting). |
| `templates/kernel-scheduler-deployment.yaml` | kernel-scheduler. |
| `templates/postgres-*.yaml` | The kernel's Postgres: Deployment, storage, Service. |
| `templates/migration-job.yaml` | Runs database migrations before an upgrade (a Helm hook). |
| `templates/backup-cronjob.yaml` | Scheduled database backup (both databases when they share the instance) to GCS, S3, Azure Blob or a volume. |
| `templates/configmap.yaml`, `secret.yaml`, `serviceaccount.yaml` | Settings, the database password, the kernel's identity. |
| `templates/rbac.yaml` | What the scheduler may do: create and delete Jobs and ConfigMaps, read Pods and their logs. |
| `templates/dispatch-policy.yaml` | Admission policy: the scheduler may only create Jobs in namespaces labelled `vertra/team=true`. |
| `templates/image-policy.yaml` | Admission policy: task images only from allowed sources (the console edits the list). |
| `templates/image-signature.yaml` | On GKE: catalog images must be signed (Sigstore's ClusterImagePolicy). |
| `templates/purge-policy.yaml` | Admission policy: only the purge identity may delete a team's namespace. |
| `templates/networkpolicy.yaml` | Only the release's Pods (and the console) may reach Postgres; only the console may reach kernel-api. |
| `templates/identity-policy.yaml` | Admission policy: a step runs as `default` with no Secrets, or as its registered product's ServiceAccount with only its Secrets. The console keeps its product list current. |
| `templates/scan-policy.yaml` | Admission policy: a step's image must be pinned by digest, and not one whose security scan failed (the console keeps that list). |
| `templates/console-database.yaml` | With `postgres.consoleDatabase` on: the console's database and login role on the kernel's Postgres, its connection Secret, and the Job that creates them, so one instance serves both. |
| `templates/_helpers.tpl`, `NOTES.txt` | Shared template snippets; the message shown after install. |

### `helm/charts/execution-console/`

| Path | What it's for |
| --- | --- |
| `Chart.yaml`, `values.yaml`, `.helmignore` | The chart and its defaults. |
| `sizes/{minimal,resilient,scaled,auto}.yaml` | The size presets: copies and retention. |
| `templates/autoscaling.yaml` | The console's HorizontalPodAutoscaler (`auto`) and its PodDisruptionBudget from two copies. |
| `templates/logs.yaml`, `files/alloy.alloy` | Log search (`logs`): one Loki (a volume or a bucket) and Grafana Alloy collecting steps' and the platform's Pods with credentials redacted; only Alloy and the console reach Loki. |
| `templates/monitoring.yaml`, `files/grafana-dashboard.json` | With the Prometheus Operator (`monitoring`): a PodMonitor for the console and gateway, alerts (calls failing, sign-in bursts, the catalog not applying, backends unreachable), and Vertra's Grafana dashboard as a ConfigMap. |
| `templates/ingress.yaml` | Reaching the console from outside the cluster (HTTPS only), for the catalog's CI: the certificate from the cloud, a Secret, or cert-manager (an issuer of yours, or Let's Encrypt through the chart's own Issuer); plain HTTP refused for known controllers. With `trustProxy`, the console believes the load balancer's X-Forwarded-For. |
| `templates/httproute.yaml` | The same through a Gateway (`gatewayApi`): an HTTPRoute on its HTTPS listener, and a redirect from its HTTP one. |
| `templates/activity.yaml` | The ConfigMap the console records its last use in (for the kernel's sleeper), and the Role that lets it update that one. |
| `templates/deployment.yaml`, `service.yaml` | The console, and how it's reached (LoadBalancer on GKE, port-forward on kind). |
| `templates/postgres-*.yaml`, `migration-job.yaml`, `backup-cronjob.yaml` | Its own Postgres, migrations and backups. |
| `templates/networkpolicy.yaml` | The console's metrics port only from `metricsFrom`; when it runs its own Postgres, only this release's Pods may reach it. |
| `templates/write-fence-policy.yaml` | Admission policy: the console may write Secrets, ServiceAccounts, Roles, RoleBindings and ExternalSecrets only in team namespaces. |
| `templates/gateway.yaml` | The API gateway (`gateway.enabled`): its Deployment and Service, its signing key (generated once, kept), its one RBAC verb (ServiceAccount tokens), the admission policy limiting that to `*-api` ServiceAccounts in team namespaces, its egress (anywhere but the cloud metadata server, by default) and ingress (its metrics port only from `metricsFrom`), and an Ingress for its public listener. |
| `templates/namespace-policy.yaml` | Admission policy: the console may only create namespaces labelled a team's and change that one label on a team's namespace, never on kube-* or protected ones. |
| `templates/scanner.yaml` | The Trivy server image scans run against, the scan Jobs' ServiceAccount (no token) and the Role that lets the console run them in its own namespace and idle the server (its replica count only). |
| `templates/configmap.yaml`, `secret.yaml`, `serviceaccount.yaml` | Settings, generated secrets (kept across upgrades), the console's identity. |
| `templates/rbac.yaml` | What the console may do in Kubernetes: create ServiceAccounts, write Secrets and ExternalSecrets, delete (never create) Roles and RoleBindings, edit the image and identity policies; read namespaces, SecretStores and Pods. |
| `templates/_helpers.tpl`, `NOTES.txt` | Shared snippets; post-install message. |

### `helm/tests/`

| Path | What it's for |
| --- | --- |
| `admission-policies.sh` | Proves the charts' admission policies on a real cluster (dispatch, image sources, step identity, the console's write fence), case by case with server-side dry runs. Run by CI's kubernetes job. |

### `helm/values/`: each cluster's settings

The complete settings for each cluster: `make kind-deploy*` and `make gke-deploy*` install the charts with these files and `--reset-values`, so a setting not in these files isn't deployed.

| Path | What it's for |
| --- | --- |
| `kind/kernel.yaml`, `kind/console.yaml` | The local kind cluster: local images, the demo admin, the local registry. |
| `kind/external-secrets.yaml` | External Secrets Operator on kind. |
| `kind/audit-store.yaml` | `make kind-audit-store`: SeaweedFS (S3 with Object Lock) and a bucket locked for a day, for the console's audit copy on kind. |
| `kind/cert-manager.yaml`, `kind/traefik.yaml`, `kind/tls-test.yaml` | `make kind-tls`: cert-manager, Traefik (Ingress and Gateway API), and a private test CA with a Gateway, for the console over HTTPS on kind. |
| `gke/kernel.yaml`, `gke/console.yaml` | The real GKE cluster: Artifact Registry images, Workload Identity, the LoadBalancer, image signatures. |
| `gke/external-secrets.yaml` | External Secrets Operator on GKE, with Workload Identity. |
| `gke/policy-controller.yaml` | Sigstore's policy-controller, which checks image signatures (GKE only). |

## `docs/`: maintainer documentation

| Path | What it's for |
| --- | --- |
| `architecture.md` | **Start here.** What Vertra is, the pieces, how a DAG becomes running containers, the product contract, the data, observability, the design decisions, a glossary. |
| `operations.md` | Installing (kind, and any cluster with Helm), cloud identities, upgrading, databases (passwords, access, retention), backups and restores, network policies, troubleshooting. |
| `security-model.md` | For security reviewers: where secrets live, vault sync, who can read a secret, what the cluster enforces, what isn't enforced yet, and what's out of scope. |
| `assessment.md` | The architecture assessment of 2026-10-19: what exists, findings, comparisons with Temporal and Inngest, identity across clouds, the agreed direction and its roadmap. |
| `repository-map.md` | This page. |
| `architecture/` | draw.io diagrams (system, UML classes for both projects, a submit-to-finished sequence, state machines), their SVG exports, and `generate.py`, which writes them from the code. Rerun it after changing code. |

### `docs/setup.md`

Setting up Vertra with `vertra`, start to finish: the questions `init` asks and what each decides, what `apply` asks of you (DNS), the first sign-in and Google sign-in, the catalog, day-to-day commands, and what `destroy` keeps.

### `docs/clouds/`: before `vertra init`

| Path | What it's for |
| --- | --- |
| `aws.md`, `gcp.md`, `github.md` | What only each website can do before an install (an account or project, the root user's MFA, a budget, an IAM user, signing in, organization policies), linked from `vertra` when it finds one of them missing. |

## `examples/`: demo products

Fake products used by the demos and the kernel's integration tests. They deliberately share no code, as real products wouldn't, and aren't held to the production bar. Real products live in each team's own catalog repository, started from `catalog-template/`.

| Path | What it's for |
| --- | --- |
| `project-product/` | Pretends to create a project and outputs its id. |
| `application-product/` | Pretends to deploy an application into a project, taking the project id from the step before. |
| `hello-world-app/` | A tiny web app: the image the Cloud Run demo deploys. |

## `cli/`: the installer

| Path | What it's for |
| --- | --- |
| `DESIGN.md` | The design for `vertra`: targets, cluster modes, sizes, scale-down, requirements, the OpenTofu modules, the approval screen and cost estimate, the catalog step, the build order. |
| `go.mod`, `go.sum` | The Go module (`github.com/rburns629/vertra/cli`): cobra and yaml.v3, protobuf and Connect for the console's API, and `make proto`'s two plugins as `tool` dependencies. |
| `internal/gen/` | Generated from `proto/` by `make proto` (messages and Connect clients); never edited. |
| `cmd/vertra/catalog_commands.go` | A catalog's own commands, `vertra catalog validate`, `check`, `publish`, `release`, `changed`, `secret-stores check`, `bases`, `migrate`: what every catalog's `./vertra` runs. `vertra catalog create` (making the repository) is `catalog.go`. |
| `internal/catalogtool/` | What `vertra catalog` does in a catalog: validating teams, CODEOWNERS, products, `dags/` templates and DAGs, and `apis/` API products and their OpenAPI files (`apis.go`) in catalog format v2 (against the schemas it embeds, `schemas/`, kept equal to the template's `tools/` by a test), and `migrate` from before v2; the compatibility check against the base (`compat.go`: breaking changes need a raised `version`, removals a deprecation first); pinning base images; building, contract-testing, scanning (Trivy, OSV-Scanner), pushing and signing products; building, pushing and signing the catalog's release (`release.go`), and tagging a commit's release as a version (`promote.go`). It never calls a console. |
| `cmd/vertra/main.go` | The root command, its shared flags (`--config`, `-v`, `--non-interactive`) and loading an environment. |
| `cmd/vertra/init.go` | `init <env>`: the questions (or flags), then `deploy/<env>/vertra.yaml`. |
| `cmd/vertra/apply.go` | `apply`: the approval screen, then registry, cluster, namespace, images and both releases. |
| `cmd/vertra/operate.go` | `check`, `status`, `sleep`, `wake`, `console` and `destroy`. |
| `cmd/vertra/admin.go` | `admin reset-password`: a lost admin password, reset inside the cluster. |
| `cmd/vertra/catalog.go` | `catalog create`: creates the catalog repository on GitHub with its first team and starters, sets its registry variables (no console credential; old ones removed and revoked), pushes it, waits for its CI, has the console apply the release, and runs a starter. |
| `cmd/vertra/apply_aws.go` | The aws target's part of `apply` and `destroy`: the sign-in and region checks, the module's plan, prices, outputs, Auto Mode's StorageClass and steps' node pool, and what a destroy keeps. |
| `cmd/vertra/apply_gcp.go` | The gcp target's part of `apply` and `destroy`: the project's checks, the module's plan, prices, outputs, and what a destroy keeps. |
| `cmd/vertra/tools.go` | `tools`, `config get/set`, and the tools check `init` and `apply` share. |
| `internal/config/` | The config file: defaults, validation, load and save, dotted-key get and set. |
| `internal/prompt/` | The questions on a terminal; defaults when non-interactive. |
| `internal/tools/` | Required tools per target, version checks, and pinned, checksum-verified downloads into `~/.vertra/bin` (`pins.go`). |
| `internal/run/` | Runs the external commands (kubectl, helm, docker, kind), printing them with `-v`. |
| `internal/cluster/` | The kind cluster and its local registry: inspect, create, delete; namespaces. |
| `internal/install/` | The platform images (built from source or released), the generated Helm values, and `helm upgrade`. |
| `internal/platform/` | The installed platform: deployments, sleep, wake, running steps, console access. |
| `internal/plan/` | The approval screen and the sizes' platform floors. |
| `internal/gcp/` | What a gcp install needs from gcloud, as you: the project's checks, the cluster's credentials, a short-lived Docker sign-in, the module's inputs and the registry paths. |
| `internal/access/` | Guided access: who you're signed in as (AWS, Google, GitHub), where an install would go, and what that allows (regions an organization's policy permits, budgets, OpenTofu's sign-in, a project's existing resources), as the approval screen's Access block and problems with fixes and guides; AWS's errors classified whole. |
| `cmd/vertra/init_access.go` | The guided access steps in `init`: choosing a sign-in and running it, choosing a project or a region from those that answer, offering a budget, recording who set the environment up. |
| `internal/awscloud/` | What an aws install needs from the AWS CLI, as you: the sign-in and region checks, the cluster's credentials, a short-lived ECR sign-in, the module's inputs, the account's GitHub OIDC provider, Auto Mode's in-cluster setup, and the ECR repositories a destroy removes. |
| `internal/modules/aws/` | The aws OpenTofu module (embedded): a VPC in two zones (public subnets, no NAT gateway), an EKS Auto Mode cluster, ECR (a template that creates products' repositories on push, and the platform's), Pod Identity roles for the console and the backups, the backup bucket, and the catalog CI's GitHub OIDC role. |
| `internal/modules/gcp/` | The gcp OpenTofu module (embedded in the binary): network, a GKE Autopilot or Standard cluster, Artifact Registry repositories, the nodes', console's and backups' identities, the backup bucket; `.terraform.lock.hcl` pins the provider's checksums. |
| `internal/modules/modules.go` | Embeds the modules and writes one into an environment's `tofu/`. |
| `internal/catalog/` | Assembles a new catalog's first commit from `catalog-template/`: the first team, the starters for its languages, the owners, where it publishes. |
| `internal/githost/` | The catalog's git host, as you through `gh`: repositories, pushes (gh signs git in for that command only), variables, secrets from stdin, Environments, workflow runs; GitHub's single sign-on refusals. |
| `internal/consoleapi/` | The console's API as vertra uses it, over the generated Connect clients: signing in as the admin, revoking the tokens catalogs once held, syncing the catalog, running a DAG and watching it finish. Tested against fake Connect handlers. |
| `internal/tofu/` | Runs OpenTofu in an environment's `tofu/`: init, plan (summarised for the approval screen), apply the approved plan, outputs, destroy. |
| `internal/pricing/` | Live prices for the approval screen: Google's price catalog (read with your gcloud sign-in) and AWS's Price List and Spot price history (with your AWS sign-in), each cached a day, and their cost models; `testdata/` holds real price entries. |

## `catalog-template/`: what a new catalog starts as

Copied whole into a new catalog repository (`README.md` there explains it to its users). Its own `.github/` is for that repository, not this one.

| Path | What it's for |
| --- | --- |
| `README.md` | The catalog's guide: layout, onboarding a team, `product.yaml`, testing, CI, publishing, SecretStores, retiring. |
| `vertra.yaml` | Where products publish (registry, signing); local defaults, overridden by CI variables. |
| `vertra`, `tools/` | The wrapper that runs `vertra` (`cli/cmd/vertra`) at a pinned, checksum-verified release, or `VERTRA_BIN`: the one tool behind every workflow and local publishing; and the schemas of every catalog file in format v2 (`team`, `product`, `template`, `dag`, `api`), for editors (vertra catalog embeds its own). |
| `.github/` | The catalog's workflows (check, then publish and release; a `vX.Y.Z` tag asking main to make that version, `version.yml`; SecretStore and CODEOWNERS checks; deleting a removed team's images), its scanner installer, and a placeholder `CODEOWNERS`. |
| `.semgrep/malicious.yml` | Code rules for products: download-and-execute, reverse shells, mining, reading the Pod's token. |
| `templates/` | Starters to copy: a team, three products, and DAGs that use them. Checked by CI, never published. |
| `teams/` | Empty but for its README: a new catalog's teams go here. |
| `samples/local/` | A sample team with no cloud or secrets: one product in Python, TypeScript, Go, PowerShell and Rust, shared with every team, and a template chaining two of them (`dags/shout-backwards.yaml`); and `ticket`, which reports what it opens as `resources` and names `close` as its `cleanup`. New teams copy starters from it by language; published whole, it proves an install end to end. |
| `docs/onboarding-with-ai.md` | For catalog teams using an AI assistant to add a team or product. |
| `samples/gcp/` | A sample team whose products call real, billed Google Cloud APIs, copied into a team once a cloud identity is set up; `project`, `app-hosting` and `cloud-sql` label what they make and delete it as their `cleanup` (`actions/delete.py`). |
| `samples/aws/` | The same for AWS: an S3 bucket, an App Runner service, RDS for PostgreSQL (its password kept by Secrets Manager), keyless through EKS Pod Identity or IRSA. Proven on EKS (its SecretStore not yet). |
| `samples/azure/` | The same for Azure: a resource group, a Container App, a PostgreSQL flexible server with Entra sign-in only, keyless through AKS Workload Identity. Not yet proven, and needs a step Pod label the kernel can't set yet. |

## Not in git

| Path | What it's for |
| --- | --- |
| `_local/` | Your own scratch space: a clone of your own catalog repository, notes. Never committed. |
| `node_modules/`, `dist/`, `.venv/`, caches | Installed dependencies and build output. |

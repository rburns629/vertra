# Repository map

Every folder and file in this repository, and what it's for. For how the pieces work together, read [`architecture.md`](architecture.md) and the diagrams in [`architecture/`](architecture/README.md); this page is the index.

The repository holds two independent projects that are deployed together and share no code:

- **`kernel/`** runs DAGs: an API that accepts them, and a scheduler that runs each task as a Kubernetes Job.
- **`console/`** is the authenticated front door: sign-in, teams, secrets, products, and the web UI.

Around them: `helm/` packages both for Kubernetes, with each cluster's settings, and `docs/` explains it all.

```
.
├── kernel/        the execution engine (Python)
├── console/       the web console and its API (TypeScript)
├── helm/          Helm charts for both, and each cluster's settings
├── docs/          maintainer documentation and diagrams
├── examples/      demo products (not real catalog products)
├── catalog-template/  what a new catalog repository starts as
├── .github/       CI and security workflows
├── Makefile       everyday commands: run, deploy, logs
└── _local/        your own scratch space (gitignored)
```

## Top level

| Path | What it's for |
| --- | --- |
| `README.md` | What Acyclix is, a first example DAG, trying it locally on kind, and how the parts fit together. |
| `LICENSE` | The MIT license. |
| `SECURITY.md` | How to report a vulnerability privately, response times, supported versions, scope. |
| `CONTRIBUTING.md` | Setting up, testing, what a pull request needs, DCO sign-off. |
| `CODE_OF_CONDUCT.md` | Adopts the Contributor Covenant 2.1, and where to report problems. |
| `AGENTS.md` | Guide for AI coding assistants (and a quick orientation for people): layout, core contracts, commands, things that bite, engineering principles. |
| `CLAUDE.md` | One line that imports `AGENTS.md`, so Claude Code reads the same guide. |
| `TODO.md` | The actionable follow-up list: security, access, operations, housekeeping. Check it before starting work. |
| `Makefile` | Everyday commands: `make quickstart` (a local install from nothing), `make up`/`down`/`logs` for the kind cluster, `make kind-deploy*` and `make gke-deploy*`, building the demo products, and `make test`/`test-db`/`test-db-down` (a throwaway test Postgres, separate from any install). |
| `.gitignore` | Keeps `_local/`, build output and dependencies out of git. |
| `.semgrep/malicious.yml` | Semgrep rules for code that has no business in a product (running remote code, hidden payloads, reverse shells, mining). Run by `security.yml`. |

## `.github/`: CI

| Path | What it's for |
| --- | --- |
| `workflows/ci.yml` | Every PR: kernel tests, lint and type checks; console tests, lint and build; Helm lint and render of `helm/values/*`; `actionlint` (this repo's workflows and the catalog template's); the catalog template's checks; building both platform images and scanning them (Trivy, OSV-Scanner). |
| `dependabot.yml` | Weekly, grouped update pull requests (a week's cooldown) for the kernel's Python, the console's npm, every Dockerfile, the workflows, and the catalog template's starters. |
| `workflows/release.yml` | On a version tag: builds both platform images for amd64 and arm64, scans them, pushes them to GHCR, signs them keyless; packages, pushes and signs both charts; creates the GitHub release. |
| `workflows/security.yml` | Secret scanning (gitleaks) and code scanning (Semgrep, including `.semgrep/`). |
| `scripts/install-scanners.sh` | Installs pinned, checksum-verified tool binaries (Trivy, OSV-Scanner, gitleaks, actionlint, cosign) for the workflows. |
| `scripts/catalog-template.sh` | Runs catalogctl in `catalog-template/` with its samples (all, or `SAMPLES=`) installed as teams: CI's `validate` and `check`, and `make catalog-publish`'s `teams apply` and `publish`. |
| `scripts/scan-image.sh` | Scans one built platform image and fails if it must not ship (fixable high or critical vulnerabilities, and more). |
| `ISSUE_TEMPLATE/bug_report.yml`, `feature_request.yml` | Issue forms for bugs and feature requests. |
| `ISSUE_TEMPLATE/config.yml` | Turns off blank issues and points security reports to private reporting. |
| `pull_request_template.md` | What every pull request describes, and its checklist. |

## `kernel/`: the execution engine

Python 3.12, FastAPI, SQLAlchemy (async), Alembic. One image, two processes: **kernel-api** and **kernel-scheduler**, which never call each other and meet only in Postgres. Layers import in one direction only: `contracts → domain → persistence → services | scheduler → executors → api → main` ([`ARCHITECTURE.md`](../kernel/ARCHITECTURE.md)).

### Project files

| Path | What it's for |
| --- | --- |
| `README.md` | What the kernel is and how to run and test it. |
| `ARCHITECTURE.md` | The layer rules, and a call-by-call trace of submit → claim → dispatch → poll → finish. |
| `pyproject.toml` | Dependencies, and the settings for ruff, mypy and pytest. |
| `Dockerfile` | The kernel image (used for both processes and the migration Job). Runs as a non-root user. |
| `.dockerignore`, `.gcloudignore` | Keep tests, caches and local files out of the image and the Cloud Build upload. |
| `alembic.ini` | Database migration settings; the migrations themselves are in `app/persistence/migrations/`. |

### `kernel/app/`: the code

| Path | What it's for |
| --- | --- |
| `main.py` | Builds the kernel-api FastAPI app: routes, middleware, startup and shutdown. |
| `config.py` | Every setting, as one validated `Settings` object (pydantic-settings), read from the environment. |
| **`contracts/`** | **The shapes that cross a boundary**, as pydantic models. |
| `contracts/execution.py` | The DAG submission (`name`, `requestId`, `tasks`) and kernel-api's responses. |
| `contracts/task.py` | One task's definition; the `{"$fromTask", "$output"}` reference; the `request.json` a product reads. |
| `contracts/result.py` | `result.json`, what a product writes: status, outputs, or a structured error. |
| **`domain/`** | **The rules, with no I/O.** |
| `domain/credentials.py` | Recognizes credential shapes (private keys, cloud keys, tokens): redacts them from logs, refuses them in inputs and outputs. |
| `domain/dag_validation.py` | Checks a DAG before it's stored: duplicate ids, unknown dependencies, cycles, `$fromTask` references, credentials in inputs; topological order. |
| `domain/states.py` | Task and execution states, and the retry rule. |
| `domain/events.py` | The event types recorded for an execution. |
| `domain/errors.py` | Typed errors: validation failures, dispatch refusals, missing upstream outputs. |
| **`persistence/`** | **Postgres.** |
| `persistence/models.py` | The kernel's tables (executions, tasks, dependencies, attempts, outputs, logs, events). |
| `persistence/database.py` | Engine, sessions, and the transaction helper. |
| `persistence/repositories.py` | Shared queries: find by id or `requestId`, record an event, page through events. |
| `persistence/migrations/` | Alembic's setup (`env.py`, `script.py.mako`) and `versions/`: `0001_initial_schema.py` (every table at the first public release), then one file per later change, applied in order by the migration Job on deploy. |
| `persistence/schema.py` | Whether the database is at this code's migration, and waiting until it is: what keeps a fresh install's scheduler from failing before the migration hook runs. |
| **`services/`** | **What kernel-api does.** |
| `services/execution_service.py` | Submit (idempotent by `requestId`), read an execution, its logs and events, cancel, retry a task. |
| **`scheduler/`** | **The kernel-scheduler process.** |
| `scheduler/__main__.py` | `python -m app.scheduler`: the loop that runs one tick per poll interval until SIGTERM, then releases its leases. |
| `scheduler/claiming.py` | Takes READY tasks with `FOR UPDATE SKIP LOCKED` and a lease; recovers tasks whose lease expired; releases a stopping scheduler's leases. |
| `scheduler/service.py` | One tick: claim, start each task, poll running ones, save results, retry or fail, release dependents, finish executions. |
| `scheduler/retention.py` | Deletes finished executions past their retention (with everything of theirs). |
| `scheduler/input_resolution.py` | Replaces `$fromTask` references with upstream tasks' saved outputs before a task starts. |
| **`executors/`** | **Running a task.** |
| `executors/base.py` | The `Executor` protocol and the types passed through it. |
| `executors/kubernetes.py` | The one executor: creates the `request.json` ConfigMap and the Job, reads status and the termination message, catches image-pull failures, deletes finished Jobs. |
| **`api/`** | **kernel-api's HTTP routes.** |
| `api/routes/executions.py` | `/v1/executions`: submit, read, states, logs, events, cancel, retry. |
| `api/routes/health.py` | Liveness and readiness. |
| `api/routes/metrics.py` | Prometheus metrics. |
| `api/auth.py` | Accepts only the console on `/v1`: checks its ServiceAccount token with a TokenReview. |
| `api/dependencies.py` | Per-request database session. |
| **`observability/`** | **Logs and metrics.** |
| `observability/logging.py` | Structured JSON logs. |
| `observability/metrics.py` | The Prometheus counters and histograms. |
| `observability/http_middleware.py` | Logs and measures every request. |

### `kernel/tests/`

| Path | What it's for |
| --- | --- |
| `conftest.py` | Shared fixtures: the test database (`TEST_DATABASE_URL`; each test rolls back), the API client. Kubernetes tests skip without a cluster, or fail when `KERNEL_TESTS_REQUIRE_KUBERNETES=1` (CI). |
| `fakes.py` | `FakeExecutor`: an in-memory executor, to test scheduler logic without a cluster. |
| `unit/` | Pure logic, no I/O: DAG validation, states, retry backoff, input resolution, executor error handling, image-pull detection, request timeouts on every Kubernetes call, when a watched step's status read can be skipped, the scheduler's bounded concurrency, thread pool and shutdown, kernel-api's caller check, event metrics counted on commit, step sizes (`resources`) and placement, and that the database guide matches the models (`test_schema_doc.py`). |
| `integration/` | Against real Postgres (and, where named, a real kind cluster): claiming and lease hand-over, the API (including refusing Python field names), the execution service, cancel and retry, input resolution, the scheduler and its edge cases (a result seen late, a retry of one of several failures, two schedulers finishing tasks together, a start that raises retrying the same attempt, a running step's log refreshed, retention), the Kubernetes executor, the demo products. `executor_helpers.py` holds shared helpers. |
| `end_to_end/test_two_task_chain.py` | The full proof: a two-task DAG through real Postgres, the real scheduler and real Jobs on kind, with a value passed between the tasks. |
| `fixtures/docker_test_image/` | A test-only product image that crashes, sleeps or misbehaves on demand, to exercise the executor's failure handling. |

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

### `console/src/`: the backend

| Path | What it's for |
| --- | --- |
| `index.ts` | Builds the app: the global error handler (hides server errors' details), auth, rate limits, every route under `/api`, the static frontend. |
| `config.ts` | Every setting, read and checked once at startup. |
| `openapi.ts` | Describes every route for the generated API reference (`GET /api/openapi.json`, Docs → API reference). |
| `k8s.ts` | **Every write to Kubernetes:** product ServiceAccounts (create-only), Secrets, ExternalSecrets, removing the per-secret Roles older versions made, the image policy; also reads namespaces, SecretStores and task Pods. Security-sensitive. |
| `kernel/client.ts` | Calls kernel-api (with the console's projected ServiceAccount token): submit, read, states, events, logs, cancel, retry. |
| `imagePolicy.ts` | The allowed image sources: the same matching rules as the cluster's image policy, and reading and saving it. |
| `imageRef.ts` | Reading an image reference the way the kubelet does (`normalizeImage`, `imageRepository`); pure, used by the image policy and repository ownership. |
| `secretStores.ts` | What a team's SecretStore file may hold, checked before the console applies it (`PUT /teams/:team/secret-store`): the same rules as the catalog's own check. |
| `scanning.ts` | Scanning every image before it's registered or run: a Trivy client Job per digest, verdicts in `image_scans`, daily rescans, the failed digests written into the kernel's scan policy. |
| `audit.ts` | Who changed what: every changing `/api` request, allowed or refused, recorded in `audit_log` and logged (never a secret value, password or token). |
| `policySync.ts` | Rewrites the identity and scan policies and the teams' pull Secrets every few minutes, so drift doesn't last; keeps each sync's outcome for admins. |
| `pullSecret.ts` | Copies the platform's registry pull Secret into every team namespace (`acyclix-pull`), for steps' images in private registries. |
| `retention.ts` | Deletes, hourly, submitted-execution records, audit entries and unused scan verdicts past their retention. |
| `productPolicy.ts` | Writes the registered products into the cluster's identity policy, after every product change and at startup. |
| `registry.ts` | Asks a container registry whether an image still exists, before a run. |
| **`auth/`** | **Who's calling.** |
| `auth/plugin.ts` | Checks every request's session or bot token and loads the caller's teams and admin flag. |
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
| `db/migrations/` | The schema: `0000_initial_schema.sql` (every table at the first public release), then one SQL file per later change, generated by `npm run db:generate`; `meta/` is drizzle's bookkeeping. |
| **`routes/`** | **The API**, one file per area. Team-scoped routes require membership or admin. |
| `routes/auth.ts` | Sign-in and registration. |
| `routes/me.ts` | The signed-in user, and changing your password. |
| `routes/users.ts` | Admin: people, admin rights, password resets. |
| `routes/teams.ts` | Teams and members, and their namespaces; retiring, restoring and purging a team; applying a team's SecretStore file. |
| `routes/bots.ts` | A team's bots and their tokens. |
| `routes/automation.ts` | Admin: automation tokens with platform-wide scopes (catalog CI). |
| `routes/secrets.ts` | Registering a team's secrets (pasted or synced from a cloud store), which any of its registered products may mount; listing a team's secrets and secret stores. |
| `routes/products.ts` | The product registry: register (catalog CI), list, delete; which team owns each image repository, and releasing one (admin). |
| `routes/imageScans.ts` | Admin: image scan verdicts; accepting a failed one with a reason; rescanning. |
| `routes/audit.ts` | Admin: the audit log, newest first. |
| `routes/policySync.ts` | Admin: whether the cluster's policies are current; resync now. |
| `routes/wiringTypes.ts` | The catalog's wiring vocabulary, for generating DAGs from products. |
| `routes/executions.ts` | Submit, list, read, logs, events, cancel, retry, rerun, with every check before kernel-api is called. |
| `routes/pods.ts` | A team's running task Pods (Team page → Running now). |
| `routes/imagePolicy.ts` | Admin: read and edit the allowed image sources. |
| `routes/docs.ts` | Serves the guides in `console/docs/`. |
| `routes/stats.ts` | Admin: platform-wide counts for the home page. |
| `routes/retiredTeam.ts` | The shared "this team is retired, it's read-only" refusal. |

### `console/frontend/`: the web app

React 19, MUI, Vite, react-router. Its own `package.json`.

| Path | What it's for |
| --- | --- |
| `index.html`, `src/main.tsx` | The page and the app's entry point. |
| `src/App.tsx` | The routes; each page loads only when first opened. |
| `src/api.ts` | Every call to the backend, with its types. |
| `src/theme.ts`, `src/index.css` | MUI theme and base styles. `theme.ts` holds every color and the mono font as named tokens (`sidebar.*`, `code.*`, `fontFamilyMono`), plus the focus ring and reduced-motion rules. |
| `src/dagCheck.ts` | Checks a pasted DAG live on the Submit page (JSON or YAML) and explains what's wrong. Tested in `dagCheck.test.ts`. |
| `vitest.config.ts`, `src/**/*.test.ts` | The frontend's tests (`npm test`); a test that renders opts into jsdom. |
| `src/dagLayout.ts` | Arranges a DAG's tasks into columns for the execution graph. |
| `src/statusColor.ts` | Each state's color and label, shared by the status chips and the home charts. |
| `src/auth/` | The signed-in user (`AuthContext`) and the guard that sends signed-out visitors to the login page. |
| `src/layout/` | The sidebar and top bar (`AppLayout`) and the environment badge. |
| `src/components/` | Shared pieces: tables, page headers, status badges, metric cards, team cards, empty states, confirm dialogs, inline monospace (`Mono`). |
| `src/pages/HomePage.tsx` | Dashboard: counts, executions over time, status breakdown, recent runs. |
| `src/pages/ExecutionsListPage.tsx` | Every execution you can see, a page at a time; name and team filtered on the server. |
| `src/pages/useExecutionPolling.ts` | Polls one execution until it finishes; `resume()` after a retry or cancel. Tested alongside. |
| `src/pages/SubmitExecutionPage.tsx` | Paste or write a DAG, with live checking. |
| `src/pages/ExecutionDetailPage.tsx` | One execution: graph, tasks, outputs, logs, events, cancel, retry, rerun. |
| `src/pages/ProductsPage.tsx` | The product registry, by platform, with releases. |
| `src/pages/TeamsPage.tsx`, `TeamPage.tsx` | Your teams, and one team's page. |
| `src/pages/team/` | The Team page's tabs: members, secrets (adding one, connecting a cloud source), automation (bots), running tasks. `providers.ts` describes each secret provider for the "Connect a source" wizard. |
| `src/pages/AdminPage.tsx` | People, admin rights, automation tokens, allowed image sources. |
| `src/pages/AccountPage.tsx` | Your account and password. |
| `src/pages/DocsPage.tsx`, `ApiReference.tsx` | The guides from `console/docs/`, and the API reference built from the OpenAPI description. |
| `src/pages/LoginPage.tsx`, `RegisterPage.tsx` | Sign-in and registration. |
| `public/favicon.svg` | The browser tab icon. |
| `vite.config.ts`, `tsconfig*.json` | Build settings. |

### `console/docs/`: the in-console guides

Shown on the console's Docs page, in file order. They ship inside the console image.

| File | Guide |
| --- | --- |
| `01-getting-started.md` | Try Acyclix end to end: a platform, a product, a DAG. |
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
| `kernel-client.test.ts` | The kernel-api client sends the projected token, re-read on every call. |
| `product-policy.test.ts` | The identity policy's products and team secrets: their entries, and that every change rewrites them. |
| `product-ownership.test.ts` | One team per product name and image repository, kept after deletion until an admin releases it. |
| `team-members.test.ts`, `team-lifecycle.test.ts` | Membership, retiring and purging teams. |
| `team-namespaces.test.ts` | The console creating, relabelling and deleting team namespaces, and applying SecretStore files: what reaches Kubernetes, and who may. |
| `image-scans.test.ts` | Reading Trivy's output, verdicts per digest, what a failed scan blocks, an admin accepting one. |
| `audit.test.ts` | What the audit log records (a change, a refusal) and never records (secret values; reads; sign-in and passwords). |
| `policy-sync.test.ts`, `retention.test.ts` | The policy resync and its reported outcome; what retention deletes and keeps. |
| `automation-tokens.test.ts` | Automation tokens and their scopes. |
| `image-policy.test.ts`, `registry.test.ts` | Allowed image sources; the registry check. |
| `product-releases.test.ts`, `product-catalog.test.ts` | Product registration, releases, full descriptions, wiring types. |
| `openapi.test.ts` | Every route is documented in the API reference. |
| `docs.test.ts`, `schemaDoc.test.ts` | The guides load and link correctly; the database guide matches the schema. |
| `secrets.test.ts` | Registering and revoking secrets: other teams refused, names Kubernetes would refuse, a Secret the console didn't create. |
| `execution-list.test.ts` | The execution list, a page at a time: every row once, only the caller's, server-side filters. |
| `access.test.ts` | The authorization rules in `auth/access.ts`. |
| `security-headers.test.ts` | The browser security headers (CSP and others) on pages and errors. |

## `helm/`: Kubernetes packaging

`helm/charts/` holds the two charts; each chart's `values.yaml` has neutral defaults. `helm/values/` holds each cluster's own settings.

### `helm/charts/execution-kernel/`

| Path | What it's for |
| --- | --- |
| `Chart.yaml`, `values.yaml`, `.helmignore` | The chart, its defaults (with resource requests), and what to leave out. |
| `templates/kernel-api-deployment.yaml`, `kernel-api-service.yaml` | kernel-api, reachable only inside the cluster. |
| `templates/kernel-scheduler-deployment.yaml` | kernel-scheduler. |
| `templates/postgres-*.yaml` | The kernel's Postgres: Deployment, storage, Service. |
| `templates/migration-job.yaml` | Runs database migrations before an upgrade (a Helm hook). |
| `templates/backup-cronjob.yaml` | Scheduled database backup (both databases when they share the instance) to GCS, S3, Azure Blob or a volume. |
| `templates/configmap.yaml`, `secret.yaml`, `serviceaccount.yaml` | Settings, the database password, the kernel's identity. |
| `templates/rbac.yaml` | What the scheduler may do: create and delete Jobs and ConfigMaps, read Pods and their logs. |
| `templates/dispatch-policy.yaml` | Admission policy: the scheduler may only create Jobs in namespaces labelled `acyclix/team=true`. |
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
| `templates/deployment.yaml`, `service.yaml` | The console, and how it's reached (LoadBalancer on GKE, port-forward on kind). |
| `templates/postgres-*.yaml`, `migration-job.yaml`, `backup-cronjob.yaml` | Its own Postgres, migrations and backups. |
| `templates/networkpolicy.yaml` | When it runs its own Postgres, only this release's Pods may reach it. |
| `templates/write-fence-policy.yaml` | Admission policy: the console may write Secrets, ServiceAccounts, Roles, RoleBindings and ExternalSecrets only in team namespaces. |
| `templates/namespace-policy.yaml` | Admission policy: the console may only create namespaces labelled a team's and change that one label on a team's namespace, never on kube-* or protected ones. |
| `templates/scanner.yaml` | The Trivy server image scans run against, the scan Jobs' ServiceAccount (no token) and the Role that lets the console run them in its own namespace. |
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
| `gke/kernel.yaml`, `gke/console.yaml` | The real GKE cluster: Artifact Registry images, Workload Identity, the LoadBalancer, image signatures. |
| `gke/external-secrets.yaml` | External Secrets Operator on GKE, with Workload Identity. |
| `gke/policy-controller.yaml` | Sigstore's policy-controller, which checks image signatures (GKE only). |

## `docs/`: maintainer documentation

| Path | What it's for |
| --- | --- |
| `architecture.md` | **Start here.** What Acyclix is, the pieces, how a DAG becomes running containers, the product contract, the data, observability, the design decisions, a glossary. |
| `operations.md` | Installing (kind, and any cluster with Helm), cloud identities, upgrading, databases (passwords, access, retention), backups and restores, network policies, troubleshooting. |
| `security-model.md` | For security reviewers: where secrets live, vault sync, who can read a secret, what the cluster enforces, what isn't enforced yet, and what's out of scope. |
| `repository-map.md` | This page. |
| `architecture/` | draw.io diagrams (system, UML classes for both projects, a submit-to-finished sequence, state machines), their SVG exports, and `generate.py`, which writes them from the code. Rerun it after changing code. |

## `examples/`: demo products

Fake products used by the demos and the kernel's integration tests. They deliberately share no code, as real products wouldn't, and aren't held to the production bar. Real products live in each team's own catalog repository, started from `catalog-template/`.

| Path | What it's for |
| --- | --- |
| `project-product/` | Pretends to create a project and outputs its id. |
| `application-product/` | Pretends to deploy an application into a project, taking the project id from the step before. |
| `hello-world-app/` | A tiny web app: the image the Cloud Run demo deploys. |

## `catalog-template/`: what a new catalog starts as

Copied whole into a new catalog repository (`README.md` there explains it to its users). Its own `.github/` is for that repository, not this one.

| Path | What it's for |
| --- | --- |
| `README.md` | The catalog's guide: layout, onboarding a team, `product.yaml`, testing, CI, publishing, SecretStores, retiring. |
| `acyclix.yaml` | Where products publish (registry, console, signing); local defaults, overridden by CI variables. |
| `catalogctl`, `tools/` | The one tool behind every workflow and local publishing (`tools/catalog.py`), and the schemas for `team.yaml` and `product.yaml`. |
| `.github/` | The catalog's workflows (check and publish, teams, SecretStores, retire, purge, CODEOWNERS checks), its scanner installer, and a placeholder `CODEOWNERS`. |
| `.semgrep/malicious.yml` | Code rules for products: download-and-execute, reverse shells, mining, reading the Pod's token. |
| `templates/` | Starters to copy: a team, three products, and DAGs that use them. Checked by CI, never published. |
| `teams/` | Empty but for its README: a new catalog's teams go here. |
| `samples/local/` | A sample team with no cloud or secrets: one product in Python, TypeScript, Go, PowerShell and Rust. New teams copy starters from it by language; published whole, it proves an install end to end. |
| `docs/onboarding-with-ai.md` | For catalog teams using an AI assistant to add a team or product. |
| `samples/gcp/` | A sample team whose products call real, billed Google Cloud APIs, copied into a team once a cloud identity is set up. |
| `samples/aws/` | The same for AWS: an S3 bucket, an App Runner service, RDS for PostgreSQL (its password kept by Secrets Manager), keyless through EKS Pod Identity or IRSA. Not yet proven against an account. |
| `samples/azure/` | The same for Azure: a resource group, a Container App, a PostgreSQL flexible server with Entra sign-in only, keyless through AKS Workload Identity. Not yet proven, and needs a step Pod label the kernel can't set yet. |

## Not in git

| Path | What it's for |
| --- | --- |
| `_local/` | Your own scratch space: a clone of your own catalog repository, notes. Never committed. |
| `node_modules/`, `dist/`, `.venv/`, caches | Installed dependencies and build output. |

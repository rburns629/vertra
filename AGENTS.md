# Codebase guide

Acyclix runs pre-resolved DAGs of containerized "product" steps as
Kubernetes Jobs, passing each step's outputs to the steps that depend on
them, with each team's credentials kept to its own namespace and its own
reviewed products. A step can be anything packaged as a container, from a
hello-world script to creating cloud infrastructure. Long-form docs
already exist — check them before re-deriving anything:

- `docs/architecture.md`: what Acyclix is, the pieces, the request flow,
  the data, and the design decisions. Start here.
- `docs/operations.md`: installing (kind and Helm), upgrading, databases,
  backups, network policies, troubleshooting.
- `docs/security-model.md`: what's enforced and by which layer, secrets and
  vault sync, what isn't enforced yet.
- `docs/repository-map.md`: every folder and file, one line each. Update it
  when adding, moving or removing files.
- `docs/architecture/`: draw.io diagrams (system, UML classes for both
  services, a submit-to-finished sequence, state machines), all written by
  `generate.py`. Rerun it after changing code; don't hand-edit the .drawio.
  The database tables are in `console/docs/06-database-schemas.md`, which
  tests in both projects keep in step with the models.
- `kernel/ARCHITECTURE.md`: the kernel's layer rules and a literal
  call-by-call trace of submit → claim → dispatch → poll → finalize.
- `console/docs/`: the user guides the console serves (getting started,
  secrets, DAGs, the API, the database tables).
- `TODO.md`: the actionable follow-up list (security, access, operations,
  housekeeping). Check it before proposing work; update it when an item is
  done or a new one is found.
- `cli/DESIGN.md`: the design for `acyclixctl`, the installer CLI (Go,
  OpenTofu for the cloud side); read it before working on `cli/`.
- `catalog-template/`: what a new catalog repository starts as. Its docs
  (including `docs/onboarding-with-ai.md`) are for catalog teams, **not**
  instructions for this repo.
- `helm/values/{kind,gke}/*.yaml`: each environment's Helm settings, the whole
  of them (`make kind-deploy` and `make gke-deploy` use `--reset-values`). A
  setting that isn't in these files isn't deployed.

## Layout

Two independent projects share one repo so they can be deployed together.
They share no environment or code. Build and test each one from inside
its own directory.

- **`kernel/`** (Python 3.12, FastAPI, SQLAlchemy async, asyncpg, Alembic).
  One image, two processes that never talk to each other directly and
  coordinate only through Postgres rows:
  - `kernel-api` (`app/main.py`): accepts/reads/cancels/retries executions.
    It accepts only the console, by its ServiceAccount token (`app/api/auth.py`,
    TokenReview), and must only be reachable in-cluster.
  - `kernel-scheduler` (`python -m app.scheduler`): polls forever,
    claims READY tasks with `FOR UPDATE SKIP LOCKED` + leases, dispatches
    via `KubernetesExecutor`, polls status, releases dependents. A failed
    tick is logged and retried from durable state on the next one.
  - Layering only points one way: `contracts → domain → persistence →
    services | scheduler → executors → api → main`. `domain/` has no I/O.
    `services/` and `scheduler/` never import each other.
- **`console/`** (execution-console: TypeScript, Fastify 5, Drizzle/pg,
  `@kubernetes/client-node`). It is the authenticated front door to
  kernel-api: teams/users/bots, per-team secret registration, execution
  viewing/submission. All API routes live under `/api` (`src/index.ts`).
  The same process serves the React SPA from `frontend/dist`, giving one
  origin with no CORS.
  - `console/frontend/`: React 19, MUI, Vite, react-router. It has its own
    `package.json`.
  - `src/k8s.ts`: every Secret, ServiceAccount and ExternalSecret write.
    These writes are security-sensitive and idempotent (read, then
    create-or-replace; a product's ServiceAccount is create-only). The
    console creates no RBAC: it may only delete the per-secret Roles older
    versions made.
- **`helm/`**: everything Helm. `helm/charts/` holds the two charts,
  `execution-kernel` (api + scheduler + Postgres) and `execution-console`
  (+ its own Postgres), with neutral defaults; `helm/values/{kind,gke}/` holds
  each cluster's settings for them and for the third-party charts (ESO,
  policy-controller). The Helm release names are
  `kernel` and `console`, installed into the platform's own namespace
  `acyclix-system`, never a team namespace.
- **Task namespaces are allowlisted by an admission policy**
  (`helm/charts/execution-kernel/templates/dispatch-policy.yaml`). The scheduler
  can only create Jobs in namespaces labelled `acyclix/team=true`, and
  never in its own. A rejection surfaces as a non-retryable
  `DISPATCH_REJECTED` task failure. New team namespaces need the label.
- **Task images are allowlisted too** (`helm/charts/execution-kernel/templates/image-policy.yaml`).
  A task may only run an image under an allowed source: the source registry
  set at install (`imagePolicy.sourceRegistry`) plus whatever admins add on
  the Admin page. Both live as CEL literals inside the admission policy
  itself, which the console edits (`console/src/imagePolicy.ts`, same matching
  rules as the CEL). Not a ConfigMap parameter: on Kubernetes 1.36, once a
  policy with a `paramRef` was deleted and recreated, later ConfigMap edits
  stopped taking effect. A refusal is a non-retryable `IMAGE_NOT_ALLOWED`. On kind, task
  images live in the local registry `localhost:5001` (`make kind-registry`),
  not `kind load`.
- **Step identity is enforced in the cluster too**
  (`helm/charts/execution-kernel/templates/identity-policy.yaml`). A step runs
  as `default` with no Secrets unless it's a registered product, which runs
  as the ServiceAccount its `product.yaml` declares (or `default`) and may
  mount any Secret its team registered: the same rule as the console's
  `identityRefusal`. Secrets are per team, chosen per step (`secretRefs`);
  `requiredSecrets` in a product.yaml is documentation. The products and
  each team's secret names live as CEL literals in the policy, which the
  console rewrites whenever products or secrets change and at startup
  (`console/src/productPolicy.ts`). A refusal
  is a non-retryable `IDENTITY_NOT_ALLOWED`. Because the console edits this
  policy and the image policy, Helm 4's server-side apply sees it as their
  owner: upgrade the kernel chart with `--force-conflicts` (the Makefile
  does), or it fails with a conflict.
- **Every image is pinned and scanned.** The console pins each task's image
  to its digest at submission (`repo:latest@sha256:…`, `console/src/
  registry.ts`; DAGs may say `:latest`), and scans every digest before it's
  registered or run (`console/src/scanning.ts`: a Trivy client Job against
  the console chart's Trivy server; a fixable HIGH/CRITICAL or a secret
  fails it). The kernel chart's `scan-policy.yaml` refuses unpinned images
  and failed digests (`IMAGE_NOT_PINNED`, `IMAGE_SCAN_FAILED`), from a list
  the console keeps current.
- **Catalog images can be required to be signed** (`imageSignature` in the
  kernel chart, `templates/image-signature.yaml`; on in the GKE values).
  Catalog CI signs them after they pass its security scans, with a generated
  key, a cloud KMS key, or keyless (its own OIDC identity); the chart accepts
  public keys and/or a keyless identity, and Sigstore's policy-controller
  (any cluster; `helm/values/gke/policy-controller.yaml`) refuses unsigned
  ones with `IMAGE_NOT_SIGNED`. The controller refuses any image it can't
  resolve to a digest in every namespace it covers, so it must exclude the
  platform's own namespace, and it isn't installed on kind (it can't reach
  `localhost:5001`).
- **Team lifecycle, namespaces included, is the console's**: creating a
  team creates its namespace (`acyclix/team=true`); a team can be
  *retired* (reversible: read-only in the console, namespace relabelled
  `acyclix/team=retired`) and then *purged* (soft-deleted so its name stays
  reserved; `DELETE /api/teams/:name`). The namespace stays, labelled
  retired, for a cluster administrator to delete: the console may delete it
  only with `teamNamespaces.purge`, off on purpose so the identity that
  retires a namespace can't also delete it. The console also
  applies a team's reviewed SecretStore file (`PUT
  /api/teams/:team/secret-store`, checked by `console/src/secretStores.ts`).
  So the catalog's workflows only call the console (`./catalogctl teams …`,
  `./catalogctl secret-stores …`) and hold no cluster credentials. The
  console chart's `namespace-policy.yaml` limits what it may do to
  namespaces; the kernel chart's `purge-policy.yaml` lets a configured
  purger delete only retired ones. Write routes call
  `replyIfRetired` (`console/src/routes/retiredTeam.ts`). Team lookups skip
  purged teams unless they use `findTeamByNameIncludingDeleted`.
- **`catalog-template/`**: what a new catalog repository starts as
  (catalogctl, its workflows, the starter `templates/`, an empty `teams/`
  for the adopter's first team, and `samples/`: `local`, one no-cloud
  product in five languages that new teams copy starters from, and `gcp`,
  `aws`, `azure`, billed cloud examples; azure unproven). It's
  versioned with the platform because its workflows and schemas must match
  the console's API; `.github/scripts/catalog-template.sh` runs catalogctl
  in it with samples installed as teams (CI checks it that way, and
  `make catalog-publish` publishes it that way). A team's real products live in its own catalog
  repository, created from this, **not here**; adding a product needs no
  change to this repo.
- **`_local/`** (gitignored): personal scratch space, such as a clone of
  your own catalog repository.
- `examples/`: fake demo products (`project-product`,
  `application-product`, `hello-world-app`) that deliberately share no code.

## Core contracts worth knowing before touching code

- **Product container contract**: the kernel mounts a ConfigMap with
  `request.json` at `/platform/input` (read-only). The action is passed as
  the container's `args`. The container writes `result.json` to
  `/platform/output`, which is read back via `terminationMessagePath`, so
  no sidecar is needed. Job names are prefixed `ek-`.
- **Input references**: a task input of exactly
  `{"$fromTask": "<id>", "$output": "<name>"}` is replaced with the
  upstream task's output at dispatch time
  (`app/contracts/task.py:try_parse_input_reference`,
  `app/scheduler/input_resolution.py`).
- **Team = namespace**: a task's `team` is its dispatch namespace, and its
  `serviceAccount` is the Pod's identity. `secretRefs` name the Secrets to
  mount. On the UI side, `teams.name` doubles as the namespace name by
  convention (`console/src/db/schema.ts`). There is deliberately no separate
  column for it.
- **UI authorization**: a team-scoped route requires the caller to be a
  member of that team or an admin: `auth/access.ts` (`replyIfNotTeamMember`,
  `canActForTeam`, and `loadExecutionOrReply` for an execution, "any" of
  its teams to see it, "every" to cancel it). Use those; never call
  kernel-api from a new route without that check.
- **UI error handling**: one global Fastify error handler strips every
  5xx down to a generic message, because `@kubernetes/client-node` errors
  carry cluster response bodies and headers. Don't add per-route
  try/catch fallbacks.
- **Config**: kernel config lives in `app/config.py` (`Settings`,
  pydantic-settings). UI config lives in `src/config.ts` (`requireEnv`
  for `DATABASE_URL`, `JWT_SECRET`, `KERNEL_API_URL`). Add new options
  there, not via scattered env reads.

## Commands

Local cluster (repo root; `docs/operations.md` has the rest):

```
make quickstart  # from nothing (or any state) to a running local install; rerunnable
make up          # resume the kind node, clear Unknown pods, port-forward console → http://localhost:18080
make down        # docker stop the node (keeps all data; never `kind delete cluster`)
make logs        # stern tail of kernel-api/scheduler/console on kind
make build-products   # build the demo product images
make catalog-publish CATALOG=<dir>   # local mode: publish a catalog folder's products to kind
make kind-deploy # helm upgrade both releases on kind (runs migrations)
```

The kind values set a fixed admin password for local use only; never
reuse it anywhere else.

CI (`.github/workflows/ci.yml`, `security.yml`) runs every check below on
each PR, plus `helm lint`/render of `helm/values/*`, actionlint, a Trivy/OSV scan
of both platform images, Semgrep and gitleaks.

Kernel (`cd kernel`):

```
pip install -e ".[dev]"
pytest                                   # all tests
pytest tests/unit                        # pure logic, no I/O
pytest tests/integration/test_claiming.py::test_name   # single test
ruff check .                             # line length 100
mypy .                                   # strict
alembic revision --autogenerate -m "..." # after editing persistence/models.py
```

- Integration and end-to-end tests use **real Postgres**: `make test` (repo
  root) starts a throwaway container on `127.0.0.1:55432`, migrates both test
  databases and runs both suites; `make test-db` does just the databases.
  Both suites read `TEST_DATABASE_URL`, defaulting to
  `localhost/execution_{kernel,console}_test` (what CI uses). A missing
  database fails rather than skips. Never point the tests at an install's
  databases. Each kernel test runs in a rolled-back transaction.
- Kubernetes tests **skip** (they don't fail) when there's no Docker
  daemon, no reachable cluster, no `kind` CLI, or when the current kubectl
  context isn't a kind cluster. They build fixture images with Docker and
  `kind load docker-image` them into the current context's cluster. They
  run in a namespace called `execution-kernel`, which must exist
  (`kubectl create namespace execution-kernel`); without it they skip as
  "not reachable".
- `tests/fakes.py:FakeExecutor` is the in-memory executor for scheduler
  logic tests.

UI (`cd console`, and separately `cd console/frontend`):

```
npm run dev | build | typecheck | lint     # backend (tsx / tsc / eslint)
npm run db:generate                        # drizzle-kit, after editing src/db/schema.ts
npm run db:migrate
cd frontend && npm run dev | build | lint  # vite / tsc -b + vite build / oxlint
```

`npm test` (vitest) runs `console/test/*.test.ts` against a real, migrated
Postgres database called `execution_console_test`. The setup commands are
in `console/vitest.config.ts`. They cover auth (sessions, password
change and reset, login rate limiting), execution access (team
membership, team secrets, product-bound ServiceAccounts, retry and
cancel), the image policy, products and team lifecycle. A new
authorization rule gets a test there.

CLI (`cd cli`, Go 1.26+; CI uses the `golang:1.27-alpine` image by digest):

```
go test ./...                              # unit tests: config, prompts, values, the approval screen
go vet ./... && gofmt -l .
go build -o acyclixctl ./cmd/acyclixctl    # then e.g. ./acyclixctl init dev; ./acyclixctl apply dev
```

`acyclixctl` keeps each environment in `./deploy/<env>/` (gitignored here),
or wherever `--config`/`ACYCLIX_CONFIG` points. It only runs kubectl,
helm, docker and kind (each pinned and checksum-verified when it downloads
them). To try it end to end without touching your own install, give it a
kind cluster of its own (`--cluster-name`); it shares the `kind-registry`.

## Things that bite

- NetworkPolicies (`templates/networkpolicy.yaml`) let only the kernel
  release's own Pods (and the console's) reach Postgres, and only the
  console reach kernel-api. A new component, or a debugging Pod, can't
  connect until it carries those labels. Checking a database password from
  inside the Postgres Pod proves nothing: local connections are trusted.
- After rebuilding a platform image for kind, you must `kind load
  docker-image <img> --name <cluster>` again. Otherwise the cluster keeps
  running the stale image, or fails with `ImagePullBackOff`.
- Ask before deploying to any shared or billed cluster (`helm upgrade`,
  `kubectl apply`, image rollouts), especially while a design discussion
  is still open. Prove changes on kind first.

# Engineering principles for this project

These are descriptive of how this codebase has actually been built, not
aspirational. Where a rule below conflicts with what's already shipped,
the shipped code is right and the rule is wrong — flag it rather than
silently diverging either way.

**Scope:** applies to `kernel/` and `console/` — anything that ships. Code
under `examples/` is illustrative/reference material for demos and is
exempt from the production bar below (it still shouldn't do anything
actively dangerous — no real credentials, no unsafe subprocess/shell use
— but it doesn't need the same hardening, test depth, or observability as
real kernel/UI code).

## 1. Simplicity over ceremony

- The test for an abstraction is whether it corresponds to real
  complexity, not how many times something has been typed out. `Executor`
  is a `Protocol` with exactly one production implementer
  (`KubernetesExecutor`, since `DockerExecutor` was removed when the
  platform went Kubernetes-only). It still earns its keep because it
  makes the code testable: `run_scheduler_tick` holds all the claiming,
  retry and DAG-progression logic, and it's tested against `FakeExecutor`
  without needing a real cluster. That's a concrete, present need. What's
  *not* earned is abstraction built for a need that's speculative
  or merely imagined — a plugin system for a second implementation that
  isn't planned, a second production backend "just in case." The
  scheduler constructs `KubernetesExecutor` directly in
  `app/scheduler/__main__.py`, with no factory and no selection logic,
  because there's nothing to select between.
- Duplication across genuinely independent artifacts is often correct,
  not a smell. Every `gcp/*` product's `entrypoint.sh` is copied verbatim
  on purpose — a platform team can change one product's language without
  touching another's file, at the cost of a few duplicated lines. Don't
  extract a shared library across things that are independently owned,
  independently deployed, or meant to be swappable/replaceable
  (`examples/project-product` and `examples/application-product`
  deliberately share nothing, since real vendors' containers wouldn't).
  Duplication *within* one owner's own code, doing the same thing for no
  reason, is still worth removing.
- Python's structural typing (`Protocol`) is the idiomatic interface
  mechanism here, not class hierarchies built for polymorphism nobody
  needs yet (`Executor` is a `Protocol`; `DockerExecutor`/
  `KubernetesExecutor` don't share a base class).
- `dict[str, Any]` is sometimes the *correct* type, not a lapse — task
  `inputs` are structurally opaque to the kernel by design (it must not
  need to understand any given product's semantics). Don't force a
  narrower type onto data that's supposed to stay opaque at that layer.

## 2. Security — concrete, not aspirational

**Secrets never touch the places that persist or distribute things.**
- Never in git, in any form, at any stage — not a raw value, not a
  "just for now" placeholder, not a `.env.example` with a real value
  filled in. Never in an image layer (image layers are permanent and
  distributed via registry pulls — a secret in a layer is recoverable
  even if a later layer deletes the file).
- Never in a URL, including a git remote — `https://<token>@github.com/...`
  puts a live credential in plaintext in `.git/config` and in every tool
  or log that ever echoes the remote. Use SSH keys or a credential
  helper instead.
- Never in `outputs` that flow back through an API response or get
  persisted — a product container's `result.json` must never echo back
  the credential material it used, since `outputs` is exactly what an
  ordinary caller of `GET /v1/executions/{id}` can read.

**Prefer no standing credential over a well-guarded one, and a narrow one
over a broad one.**
- Where the target platform supports it, use impersonation/federation
  (short-lived tokens, minted on demand) over a static key
  (`GCP_TARGET_SERVICE_ACCOUNT` + `impersonated_credentials`, not a
  downloaded service-account key file).
- When a static credential is genuinely unavoidable, scope it to exactly
  what the one thing it's used for needs (`roles/browser` for a
  read-only check, not `roles/editor` "to be safe") — grant on the
  narrowest resource that makes sense (a specific secret via RBAC
  `resourceNames`, a specific service account, a specific Artifact
  Registry repository), not the broadest one that happens to work.
- One identity per real distinction that matters, not one shared
  identity for convenience. The boundaries that matter here: a team's
  secrets reach only that team's reviewed products (never another team,
  never an unreviewed image), and each step gets only the secrets it lists.
  Within a team, secrets are deliberately shared: the team chooses which
  step gets which (decided 2026-10-17). A cloud identity is the narrower
  thing — bind it to a product's own ServiceAccount, not one every product
  of the team runs as, so one product's cloud permissions don't become all
  of them.

**Build-time and run-time stay strictly separated.**
- An image is a generic, secret-free artifact — the same bytes run for
  every team, every execution, forever, until the code changes. Whatever
  a task needs to authenticate with gets attached at dispatch time (a
  mounted Secret, an env var), never baked into the thing `docker build`
  produces.

**Trust boundaries get validated; internal calls don't.**
- Validate at the edges — API request bodies, product container
  `result.json`, anything crossing from outside the process. Don't
  re-validate what an internal function's own type signature and the
  caller's contract already guarantee.
- Never build a shell command, SQL query, or file path by concatenating
  untrusted input. `KubernetesExecutor` builds Jobs only through the
  Kubernetes client's structured objects: the image name, the action
  passed as list-form `args`, and task inputs delivered as a
  `request.json` ConfigMap rather than being interpolated into a
  command. That way consumer-controlled task input can never become a
  shell injection vector. The same applies to `console/src/k8s.ts`. That's
  the model, not string formatting plus escaping.

**Fail loudly, not into a fallback that might be a security hole.**
- A blanket "wrap it in try/catch with a fallback" is itself a risk when
  the thing being swallowed is an auth or permission check — a fallback
  that silently allows something on error is a vulnerability wearing a
  resilience pattern's clothes. Errors that indicate a real, unexpected
  failure should propagate and be handled once, deliberately, at the
  layer that knows what durable, safe recovery actually looks like (the
  scheduler's outer loop catching and logging, then retrying from
  durably-persisted state on the next poll — not each internal call
  guessing at its own fallback).

## 3. Production-readiness, beyond security specifically

- **Prove it against the real thing before calling it done.** Mocked
  unit tests prove logic branches; they don't prove a real credential
  authenticates, a real RBAC binding actually restricts access, or a
  real container mount works the way the code assumes. Where a claim is
  "this secret is isolated" or "this now authenticates," it needs a
  real Kubernetes cluster or real cloud call behind it at least once,
  not just a passing mock.
- **Typed, validated configuration**, not ad hoc `os.environ.get()`
  scattered through the code — one `Settings` object (pydantic-settings),
  validated at startup, so a misconfiguration fails immediately and
  legibly instead of surfacing as a confusing runtime error three calls
  later.
- **Structured logs and metrics on real code paths**, not print
  statements — every request, every credential-adjacent action, in a
  form that's queryable later, not just readable in the moment.
- **Idempotency for anything that mutates external state**, since
  execution here is at-least-once by design — a retried task must not
  double-create a resource or double-charge an external system. This is
  a requirement on product code specifically, not something the kernel
  can enforce for you.
- **Typed, explicit domain errors** (`KernelError` and its subclasses,
  `StructuredError`) over bare strings or generic exceptions — an error
  should carry enough structure for a caller to make a real decision
  (retryable or not, what actually failed), not just a message to log.

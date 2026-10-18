# Architecture & Code Reference

A map of this repository: what every file is for, what its key functions do,
and — most importantly — the actual order operations happen in when the
kernel runs. Written as a reference to come back to, not a one-time read.

## Table of contents

1. [What this is, in one paragraph](#what-this-is-in-one-paragraph)
2. [Repository layout](#repository-layout)
3. [How the layers depend on each other](#how-the-layers-depend-on-each-other)
4. [End-to-end order of operations](#end-to-end-order-of-operations) — the core of this doc
5. [File-by-file reference](#file-by-file-reference)
6. [Tests](#tests)
7. [Deployment files](#deployment-files)

---

## What this is, in one paragraph

The kernel accepts an already-resolved DAG of containerized tasks (an
upstream planner decided *what* to run; the kernel only runs it), persists
it to Postgres, and two **separate OS processes** — `kernel-api` (FastAPI,
`app/main.py`) and `kernel-scheduler` (`app/scheduler/__main__.py`) — do the
rest without ever talking to each other directly. The API only reads and
writes rows. The scheduler polls those same rows in a loop, claims work,
dispatches it as a Kubernetes Job (behind the `Executor` interface), and
writes the outcome back. Postgres is the only thing both
processes have in common — that's deliberate, not an oversight (see
`app/persistence/database.py`'s docstring).

## Repository layout

```
app/
├── contracts/     Pydantic models — the wire/storage shapes. No logic.
├── domain/        Pure business logic: states, DAG validation, credential shapes, errors, events. No I/O.
├── persistence/   SQLAlchemy models, the async engine, query repositories, and the
│                  Alembic migrations (persistence/migrations/).
├── services/      Orchestration for API-triggered use cases (submit/cancel/retry/read).
├── scheduler/     The polling loop: claim → dispatch → poll → finalize.
├── executors/     The Executor protocol and its one real implementation, KubernetesExecutor.
├── api/           FastAPI routes and dependencies. Talks to services/persistence only.
├── observability/ Structured logging, Prometheus metrics, the HTTP request middleware.
├── config.py      Settings, sourced from environment variables.
└── main.py        The kernel-api process entry point.

tests/
├── unit/          Pure logic, no I/O.
├── integration/   Real Postgres, real (kind) Kubernetes — never mocks.
├── end_to_end/    The full two-task chain, proven through the real stack.
├── fixtures/      A minimal Docker image used only to exercise executor mechanics.
├── conftest.py    Shared fixtures: db_session, docker_client, k8s_apis, api_client, image builds.
└── fakes.py       FakeExecutor — an in-memory Executor double used across unit + integration tests.

Dockerfile, Makefile                       Image build; see ../Makefile (project root) and
                                            ../helm/charts/execution-kernel for how this actually deploys —
                                            that chart lives at the project root, alongside
                                            ../helm/charts/execution-console, not inside kernel/.
alembic.ini, pyproject.toml                Tooling config.
```

## How the layers depend on each other

Dependencies only point one direction — nothing in an earlier layer ever
imports from a later one:

```
contracts  →  domain  →  persistence  →  services / scheduler  →  executors  →  api  →  main
```

- **contracts** depend on nothing but `domain`'s enums (for typed response
  fields like `state: ExecutionState`).
- **domain** depends on nothing — no SQLAlchemy, no FastAPI, no I/O of any
  kind. This is why `app/domain/dag_validation.py` and
  `app/domain/states.py` are unit-tested with zero database or Docker
  involvement.
- **persistence** depends on `domain` (enums stored in columns) and
  `contracts` are *not* imported here — the ORM models are independent of
  the wire format.
- **services** and **scheduler** are peers: both sit above persistence and
  depend on `domain` + `contracts` + `executors` (scheduler only).
  `services` never imports `scheduler` or vice versa — the API layer talks
  to `services`, the scheduler process talks to `scheduler`, and both only
  actually communicate through the database rows they share.
- **executors** depends only on `contracts` (for `ProductRequest`) and
  `domain` — nothing about Postgres.
- **api** is the thinnest layer: it depends on `services` + `persistence`
  (for the two read-only repository calls) + `contracts`, and contains no
  business logic of its own.

## End-to-end order of operations

This is a literal trace of function calls for the canonical
`create-project → deploy-application` example, in the order they actually
happen. Read this section when you need to know "what calls what."

### 1. Submitting an execution

```
POST /v1/executions
  → app/api/auth.py : require_caller()                        [the console's token, TokenReview; else 401/403]
  → app/api/routes/executions.py : create_execution()
      → app/api/dependencies.py : get_db_session()            [one DB session, one transaction]
      → app/services/execution_service.py : submit_execution()
          → app/persistence/repositories.py : get_execution_by_idempotency_key()
              [found?] → return existing (created=False) — nothing else runs
          → app/domain/dag_validation.py : validate_dag()
              → topological_sort(), _validate_dependencies(), _validate_input_references()
              [invalid?] → raises DAGValidationError → route returns 422 with every issue found
          → _build_execution_graph() → _build_task()
              → app/domain/states.py : initial_task_state()   [READY if no deps, else BLOCKED]
              → constructs Execution / ExecutionTask / TaskDependency (persistence/models.py)
          → session.begin_nested()                            [a savepoint, not the whole tx]
              → session.add(execution) → flush()               [task ids now exist]
              → session.add_all(dependencies)
              → app/persistence/repositories.py : record_event(EXECUTION_CREATED)
              → flush()
          [lost a race on the idempotency key?] → catch IntegrityError, re-query, return existing
      ← ExecutionSubmissionResult(execution_id, state=PENDING, created=True)
  ← 201 (or 200 if it was a replay), body = ExecutionSubmissionResponse
```

Nothing has *run* yet — only rows exist: one `executions` row (`PENDING`),
one `execution_tasks` row per task (`READY` or `BLOCKED`), edges in
`task_dependencies`, one `execution_events` row.

### 2. The scheduler loop

`kernel-scheduler` is a separate process (`python -m app.scheduler`)
polling the same database on a timer — nothing here is triggered by the API
request above; it happens whenever the next poll tick lands.

```
app/scheduler/__main__.py : main() → run_forever()
  → app/config.py : get_settings()
  → loop.set_default_executor(thread_pool_for(...)) [threads for scheduler_executor_concurrency + 4
                                                     Kubernetes calls; Python's own default is
                                                     "node CPUs + 4"]
  → KubernetesExecutor(...)                        [constructed directly — the only real backend]
  → executor.start_watching()                       [watches the kernel's Jobs and Pods, all namespaces]
  loop forever:
    → session_scope()                               [one transaction per tick]
    → app/scheduler/service.py : run_scheduler_tick()  → progressed?
    [progressed?] → next tick at once (after 50 ms)
    [otherwise]   → executor.wait_for_change(scheduler_poll_interval_seconds)
                    [a watched Job or Pod change wakes it early]
    [tick raised?] → log it, keep looping — next tick retries from durable state
```

`run_scheduler_tick()` is three phases, every tick. Only the executor calls
overlap (up to `scheduler_executor_concurrency` at once): the database
session can't be shared between concurrent tasks, so every row read and write
stays in order.

**Phase A — Claim** (`app/scheduler/claiming.py : claim_ready_tasks()`)
```
→ recover_expired_leases()
    [any CLAIMED/RUNNING task whose lease_expires_at has passed]
    RUNNING → keep state and executor_handle, lease_owner = this host
              (adopted: polled from now on, its Job not started twice)
    CLAIMED → reset to READY, clear lease_owner/lease_expires_at/executor_handle
    (a scheduler that crashed or was replaced doesn't strand its work forever)
→ SELECT ... FOR UPDATE SKIP LOCKED
    WHERE state = READY AND available_at <= now
      AND execution.state IN (PENDING, RUNNING)     [a dead execution gets no more claims]
→ for each claimed task:
    state = CLAIMED, lease_owner = this host, lease_expires_at = now + lease_duration
    attempt_count += 1 → INSERT TaskAttempt
    record_event(TASK_CLAIMED)
```

**Phase B — Dispatch** (`app/scheduler/service.py : _dispatch_tasks()`: resolve each in order,
start them all concurrently, then record each start in order)
```
→ app/scheduler/input_resolution.py : resolve_task_inputs()
    → query task_outputs JOIN task_dependencies for this task's direct dependencies
    → resolve_inputs()                               [pure — no I/O]
        → walks original_inputs recursively
        → app/contracts/task.py : try_parse_input_reference()
            [is this a {"$fromTask":..., "$output":...} marker?]
        → replaces every marker with the real value from the upstream task's outputs
    [referenced output never produced?] → raises MissingOutputError (non-retryable)
→ build ResolvedTask (app/executors/base.py)
→ executor.start(resolved_task)                      [KubernetesExecutor]
    ← ExecutionHandle (opaque dict — {namespace, jobName})
    refused by the cluster (DispatchRejectedError)
        → executor.discard(resolved_task) → _handle_task_failure(code, retryable=False)
    raised anything else (a timeout, a lost response: the Job may exist anyway)
        → dispatch_failures += 1
        [below scheduler_max_dispatch_failures?]
            → return_unstarted_attempt()  [delete this TaskAttempt, attempt_count -= 1,
                                           state = READY: the next claim reuses the same
                                           attempt number, so the same Job name, and
                                           start() adopts that Job]
            → available_at = now + RetryBackoff.delay(dispatch_failures)
            → record_event(TASK_DISPATCH_RETRY)
        [at the limit] → executor.discard(resolved_task)
                       → _handle_task_failure(EXECUTOR_START_FAILED, retryable=True)
→ dispatch_failures = 0
→ persist resolved_inputs + executor_handle, state = RUNNING
→ TaskAttempt.started_at = now
→ _mark_execution_running_if_needed()                 [PENDING → RUNNING on the first dispatch]
→ record_event(TASK_STARTED)
```

**Phase C — Poll** (every RUNNING task this scheduler instance owns: all their statuses are
read concurrently first, then `_poll_task()` acts on each in order)
```
→ executor.get_status(handle)                         [read before _poll_task, alongside the rest;
                                                       skipped (RUNNING) for a Job whose watch saw no
                                                       change since a read within the resync interval]
→ [execution.state == CANCELLED?]
    → executor.cancel(handle) → task.state = CANCELLED → record_event(TASK_CANCELLED) → done
→ [now - attempt.started_at > task.timeout_seconds?]
    → executor.cancel(handle) → _handle_task_failure(TASK_TIMEOUT, retryable=True)
→ the status read above:
    raised    → _handle_task_failure(EXECUTOR_STATUS_FAILED, retryable=True)
    RUNNING   → renew the lease (heartbeat) — nothing else changes
    SUCCEEDED → persist TaskOutput
                → task.state = SUCCEEDED → record_event(TASK_SUCCEEDED)
                → _release_ready_dependents()
                    [lock each dependent (FOR NO KEY UPDATE), then:
                     any BLOCKED task whose every dependency is now SUCCEEDED] → state = READY
                → _settle_execution()
                    [lock the execution (FOR NO KEY UPDATE), then:
                     every task SUCCEEDED?] → execution.state = SUCCEEDED
                                             → record_event(EXECUTION_SUCCEEDED)
                     [a task FAILED and none left that can run?] → _fail_execution()
                    The locks are what make concurrent schedulers safe here: two
                    passes finishing two dependencies (or an execution's last two
                    tasks) at once are serialized, so the second sees the first's
                    commit. NO KEY UPDATE, not UPDATE: rows referencing these
                    (events, outputs) take FOR KEY SHARE, which UPDATE would
                    conflict with. Lock order everywhere: tasks, then execution.
    FAILED    → _handle_task_failure(status.error)
```

`_handle_task_failure()`:
```
→ record the failure on the current TaskAttempt
→ app/domain/states.py : should_retry(attempt_count, max_attempts, retryable)
    True  → task.state = READY, clear lease/handle,
            available_at = now + RetryBackoff.delay(attempt)   [5s, doubling, capped]
            (a later tick's Phase A claims it then — same code path as any other READY task)
    False → task.state = FAILED, record_event(TASK_FAILED)
            → _fail_execution()
                → execution.state = FAILED → record_event(EXECUTION_FAILED)
                → every READY/BLOCKED sibling → state = CANCELLED (they will never run now)
```

Inside the executor (`app/executors/kubernetes.py`, the one implementation
of the `Executor` protocol in `app/executors/base.py`; nothing above
depends on it directly):

- `start()` creates a Job whose Pod has an `emptyDir` at
  `/platform/output`, then a ConfigMap holding `request.json` (mounted
  read-only at `/platform/input`) that names the Job as its owner, so
  Kubernetes deletes it along with any Job the scheduler never finalizes.
  The names are derived from (execution, task, attempt): a Job already
  there under its name is this same attempt's, from a tick that rolled
  back or a start that raised after making it, and is adopted rather than
  started twice (its ConfigMap created if missing). Every Job carries
  `activeDeadlineSeconds` (the task's timeout plus a grace period), so
  Kubernetes stops one the scheduler has lost track of. `discard()` deletes
  an attempt's Job and ConfigMap by name, when the scheduler gives up on it.
- No sidecar is needed because the container's `terminationMessagePath`
  is pointed directly at `/platform/output/result.json`, so Kubernetes
  itself reads that file back out after the container exits. `get_status()`
  reads it off the Pod's status, then deletes the Job and ConfigMap, and
  caches the result for 15 minutes in case the tick rolls back.

### 3. Reading status

```
GET /v1/executions/{id}
  → app/api/routes/executions.py : read_execution()
      → app/services/execution_service.py : get_execution_detail()
          [fetches the SAME rows the scheduler is concurrently writing — always live, never cached]

GET /v1/executions/{id}/events
  → read_execution_events() → app/persistence/repositories.py : get_execution_events()
      [plain ordered SELECT on execution_events]
```

### 4. Cancelling

```
POST /v1/executions/{id}/cancel
  → cancel_execution_route() → app/services/execution_service.py : cancel_execution()
      [already CANCELLED?] → no-op, still 200 (idempotent)
      [already SUCCEEDED/FAILED?] → 409, refused
      → UPDATE every READY/BLOCKED task → CANCELLED (never dispatched, nothing to stop)
      → UPDATE execution → CANCELLED, only if still PENDING/RUNNING
          (conditional UPDATEs: one the scheduler is dispatching right now is
           re-checked after its commit and left RUNNING, not overwritten)
      → record_event(EXECUTION_CANCELLED)
      [RUNNING/CLAIMED tasks are left alone here —
       the API process has no live executor to call .cancel() on;
       the next scheduler poll tick (Phase C above) does the real work]
```

### 5. Retrying a failed task

```
POST /v1/executions/{id}/tasks/{task_id}/retry
  → retry_task_route() → app/services/execution_service.py : retry_task()
      [task isn't FAILED?] → 409, refused
      → task.state = READY, clear lease/handle/failure → record_event(TASK_RETRIED)
          (grants one more attempt regardless of maxAttempts — that cap only gates the
           *automatic* should_retry() decision above, never claiming itself)
      [execution was FAILED, which it always is if a task is FAILED] →
          execution.state = RUNNING → record_event(EXECUTION_RESUMED)
      → _revive_cancelled_siblings()
          [any task cancelled by the original failure] → READY (deps already met) or BLOCKED
          (without this, the execution could never reach all-SUCCEEDED again)
      [next tick's Phase A claims the revived task normally]
```

---

## File-by-file reference

### `app/contracts/` — wire and storage shapes

Pydantic models only. No logic beyond field-level validation. These are
what cross a real boundary: an HTTP body, a JSONB column, a file written
into a container.

#### `app/contracts/task.py`
- `InputReference` — the parsed form of `{"$fromTask": "...", "$output": "..."}`.
- `try_parse_input_reference(value)` — the *only* place that recognizes that
  marker shape inside arbitrary JSON; used by both DAG validation and input
  resolution so the shape check isn't duplicated.
- `TaskDefinition` — one task as submitted (`id`, `image`, `action`,
  `dependsOn`, `inputs`, `timeoutSeconds`, `maxAttempts`).
- `ProductRequest` — the exact JSON written to `/platform/input/request.json`
  inside a product container.

#### `app/contracts/execution.py`
- `ExecutionSubmission` — the body of `POST /v1/executions`.
- `ExecutionSubmissionResponse` — `{executionId, state}`, returned by
  submit/cancel/retry.
- `TaskStatusResponse`, `ExecutionDetailResponse` — the body of
  `GET /v1/executions/{id}`.
- `ExecutionEventResponse` — one row of `GET /v1/executions/{id}/events`.

#### `app/contracts/result.py`
- `StructuredError` — `{code, message, retryable}`, used everywhere a
  failure needs to be machine-readable (product containers, executors,
  the scheduler).
- `TaskResult` — the contents of `/platform/output/result.json`; a
  validator enforces `status=succeeded ⇒ no error` and vice versa.

### `app/domain/` — pure business logic

No I/O anywhere in this package. Everything here is unit-tested without a
database or a container in sight.

#### `app/domain/states.py`
- `TaskState`, `ExecutionState` — the state enums.
- `initial_task_state(depends_on)` — `READY` if no dependencies, else `BLOCKED`.
- `should_retry(attempt_count, max_attempts, retryable)` — the automatic
  retry decision: both conditions must hold.

#### `app/domain/dag_validation.py`
- `validate_dag(tasks, max_tasks)` — the whole submission-time gate:
  duplicate ids, self/unknown dependencies, cycles, upstream-only input
  references, and inputs that look like credentials. Collects *every* issue before raising (not fail-fast), so one
  round trip reports everything wrong.
- `topological_sort(tasks)` — deterministic (submission order breaks ties),
  raises with the cycle's members if the graph isn't acyclic.
- `_find_duplicate_ids`, `_validate_dependencies`, `_validate_input_references`,
  `_find_input_references` — the individual checks `validate_dag` composes.

#### `app/domain/credentials.py`
- `redact_lines(lines)`, `redact_text(text)` — replace recognizable
  credentials (PEM private keys, cloud keys, GitHub/Slack/Stripe tokens,
  bearer tokens, JWTs) with `[redacted <kind>]`; applied by
  `KubernetesExecutor` to every log line and error message it reads.
- `find_credential(value)` — the kind of the first credential anywhere in a
  JSON value, or None: a step's outputs holding one fail it
  (`OUTPUT_CONTAINS_CREDENTIAL`), and a submission's inputs holding one are
  refused (`INPUT_CONTAINS_CREDENTIAL`).

#### `app/domain/errors.py`
- `KernelError` — base class for every domain exception.
- `ValidationIssueCode`, `ValidationIssue` — the vocabulary `validate_dag`
  reports issues with.
- `DAGValidationError` — carries the full `list[ValidationIssue]`.
- `MissingOutputError` — raised by input resolution when a reference points
  at an output that was never produced.

#### `app/domain/events.py`
- `EventType` — every `execution_events.event_type` value that exists
  (`EXECUTION_CREATED` … `TASK_RETRIED`). One place to grep instead of
  string literals scattered through scheduler code.

### `app/persistence/` — SQLAlchemy models, engine, repositories

#### `app/persistence/database.py`
- `Base` — the declarative base every model inherits.
- `create_engine(database_url)`, `create_session_factory(engine)` — built
  once per process (API and scheduler each build their own).
- `session_scope(session_factory)` — the standard transaction wrapper:
  commits on success, rolls back on exception. `app/api/dependencies.py`
  and `app/scheduler/__main__.py` are the two callers.

#### `app/persistence/models.py`
The seven tables, one class each: `Execution`, `ExecutionTask`,
`TaskDependency`, `TaskAttempt`, `TaskOutput`, `TaskLog`, `ExecutionEvent`. State
columns use `native_enum=False` (plain `VARCHAR` + CHECK constraint, via the
`_enum_column()` helper) so adding a new state later is an ordinary
migration, not `ALTER TYPE`. `TimestampMixin` supplies `created_at`/
`updated_at` to the two tables that need them.

#### `app/persistence/repositories.py`
Thin query wrappers — no branching logic lives here (that belongs in
`services`/`scheduler`).
- `get_execution_by_idempotency_key`, `get_execution_by_id`,
  `get_execution_events` — plain SELECTs.
- `record_event(session, execution_id, event_type, ...)` — the *single*
  place anything writes to `execution_events`. Every lifecycle transition
  funnels through this one function.

### `app/services/execution_service.py` — API-triggered orchestration

The service layer behind every route except the two health checks.
- `submit_execution()` + `ExecutionSubmissionResult` — see the submission
  trace above. `_build_execution_graph()` / `_build_task()` are its private
  helpers.
- `get_execution_detail()` + `ExecutionDetail`/`TaskDetail` — assembles
  what `GET /v1/executions/{id}` needs.
- `cancel_execution()` + `CancelOutcome` — see the cancel trace above.
- `retry_task()` + `RetryOutcome`, `_revive_cancelled_siblings()` — see the
  retry trace above.

### `app/scheduler/` — the polling loop

#### `app/scheduler/claiming.py`
- `claim_ready_tasks()` — the `SELECT ... FOR UPDATE SKIP LOCKED` claim,
  safe for multiple scheduler instances to call concurrently.
- `recover_expired_leases()` — resets abandoned `CLAIMED`/`RUNNING` tasks
  back to `READY`. Called automatically at the start of every claim.
- `return_unstarted_attempt()` — when starting a Job raised, puts the task
  back to `READY` with the same attempt number, so the next pass retries
  (and adopts a Job the failed call may have created) instead of spending
  an attempt.
- `release_leases()` — on shutdown, hands this scheduler's tasks back at once.

#### `app/scheduler/input_resolution.py`
- `resolve_inputs(inputs, outputs_by_task_key)` — pure, no I/O: the
  recursive marker-replacement algorithm.
- `resolve_task_inputs(session, task)` — the database-aware wrapper:
  fetches a task's direct dependencies' persisted outputs, then calls
  `resolve_inputs`.

#### `app/scheduler/service.py`
- `run_scheduler_tick()` — the single entry point; see the three-phase
  trace above.
- `_dispatch_task`, `_poll_task`, `_handle_task_failure` — the three phases'
  per-task logic.
- `_release_ready_dependents`, `_mark_execution_running_if_needed`,
  `_settle_execution`, `_fail_execution` — the state-machine side effects
  those phases trigger. The first and third lock the row they decide about
  (see the trace above); `tests/integration/test_concurrent_completion.py`
  races two schedulers through both.
- `_get_current_attempt`, `_load_running_tasks_owned_by` — small query helpers.

#### `app/scheduler/retention.py`
- `delete_finished_executions()` — deletes finished executions (with their
  tasks, outputs, logs and events) whose last event is older than
  `execution_retention_days`, a few hundred at a time.

#### `app/scheduler/__main__.py`
- `run_forever()` — constructs `KubernetesExecutor` directly (the only real
  backend — no dispatch needed for a choice that's no longer a choice) and
  runs the actual infinite poll loop; a failed tick is logged and skipped,
  never crashes the process. SIGTERM or SIGINT ends the loop after the pass
  in progress; it then calls `claiming.release_leases`, so another
  scheduler adopts this one's tasks on its next pass. Once an hour it also
  runs the retention sweep.
- `wait_unless_stopping(stopping, waiting)` — every wait in the loop goes
  through this, so a stop signal never waits out a poll interval.
- `main()` — configures logging, calls `asyncio.run(run_forever())`. Run via
  `python -m app.scheduler`.

### `app/executors/` — one interface, one real backend

#### `app/executors/base.py`
- `Executor` (Protocol) — `start` / `get_status` / `cancel` / `get_logs` /
  `discard` (removes a Job a failed start may have left).
  `KubernetesExecutor` and `tests.fakes.FakeExecutor` both satisfy this
  structurally (no inheritance) — the Protocol earns its keep on letting
  the scheduler's own logic be tested against the fake without a real
  cluster, not on having multiple production backends.
- `ResolvedTask` — what `start()` needs; `.to_product_request()` converts
  it to the `ProductRequest` a container actually receives.
- `ExecutionHandle` — `dict[str, Any]`, opaque outside the executor that
  produced it.
- `ExecutorRunState`, `ExecutionStatus` — the result of `get_status()`; a
  validator enforces the state/outputs/error combinations make sense.

#### `app/executors/kubernetes.py`
- `KubernetesExecutor` — see the Kubernetes bullet in the scheduler trace
  above.
- `job_name_for(execution_id, task_key, attempt)` — hashes the identifying
  triple into a short, DNS-1123-safe Job/ConfigMap name (a raw UUID-based
  name routinely exceeds Kubernetes' 63-character limit).
- `_load_kube_config()` — in-cluster config when running as a Pod, local
  kubeconfig otherwise.
- Private helpers: `_create_config_map`, `_create_job`,
  `_finalize`, `_build_status`, `_find_terminated_container`, `_read_logs`,
  `_delete_job`, `_delete_config_map`.

### `app/api/` — the HTTP surface

#### `app/api/auth.py`
- `require_caller(request)` — a dependency on the whole `/v1/executions`
  router: the bearer token must pass a TokenReview for `api_token_audience`
  and belong to one of `api_allowed_callers` (the console). 401 without a
  valid token, 403 for anyone else. Successful reviews are cached for 60s
  in a bounded cache; a failing review fails the request.
- `CallerAuthenticator` — the check itself, with the review injectable
  (`tests/unit/test_api_auth.py` uses a fake). `authenticator_for(settings)`
  returns None when `api_auth` is `disabled` (local development only).

#### `app/api/dependencies.py`
- `get_db_session(request)` — one session per request via `session_scope`,
  reading the session factory FastAPI's `lifespan` stored on `app.state`.

#### `app/api/routes/executions.py`
- `create_execution` — `POST /v1/executions`.
- `read_execution` — `GET /v1/executions/{id}`.
- `read_execution_events` — `GET /v1/executions/{id}/events`.
- `cancel_execution_route` — `POST /v1/executions/{id}/cancel`.
- `retry_task_route` — `POST /v1/executions/{id}/tasks/{task_id}/retry`.
- `_issues_detail` — converts `DAGValidationError.issues` into the 422
  response body.

#### `app/api/routes/health.py`
- `live` — `GET /health/live`, never touches the database.
- `ready` — `GET /health/ready`, runs `SELECT 1`.

### `app/main.py` and `app/config.py`
- `app/main.py` — `lifespan()` builds the engine/session factory once at
  startup; `create_app()` wires up the two routers. `app` is the ASGI
  entry point (`uvicorn app.main:app`).
- `app/config.py` — `Settings` (env-var driven: `DATABASE_URL`,
  `LEASE_DURATION_SECONDS`, the step Pod settings, etc.), `get_settings()`.

---

## Tests

- **`tests/unit/`** — no I/O: the domain (`test_dag_validation.py`,
  `test_states.py`, `test_credentials.py`, ...), and `KubernetesExecutor`
  against stub APIs (`test_kubernetes_*.py`: errors, image pulls, request
  timeouts, the watch, credentials in results).
- **`tests/integration/`** — real Postgres always; a real (`kind`)
  Kubernetes cluster where the file name says so. Roughly one file per
  module under `app/`: persistence, the execution service, claiming, the
  scheduler (`test_scheduler_service.py`, `test_scheduler_edge_cases.py`,
  `test_concurrent_completion.py`, `test_dispatch_retries.py`, with
  `FakeExecutor`), logs and retention, the API, and the real executor
  (`test_kubernetes_executor.py`, `test_product_examples.py`).
- **`tests/end_to_end/test_two_task_chain.py`** — the full stack on kind:
  the real fake product containers and the real scheduler loop. The
  actual proof the chaining mechanism works.
- **`tests/conftest.py`** — every shared fixture: `db_session` (rolled back
  after each test), `docker_client`/`k8s_apis` (skip cleanly if
  unreachable), the various `*_image` fixtures (build/load once per
  session), `api_client` (a real ASGI app with its DB dependency overridden
  to `db_session`).
- **`tests/fakes.py`** — `FakeExecutor`, an in-memory `Executor` used to
  test scheduler logic without any real container runtime.
- **`tests/integration/executor_helpers.py`** — `wait_for_terminal()`,
  shared by both real-executor test files.
- **`tests/fixtures/docker_test_image/`** — a minimal image whose behavior
  is driven by the requested action (`greet`/`crash`/`sleep`/fail-on-input),
  used to exercise executor mechanics independent of the real products.

## Deployment files

- **`Dockerfile`** — one image for both `kernel-api` and `kernel-scheduler`;
  Helm's `command:` selects which.
- **`../helm/charts/execution-kernel/`** — the Kubernetes deployment (project
  root, not inside `kernel/` — deploys alongside `../helm/charts/execution-console`
  as one release). `values.yaml`
  documents every option inline; `templates/` has one file per resource
  (`kernel-api-deployment.yaml`, `kernel-scheduler-deployment.yaml`,
  `postgres-deployment.yaml` + `-pvc`/`-service`, `rbac.yaml`,
  `secret.yaml`, `configmap.yaml`, `migration-job.yaml`,
  `serviceaccount.yaml`, `_helpers.tpl` for shared template logic).
- **`app/persistence/migrations/`** — `env.py` (the Alembic environment,
  async-aware, reads `DATABASE_URL` from `app.config`) and `versions/`
  (`0001_initial_schema`, creating every table, then one per later change).
  `alembic.ini` at the kernel's root points there.
- **`examples/project-product/`**, **`examples/application-product/`** —
  the two real fake product containers; each is a standalone
  `entrypoint.py` + `Dockerfile` with no code shared between them
  (real product vendors wouldn't share a library either).

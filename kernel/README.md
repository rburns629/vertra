# execution-kernel

A lightweight, container-native DAG execution kernel. It accepts a
**pre-resolved** directed acyclic graph of containerized tasks, runs each
task as a Kubernetes Job, passes outputs from upstream tasks into
downstream ones, and records everything in Postgres.

The kernel does not decide *which* tasks are required; that's the job of
whatever submits the DAG. It only runs the resolved DAG it's given,
reliably.

Two processes, one image (`app/main.py` for `kernel-api`,
`python -m app.scheduler` for `kernel-scheduler`), coordinating only
through Postgres rows. Where to read more:

- [`ARCHITECTURE.md`](ARCHITECTURE.md): the layer rules and a call-by-call
  trace of submit → claim → dispatch → poll → finalize.
- [`../docs/architecture.md`](../docs/architecture.md): the whole platform
  and its design decisions; [`../docs/security-model.md`](../docs/security-model.md)
  for what it enforces.

## Execution semantics

Task claiming and execution are **at-least-once**, not exactly-once. A
scheduler crash or lease expiry after a task starts but before its outcome
is recorded can result in the same task running again. Product containers
must therefore be idempotent with respect to repeated invocation of the
same `(executionId, taskId, attempt)` — or, ideally, the same action.

## Running it

Kubernetes only. From the repo root, against the local kind cluster
(first-time setup is `make quickstart`; see `../docs/operations.md`):

```bash
make up            # resume the kind node, port-forward the console
make kind-deploy   # rebuild the kernel and console, deploy with helm/values/kind/*.yaml
```

Then submit a DAG from the console's Submit page. The kernel has no
authentication of its own; the console is its front door.

## Testing

```bash
pip install -e ".[dev]"
pytest                   # everything
pytest tests/unit        # pure logic, no I/O
ruff check .
mypy .
```

Integration and end-to-end tests need a real, migrated Postgres at
`postgresql+asyncpg://localhost/execution_kernel_test`:

```bash
DATABASE_URL=postgresql+asyncpg://localhost/execution_kernel_test alembic upgrade head
```

The Kubernetes tests (`tests/integration/test_kubernetes_executor.py`,
`test_product_examples.py`, `tests/end_to_end/test_two_task_chain.py`)
need a reachable kind cluster in the current kubectl context, and are
skipped, not failed, without one. They build fixture images with Docker
and `kind load` them into that cluster, since kind's nodes have their own
image store.

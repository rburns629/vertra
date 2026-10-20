# execution-kernel

A lightweight, container-native DAG execution kernel. It accepts a
**pre-resolved** directed acyclic graph of containerized tasks, runs each
task as a Kubernetes Job, passes outputs from upstream tasks into
downstream ones, and records everything in Postgres.

The kernel does not decide *which* tasks are required; that's the job of
whatever submits the DAG. It only runs the resolved DAG it's given,
reliably.

One Go binary, `kernel`, run as separate processes that coordinate only
through Postgres rows: `kernel api` (kernel-api, which the console calls)
and `kernel scheduler` (kernel-scheduler, which runs the steps), plus
`kernel migrate` and `kernel sleep`. Where to read more:

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

The tests need a real, migrated Postgres. From the repo root, `make test`
starts one in a container on `127.0.0.1:55432`, migrates it and runs
everything (the kernel's tests in the pinned Go image). By hand, with Go
1.26+:

```bash
DATABASE_URL=postgresql://localhost/execution_kernel_test go run ./cmd/kernel migrate
TEST_DATABASE_URL=postgresql://localhost/execution_kernel_test go test ./...
go vet ./... && gofmt -l .
```

The Kubernetes tests (`TestKind*` in `internal/executor` and
`internal/scheduler`) need a kind cluster in the current kubectl context
with an `execution-kernel` namespace, and are skipped, not failed, without
one. They build their images with Docker and push them to the local
registry (`make kind-registry`) when it's running, else `kind load` them.

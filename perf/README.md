# Performance benchmarks

Measuring Vertra's throughput and latency, and checking it stays correct
under load, on a kind cluster of its own. Phase 1 (2026-10-28): one
end-to-end driver, the scheduler and Postgres alone, and what they found.
Numbers from kind are this machine's, not GKE's or EKS's: kind's node is a
container sharing the laptop's CPUs, memory and disk with everything else.

## What's here

- `catalog-template/samples/perf/`: the `perf` team's `noop` product. It
  sleeps `sleepMs`, succeeds, or fails (`always`, or `first-attempt`:
  retryable, so attempt 2 succeeds), pads its outputs up to `outputBytes`,
  and reports when its container started and finished. No network, no
  credentials, no cloud. It's published like any product (built, tested,
  scanned, pinned, admitted), so a benchmark pays every step a real run
  does.
- `perf/` (this folder): the driver. It submits DAGs of `noop` through the
  console's API with a token, as a pipeline would, waits for them, and
  writes `results/<run>-<scenario>.json` and `.md`: submit latency, end to
  end, and each step's time split into queue wait (ready to the kernel
  starting it), container start (the kernel starting it to the container's
  own clock starting) and completion lag (the container finishing to the
  kernel recording it); steps and DAGs a second; the node's CPU and memory;
  the commit, the machine and the kernel's settings. And correctness: every
  DAG ended as expected, every step ran its own inputs, the expected
  attempts, after what it depends on. It exits non-zero on any problem.
- `kernel/internal/scheduler/perf_test.go`: the scheduler and Postgres
  alone, with the fake executor (steps finish as they start), 1, 2 and 4
  schedulers, committed transactions on the test database; checks every run
  succeeds and no step starts twice. Only with `VERTRA_PERF=1`.
- `kind-kernel.yaml`, `kind-console.yaml`: the perf cluster's settings on
  top of `helm/values/kind/`: at most 40 steps running at once (so a large
  scenario queues instead of starting hundreds of Pods on a laptop), and a
  catalog of its own in the registry (`localhost:5001/perf-catalog`), so
  publishing it never touches what `vertra-local` applies.

## Running it

The perf cluster is `vertra-perf`, separate from `vertra-local`. Docker
Desktop's VM is small (8 GB here), so stop the other cluster, and anything
else heavy (a local model: `lms unload --all`), while measuring:

```console
$ make down                                   # vertra-local, data kept
$ make quickstart KIND_CLUSTER=vertra-perf    # once; rerunnable
$ make kind-deploy-console KIND_CLUSTER=vertra-perf KIND_CONSOLE_VALUES=perf/kind-console.yaml
$ make kind-deploy-kernel KIND_CLUSTER=vertra-perf KIND_KERNEL_VALUES=perf/kind-kernel.yaml
$ make up KIND_CLUSTER=vertra-perf
$ make catalog-publish KIND_CLUSTER=vertra-perf SAMPLES=perf CATALOG_REGISTRY=localhost:5001/perf-catalog
```

Then, with a token (the local admin's session, kind only):

```console
$ export VERTRA_TOKEN=$(curl -s -X POST localhost:18080/api/vertra.console.v1.AuthService/Login \
    -H 'Content-Type: application/json' -d '{"email":"admin@example.com","password":"vertra-local"}' | jq -r .token)
$ cd perf && go run . -scenario baseline
```

Scenarios (starting points, not targets):

| Scenario | DAGs | Steps | Shape |
| --- | ---: | ---: | --- |
| `baseline` | 10 | 1 | single |
| `burst` | 100 | 1 | single |
| `dependency` | 10 | 20 | chain |
| `sustained` | 100 | 10 | fan-out (one, eight at once, one joining) |
| `higher` | 500 | 10 | fan-out; needs `-allow-large` |

Or `-scenario custom -shape single|chain|wide|fanout -dags N -steps N`.
Also `-sleep-ms`, `-fail never|always|first-attempt`, `-concurrency`
(submitters), `-rate` (submissions a second). Every workload is capped (500
DAGs, 50 steps, 5,000 steps in all; over 1,000 needs `-allow-large`). It
refuses a cluster not named `vertra-perf*`, a console not on this machine,
and a port-forward to any other cluster's console.

The scheduler and Postgres alone, on the test database (`make test-db`):

```console
$ cd kernel && VERTRA_PERF=1 TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/execution_kernel_test \
    go test ./internal/scheduler -run TestPerf -v
```

Afterwards: `make down KIND_CLUSTER=vertra-perf`, `make up` for vertra-local.
`kind delete cluster --name vertra-perf` removes it altogether.

## Phase 1 findings (2026-10-28)

Apple M1 Max, 32 GB; Docker Desktop 10 CPUs, 7.7 GB; kind, one node,
Kubernetes 1.37.0; one scheduler, one kernel-api, one console; at most 40
steps running; steps doing nothing (`sleepMs` 0). Every run below was
correct.

**1. The kernel's own Kubernetes client was the constraint.** It never set
client-go's rate limit, so it ran at the default: 5 requests a second,
bursts of 10. Each step costs about five to seven calls (its ConfigMap and
Job made; the Job read, its Pods listed, its logs read, the Job and
ConfigMap deleted), so the scheduler could start and finish about one step
a second, whatever the cap. The scheduler's own log said so ("client-side
throttling"), and its passes that finished steps took 2.5 to 10 s while the
rest took under 5 ms. With the limit made a setting (`kubernetesClient` in
the kernel chart, still 5 and 10 by default) and raised to 50 and 100,
nothing else changed:

| | 5/s (default) | 50/s |
| --- | --- | --- |
| baseline: end to end, p50 | 6.7 s | 3.2 s |
| baseline: queue wait, p50 | 625 ms | 30 ms |
| burst (100 × 1): wall, steps/s | 90 s, 1.15 | 33 s, 3.24 |
| burst: queue wait, p50 | 32 s | 8 s |
| dependency (10 × 20 chained): wall, steps/s | 286 s, 0.71 | 84 s, 2.44 |
| throttling logged | yes | none |

**2. The scheduler and Postgres are far from the limit.** With the fake
executor: 185, 321 and 515 steps a second with 1, 2 and 4 schedulers for
one-step runs (passes of 108, 62 and 39 ms), 162 to 237 for chains; every
run succeeded, no step started twice. That's 50 to 150 times what the
cluster sustained, so Redis, a queue or a broker would buy nothing.
Chains don't scale past two schedulers: a chain has one step ready at a
time. (The test database is a container on the host, not the cluster's.)

**3. Now Kubernetes itself.** At 50/s what's left is mostly the cluster's:
about 2.5 to 3 s from a container exiting to the Job controller marking its
Job complete (the kernel reads the Job, not the Pod), and, in a burst,
container start-up rising to 3.5 s with 40 Pods starting at once on one
node.

**4. A pass's times are its start's.** Each scheduler pass stamps what it
records with the time it began, so under a long pass a step can be recorded
done before its container finished (the burst at 5/s: a negative completion
lag at p50). Harmless to correctness; it makes the kernel's own completion
times early by up to one pass, which the driver's completion lag inherits.

## Next (TODO.md)

Raise the client's default (proposed: 50 and 100; the API server's
priority and fairness still protects it), and then: whether to read a
finished Pod's status instead of waiting for its Job (about 2.5 s a step);
the sustained and higher scenarios; profiling; the remaining failure cases
(a create that times out but happened, Postgres or the API server away,
cancelling as a step finishes); API load through the console; repeated runs
compared for regressions; a manual or nightly CI job.

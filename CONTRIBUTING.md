# Contributing to Acyclix

Thanks for helping. This page covers setting up, testing, and what a pull
request needs. For security issues, see [`SECURITY.md`](SECURITY.md) instead.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on
  the approach.
- Read [`AGENTS.md`](AGENTS.md). It's written for AI coding assistants but is
  the quickest orientation for people too: the layout, the contracts between
  components, and the engineering principles the code follows.
- [`docs/architecture.md`](docs/architecture.md) explains how it works,
  [`docs/operations.md`](docs/operations.md) how to run it.

## Setting up

The repository holds two independent projects. Build and test each one from
inside its own directory.

**Kernel** (Python 3.12 or later, `cd kernel`):

```
pip install -e ".[dev]"
ruff check .
mypy .
```

**Console** (Node 22, `cd console`, and separately `cd console/frontend`):

```
npm ci
npm run typecheck && npm run lint
cd frontend && npm ci && npm run build && npm run lint
```

**Tests** (from the repository root, needs Docker):

```
make test             # starts a test Postgres, migrates it, runs every suite (kernel, console, frontend)
make test-db          # just the database; then run pytest or npm test yourself
make test-db-down     # removes it
```

Integration tests use a real Postgres, not mocks. `make test-db` runs it as a
throwaway container (`acyclix-test-db`) on `127.0.0.1:55432`, apart from any
Postgres you already run and from any Acyclix install. To run a suite by hand
against it, set `TEST_DATABASE_URL`:

```
cd kernel && TEST_DATABASE_URL=postgresql+asyncpg://postgres@127.0.0.1:55432/execution_kernel_test pytest
cd console && TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/execution_console_test npm test
```

If `alembic` and `pytest` aren't on your PATH, point make at them:
`make test ALEMBIC=.venv/bin/alembic PYTEST=.venv/bin/pytest`.

The charts' admission policies have their own check, against a real
cluster (it adds a few objects of its own under a "policytest" name, and removes them after):
`bash helm/tests/admission-policies.sh`. CI runs it on kind, with the
kernel's Kubernetes tests.

Kubernetes tests skip themselves unless the current `kubectl` context is a
reachable `kind` cluster with an `execution-kernel` namespace. To run the whole
platform locally, see the README's "Try it locally".

## Pull requests

- **Keep it focused.** One change per pull request, with a description of
  what changed and why.
- **Add tests.** A bug fix gets a test that fails without it. A new
  authorization rule gets a test in `console/test/`.
- **Keep the docs in step**:
  - adding, moving or removing a file means updating
    [`docs/repository-map.md`](docs/repository-map.md)
  - a code change that affects the diagrams means rerunning
    `docs/architecture/generate.py` (don't hand-edit the `.drawio`)
  - a database schema change means updating
    `console/docs/06-database-schemas.md`
- **CI must pass**: tests, linters, type checks, Helm rendering, and the
  security scans (Trivy, OSV, Semgrep, gitleaks).
- **Never commit a secret**, not even a placeholder value that looks real.

## Sign your commits (DCO)

Every commit needs a `Signed-off-by` line, certifying that you wrote the change
or otherwise have the right to submit it under the project's MIT license, as
described by the [Developer Certificate of Origin](https://developercertificate.org/).
Add it with:

```
git commit -s
```

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE). New source files start with the license identifier:

```
# SPDX-License-Identifier: MIT
```

(`// SPDX-License-Identifier: MIT` in TypeScript.)

## Conduct

Everyone taking part is expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

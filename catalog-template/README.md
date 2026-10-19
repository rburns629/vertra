# Catalog

Where teams declare what they offer to Acyclix. Each team has a
folder; each of its products is a container image plus a `product.yaml`
saying what its actions take, return and need. Open a pull request and CI
builds, tests and scans it; merge it and the image is pushed and the product
registered with the Acyclix console.

CI runs one tool, `./catalogctl` ([tools/catalog.py](tools/catalog.py)), and so
can you: `./catalogctl check` runs every pull request check on your machine,
and `./catalogctl publish` publishes from a laptop when there's no CI.

`teams/` starts empty: your first team goes there. `samples/` holds whole
example teams, never published from there:

- `samples/local`: no cloud, no secrets, the same small product in Python,
  TypeScript, Go, PowerShell and Rust. Copy the products in your languages
  into your team as starters, or the whole folder to `teams/local/` to
  prove an install end to end.
- `samples/gcp`, `samples/aws`, `samples/azure`: products that call real,
  billed cloud APIs (a bucket or resource group, a container service, a
  PostgreSQL database), keyless. Copy one into a team once its cloud
  identity is set up. The AWS and Azure ones aren't yet proven against a
  real account.

A copied product's `team:` must be changed to its new team's name.

## Layout

```
acyclix.yaml                  where products publish: registry, console, signing
catalogctl                    runs tools/catalog.py in its own .venv
tools/                        catalog.py, and the schemas for team.yaml and product.yaml
templates/                    starters to copy (checked by CI, never published)
samples/<team>/               example teams: local (five languages); gcp, aws, azure (billed)
teams/
  <team>/                    one team = one console team = one Kubernetes namespace
    team.yaml                 who the team is: name, description, owner, contact
    README.md                 optional
    products/
      <product>/              its image is <registry>/<team>/<product>
        product.yaml          its actions, their input/output schemas, secrets, identity
        actions/<action>.*    each action's script, in any language
        entrypoint.sh         the same dispatcher in every product; don't edit it
        Dockerfile            installs what the actions need; ends with a non-root USER
        tests/<action>/<case>/   request.json and expected.json
    secret-stores/*.yaml      optional: the team's SecretStores (admins approve)
    dags/                     optional: example DAGs
```

A team's folder name is its identity everywhere: its console team, its
namespace, and `team` in a DAG.

## Onboarding a team

The order matters: an action can't be tested until the secret it reads
exists, a secret needs the team's namespace, and the namespace comes from
merging the team's folder. So: team, access, secrets, then code.

1. **List the team.** One pull request with
   `teams/<team>/team.yaml` (copy
   [templates/team](templates/team/team.yaml)) and its line in
   [.github/CODEOWNERS](.github/CODEOWNERS), with the other teams':
   `/teams/<team>/ @<org>/<github-team>`. Catalog admins approve it. On
   merge, `apply-teams.yml` has the console create the team and its
   namespace. A name that's already a team's, or ever was, fails the pull
   request (`check-new-team-names.yml`).
2. **Get access.** An Acyclix admin creates your console account and adds
   you to the team; after that, members add each other.
3. **Register secrets**, in the console (Team page → Secrets): paste a value,
   or sync from a vault once your team has a SecretStore (below). Note each
   secret's name: your action reads `/platform/secrets/<name>/<key>`.
4. **Add a product.** `cp -r templates/hello teams/<team>/products/<product>`
   (or a starter in your language from `samples/local/products/`), change
   what's marked `CHANGE` (a starter's `team:` too), then run what CI will:
   `./catalogctl check teams/<team>/products/<product>`.
5. **Run it.** Submit a DAG naming `<registry>/<team>/<product>:latest`,
   the action, your `team`, and any `secretRefs`. The console pins `:latest`
   to its digest at submission, so what runs (and is retried and scanned) is
   one exact image.

Using an AI assistant for this? [docs/onboarding-with-ai.md](docs/onboarding-with-ai.md)
says what to ask for and what to check.

## `product.yaml`

```yaml
name: project               # the folder's name
team: gcp               # the team folder's name
displayName: GCP Project
description: Looks up a project by id, creating it if it doesn't exist.
owner: gcp-team
runtime: python3.12         # what the Dockerfile installs (for readers)
serviceAccount: project     # optional: the identity it runs as (otherwise default)
actions:
  - name: create
    script: actions/create.py
    input:  {type: object, required: [projectId], properties: {projectId: {type: string}}}
    output: {type: object, required: [projectId], properties: {projectId: {type: string}}}
    requiredSecrets:        # optional: which team secrets the action reads
      - name: my-api-key
        keys: [value]
```

`input` and `output` are JSON Schema. Every field is in
[tools/product.schema.json](tools/product.schema.json); `./catalogctl validate`
checks against it. There's no image field: the image comes from the folder.

`requiredSecrets` documents; it doesn't restrict. A DAG lists the secrets a
step mounts in `secretRefs`, and only secrets the team registered can be
mounted, only into its registered products' steps. A product with a
`serviceAccount` runs as it in every step (the console creates it in the
team's namespace); bind a cloud identity to that one, never to `default`.

### The container contract

- The step's request is `/platform/input/request.json`; the action is the
  container's argument. `entrypoint.sh` runs `actions/<action>.*` by its
  shebang, or fails with `UNSUPPORTED_ACTION`, so language support lives
  entirely in the Dockerfile.
- The action writes `/platform/output/result.json`:
  `{"status": "succeeded", "outputs": {...}}` or
  `{"status": "failed", "error": {"code", "message", "retryable"}}`, at most
  4 KB. Output references (IDs, names, URIs), not data.
- Steps run at least once: an action must be safe to run again (look up
  before creating).
- Never print or return a credential. Logs and outputs are stored and shown
  to everyone who can see the execution; the kernel redacts recognizable
  credentials from logs and fails a step whose outputs contain one.
- The image runs as non-root with a read-only filesystem (`/tmp` is
  writable) and no Kubernetes token.

## Testing

A product's tests are contract tests: `tests/<action>/<case>/request.json`
and the `expected.json` its result must contain. `./catalogctl check` runs
each against the built image the way the platform runs a step, with no
network. A succeeding case must also match the action's schemas. A case that
needs a secret puts a placeholder in `secrets/<name>/<key>` beside it (the
case fails if the result contains it). Logic that calls a cloud API is tested
in the image with the client mocked, as `actions/test_<action>.py`. Every
product needs at least one test.

## What CI blocks

Per product (`./catalogctl check`, in `ci.yml`):

| Blocks on | Fix |
|---|---|
| A HIGH or CRITICAL vulnerability with a fix | Usually OS packages: keep the templates' `apt-get upgrade`, or pin a fixed package version |
| A secret in the image | Remove it; secrets are mounted at run time |
| A known-malicious package ([OSV](https://osv.dev)) | Check the package name for a typo |
| A base image not pinned by digest | `./catalogctl bases` pins it; `bases --update` moves every pin to its tag's current image |

Across the repository (`security.yml`): committed secrets (gitleaks; rotate
anything it finds), and Semgrep's rules plus
[.semgrep/malicious.yml](.semgrep/malicious.yml), including a Dockerfile's
final `USER` being non-root.

An accepted finding gets its exception where it applies, with the reason, so
the pull request's review decides: a vulnerability ID in the product's
`.trivyignore`, or `# nosemgrep: <rule>` on the line. Every product is
rechecked each Monday, since new vulnerabilities are published against old
images; the Acyclix console also rescans images in use daily and refuses ones
that fail.

## Who approves what

[.github/CODEOWNERS](.github/CODEOWNERS), with branch protection on `main`
requiring a code owner's review: the catalog admins own everything by
default, each team's owners own `/teams/<team>/`, and the admins
own, last so nothing overrides them, `.github/`, `tools/`, `acyclix.yaml`,
`catalogctl`, `templates/` and every `/teams/*/secret-stores/`. A
team ships its own products, but can't change how CI builds and
publishes, take another team's folder, add a team, or change what
vault its namespace can read. `./catalogctl validate` checks this layout, and
`check-codeowners.yml` checks every owner exists.

## Publishing

`./catalogctl publish` checks each product, then pushes its image tagged with
the commit (or the time, from a laptop) and `:latest`, signs it if the
catalog signs, and registers each action with the console as
`<team>-<product>-<action>`, pinned by digest. In CI, pull requests run
`check` on the changed products and a merge to `main` runs `publish` on them,
in the `catalog-publish` Environment (`main` only). Settings are in
[acyclix.yaml](acyclix.yaml), each overridable by an environment variable:

| Name | Kind | What |
|---|---|---|
| `ACYCLIX_REGISTRY` | variable | where images go, such as `us-docker.pkg.dev/my-project/catalog` |
| `ACYCLIX_CONSOLE_URL` | variable | the console |
| `ACYCLIX_TOKEN` | secret | the console automation token: `products:register`, `teams:create`, `teams:retire`, `secret-stores:apply` |
| `ACYCLIX_SIGNING_MODE`, `ACYCLIX_SIGNING_KEY` | variables | `none`, `key` (a key pair or cloud KMS key) or `keyless` |
| `COSIGN_PRIVATE_KEY`, `COSIGN_PASSWORD` | secrets | a generated signing key |
| `GCP_WORKLOAD_IDENTITY_PROVIDER`, `PUBLISH_GCP_SERVICE_ACCOUNT` | variables | sign in to Artifact Registry through OIDC |
| `AWS_ROLE_ARN`, `AWS_REGION` | variables | or to ECR through OIDC (a role that may push under the registry's prefix) |
| `REGISTRY_USERNAME` / `REGISTRY_PASSWORD` | variable / secret | or a username and password |

An Acyclix admin mints the token on the console's Admin page; it belongs to
no team and can't read secrets or submit work. If it may have leaked, revoke
it there and set a new one.

From a laptop: `./catalogctl teams apply` (makes each team exist), then
`./catalogctl publish [teams/<team>/products/<product> ...]`, signed
in with `ACYCLIX_TOKEN` or `ACYCLIX_EMAIL`/`ACYCLIX_PASSWORD`.

## A team's SecretStore

A team that keeps secrets in a vault syncs them through External Secrets
Operator once its SecretStore exists. Which vault and identity a namespace
may read is a scope grant, so it's reviewed here rather than set in the
console: `teams/<team>/secret-stores/*.yaml`, approved by the catalog
admins. The console writes the file for you (Team page → Secrets → Connect a
source), with the provider-side commands.

The files may hold only SecretStores in the team's namespace, the
ServiceAccounts ESO signs in as (`eso-gcp`, `eso-azure`, `eso-aws`), and, for
a provider that can't federate, a reference to the Secret `eso-auth`.
`check-secret-stores.yml` checks that on the pull request and the console
again before applying. On merge, `apply-secret-stores.yml` sends them to the
console. A stored credential (a 1Password token, say) is the
`BOOTSTRAP_CREDENTIAL` secret in the team's own GitHub Environment,
written to `eso-auth`, which no step can mount. GCP Secret Manager is proven;
other providers are designed but not yet proven.

## Retiring and purging a team

- **Retire** (automatic, reversible): merge a pull request that deletes
  `teams/<team>/`. `retire-teams.yml` has the console retire the team
  (read-only, products unregistered) and relabel its namespace so nothing new
  runs there. Restoring the folder brings it back.
- **Purge** (by hand, permanent): run `purge-team` from the Actions tab,
  typing the name twice. The console deletes the team's memberships, secrets,
  products and bots; history is kept, and the name can never be reused. It
  refuses while anything is still running. The workflow can also delete the
  team's images. Its summary lists what's left for an admin (the
  namespace, if the console doesn't delete namespaces, and the team's
  GitHub Environment).

Purging needs a `purge` Environment with required reviewers, restricted to
`main`, holding `ACYCLIX_PURGE_TOKEN` (a token with only `teams:delete`).

Each team's jobs run in a GitHub Environment named after it. A new one
is open to every branch until an admin restricts it to `main`:

```bash
R=<owner>/<repo>; env=<team>
echo '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' \
  | gh api -X PUT repos/$R/environments/$env --input - \
  && gh api -X POST repos/$R/environments/$env/deployment-branch-policies -f name=main -f type=branch
```

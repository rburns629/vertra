# Catalog

Where teams declare what they offer to Vertra. Each team has a
folder; each of its products is a container image plus a `product.yaml`
saying what its actions take, return and need. Open a pull request and CI
builds, tests and scans it; merge it and the image is pushed, and the
catalog's release names it. Each Vertra install's console reads that release
and registers what it says: CI never calls a console, and one catalog can serve
any number of installs.

CI runs one tool, `./vertra` (the platform's command line, at the release
pinned in that file: downloaded on first use from the platform's public
package by its SHA-256, and checked against it), and so
can you: `./vertra catalog check` runs every pull request check on your machine,
and `./vertra catalog publish` publishes from a laptop when there's no CI.

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
vertra.yaml                  where products publish: registry, signing
vertra                        runs the pinned vertra (downloaded into .vertra/)
tools/                        the schemas of every catalog file (format v2), for editors
templates/                    starters to copy (checked by CI, never published)
samples/<team>/               example teams: local (five languages); gcp, aws, azure (billed)
teams/
  <team>/                    one team = one console team = one Kubernetes namespace
    team.yaml                 who the team is: name, description, owner, contact; allowedTargets
    README.md                 optional
    products/
      <product>/              its image is <registry>/<team>/<product>
        product.yaml          its actions, their input/output schemas, secrets, identity
        actions/<action>.*    each action's script, in any language
        entrypoint.sh         the same dispatcher in every product; don't edit it
        Dockerfile            installs what the actions need; ends with a non-root USER
        tests/<action>/<case>/   request.json and expected.json
    secret-stores/*.yaml      optional: the team's SecretStores (admins approve)
    dags/                     optional: templates others run, and example DAGs
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
   merge, the next release names the team, and each install's console
   creates it and its namespace. A name that ever was a purged team's is
   refused there, and so is one already taken by a team the catalog didn't
   make, until that install's admin adopts it (Admin page → Catalog).
2. **Get access.** A Vertra admin creates your console account and adds
   you to the team; after that, members add each other.
3. **Register secrets**, in the console (Team page → Secrets): paste a value,
   or sync from a vault once your team has a SecretStore (below). Note each
   secret's name: your action reads `/platform/secrets/<name>/<key>`.
4. **Add a product.** `cp -r templates/hello teams/<team>/products/<product>`
   (or a starter in your language from `samples/local/products/`), change
   what's marked `CHANGE` (a starter's `team:` too), then run what CI will:
   `./vertra catalog check teams/<team>/products/<product>`.
5. **Run it.** Submit a DAG naming `<registry>/<team>/<product>:latest`,
   the action, your `team`, and any `secretRefs`. The console pins `:latest`
   to its digest at submission, so what runs (and is retried and scanned) is
   one exact image.

Using an AI assistant for this? [docs/onboarding-with-ai.md](docs/onboarding-with-ai.md)
says what to ask for and what to check.

## `product.yaml`

```yaml
apiVersion: vertra.dev/v2  # the catalog format: every file starts with these two
kind: Product
name: project               # the folder's name
team: gcp               # the team folder's name
displayName: GCP Project
description: Looks up a project by id, creating it if it doesn't exist.
owner: gcp-team
version: 1                  # optional: raise it for a breaking change (see below)
runtime: python3.12         # what the Dockerfile installs (for readers)
serviceAccount: project     # optional: the identity it runs as (otherwise default)
tokenAudiences: [sts.amazonaws.com]  # optional: tokens for another cloud (below)
actions:
  - name: create
    script: actions/create.py
    input:  {type: object, required: [projectId], properties: {projectId: {type: string}}}
    output: {type: object, required: [projectId], properties: {projectId: {type: string}}}
    secretRefs:             # optional: the team secrets the action uses
      - name: my-api-key
        keys: [value]
    shareWith: [web, data]  # optional: other teams that may use it, or ["*"]; left out, only yours
    # visibility: hidden    # optional: only your team sees it at all (then no shareWith)
    idempotent: true          # optional: running it again with the same inputs does no harm
    maxAttempts: 3            # optional: attempts in all (default 1); more than 1 needs idempotent
    # deprecated: Use project.ensure instead.   # optional, here or for the whole product
```

`input` and `output` are JSON Schema, and they're enforced: a step's inputs
are checked against `input` when it's submitted (the values known then) and
again, resolved, before it starts (`INPUT_INVALID`), and its outputs against
`output` when it finishes (`OUTPUT_INVALID`; no later step gets them). Keep
them to what the action really takes and returns, and self-contained (no
`$ref` to another file or URL). Every field is in
[tools/product.schema.json](tools/product.schema.json); `./vertra catalog validate`
checks against it. There's no image field: the image comes from the folder.

An action's `secretRefs` are its bindings, reviewed with the code that
reads them: the team secrets it uses, each mounted at
`/platform/secrets/<name>/<key>`. Today a DAG still lists the secrets a step
mounts (only secrets the team registered can be mounted, only into its
registered products' steps); once other teams run your templates, each
step will use its action's own `secretRefs`. `shareWith` says which other
teams may run the action or put it in their templates, and `deprecated`
says what to use instead while it keeps working: the console records both
and shows them. `idempotent` and `maxAttempts` are your retry policy: a step
of an idempotent action that fails on the platform's side (a reclaimed node,
a lost Job, a timeout), or with an error your code marks `retryable`, runs
again after a growing pause, up to `maxAttempts` in all. A template or DAG
may ask for fewer attempts, never more, and an action that isn't idempotent
gets exactly one: write it to find what it would create first (as every
sample does) before you declare it. A product with a `serviceAccount` runs as it in every step
(the console creates it in the team's namespace); bind a cloud identity to
that one, never to `default`. To sign in to a cloud other than the one
running the cluster (OIDC federation), list its audiences in
`tokenAudiences`: each step gets a short-lived token for each at
`/platform/tokens/<audience>` (characters outside `[A-Za-z0-9._-]` become
`_`, so `api://AzureADTokenExchange` is `api___AzureADTokenExchange`).
Point the cloud's SDK at it (`AWS_WEB_IDENTITY_TOKEN_FILE`,
`AZURE_FEDERATED_TOKEN_FILE`) and have the cloud trust exactly this
product's ServiceAccount.

### Changing a product other teams use

Other teams' templates rely on a product's contract, so `./vertra catalog check
--changed <base>` (what CI runs on every pull request) compares each changed
product with the same product at the base, which is what's published, and
refuses a change that could break them:

- an action removed, or a product removed;
- an input newly required, no longer accepted, or of a new type, or the
  input schema newly closed (`additionalProperties: false`);
- an output removed, of a new type, or no longer always returned;
- a team no longer in `shareWith`.

If the change is meant, raise the product's `version`: that's the breaking
change, visible in the diff for its reviewers. To retire an action or a
product, mark it `deprecated: <what to use instead>` first and publish that
(templates using it get a warning); a later pull request may then remove
it. Adding things (an action, an optional input, an output, a team to
share with) never needs a new version. On a laptop, `--changed origin/main`
checks your uncommitted edits too.

## Templates and DAGs (`dags/`)

A team's `dags/` folder holds two kinds of file:

- **`kind: Template`**: what other people run, filling in only its
  parameters. `parameters` is a JSON Schema (it becomes the form they fill
  in); each step names an action, `<product>.<action>` of your team or
  `<team>/<product>.<action>` of a team that shares it, never an image, so
  a template keeps working as products release. Inputs are values,
  `{$param: <name>}`, or `{$fromStep: <id>, $output: <name>}` from a step
  in `dependsOn`. `./vertra catalog validate` checks every action exists and is
  shared with your team, and that each step gets the inputs its action
  needs. See [samples/local/dags/shout-backwards.yaml](samples/local/dags/shout-backwards.yaml).
- **`kind: Dag`**: a concrete DAG, exactly what the console's Submit page
  takes (images, teams, inputs): examples and walkthroughs.

Each install runs your templates from the catalog's release: anyone they're
shared with fills in the parameters on the console's **Run** page
(or `TemplateService/RunTemplate`), and nothing else. Each step runs its product as its
ServiceAccount, with its action's own `secretRefs`, in its team's
namespace, whoever runs it; the person running it can see, cancel, retry
and rerun that run, as can your team. Every action is also runnable on its
own, by whoever its `shareWith` covers.

Every other team sees your actions and templates in the console, even ones
not shared with them: those are marked "not shared with you", with **Ask
for access**, which opens a new issue on this repository in the person's
browser saying what to add to `shareWith` and where. Mark one
`visibility: hidden` (an action in product.yaml, or a template) and only
your team sees it; it can't be shared then.

When another team runs your product, it chooses the inputs, so it could aim
your identity at something that isn't theirs. Type each input that names a
project, folder, account or subscription with `x-vertra-needs` (`gcp.project`,
`gcp.folder`, `aws.account` or `azure.subscription`), and list in your
team.yaml where each team may aim it:

```yaml
allowedTargets:
  - teams: [web]
    gcp.project: ["web-*"]        # * matches anything
  - teams: ["*"]
    gcp.project: [sandbox-1]
```

The console refuses another team's run with any other value before it
starts (`TARGET_NOT_ALLOWED`), and its form offers only those values. With
no rule for a team, that team can't supply the target at all. Your own
team isn't limited, and a value an earlier step produced isn't checked.
Keep your identity's cloud permissions to the same folders: that's what
holds if anything else goes wrong (samples/gcp shows both).

A catalog from before format v2 (no `apiVersion` in its files) is
converted in place by `./vertra catalog migrate`, comments and all; review the
diff, then `./vertra catalog validate`.

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
and the `expected.json` its result must contain. `./vertra catalog check` runs
each against the built image the way the platform runs a step, with no
network. A succeeding case must also match the action's schemas. A case that
needs a secret puts a placeholder in `secrets/<name>/<key>` beside it (the
case fails if the result contains it). Logic that calls a cloud API is tested
in the image with the client mocked, as `actions/test_<action>.py`. Every
product needs at least one test.

## What CI blocks

Per product (`./vertra catalog check`, in `ci.yml`):

| Blocks on | Fix |
|---|---|
| A HIGH or CRITICAL vulnerability with a fix | Usually OS packages: keep the templates' `apt-get upgrade`, or pin a fixed package version |
| A secret in the image | Remove it; secrets are mounted at run time |
| A known-malicious package ([OSV](https://osv.dev)) | Check the package name for a typo |
| A base image not pinned by digest | `./vertra catalog bases` pins it; `./vertra catalog bases --update` moves every pin to its tag's current image |

Across the repository (`security.yml`): committed secrets (gitleaks; rotate
anything it finds), and Semgrep's rules plus
[.semgrep/malicious.yml](.semgrep/malicious.yml), including a Dockerfile's
final `USER` being non-root.

An accepted finding gets its exception where it applies, with the reason, so
the pull request's review decides: a vulnerability ID in the product's
`.trivyignore`, or `# nosemgrep: <rule>` on the line. Every product is
rechecked each Monday, since new vulnerabilities are published against old
images; the Vertra console also rescans images in use daily and refuses ones
that fail.

## Who approves what

[.github/CODEOWNERS](.github/CODEOWNERS), with branch protection on `main`
requiring a code owner's review: the catalog admins own everything by
default, each team's owners own `/teams/<team>/`, and the admins
own, last so nothing overrides them, `.github/`, `tools/`, `vertra.yaml`,
`vertra catalog`, `templates/` and every `/teams/*/secret-stores/`. A
team ships its own products, but can't change how CI builds and
publishes, take another team's folder, add a team, or change what
vault its namespace can read. `./vertra catalog validate` checks this layout, and
`check-codeowners.yml` checks every owner exists.

## Publishing

`./vertra catalog publish` checks each product, then pushes its image tagged with
the commit (or the time, from a laptop) and `:latest`, signs it if the
catalog signs. `./vertra catalog release` then pushes the catalog's release to
`<registry>/catalog-release` (tagged with the commit and `latest`) and signs it
the same way: every team, its SecretStore files, and every action as
`<team>-<product>-<action>`, its image pinned by digest. It's complete, not a
change: an install unregisters what a release no longer has, and retires a
team whose folder is gone. Each console reads it every few minutes (an admin
can press **Sync now**), verifies its signature, and applies it.

In CI, pull requests run `check` on the changed products, and a merge to
`main` runs `publish` on them and then `release`, one run at a time, in the
`catalog-publish` Environment (`main` only). Settings are in
[vertra.yaml](vertra.yaml), each overridable by an environment variable:

| Name | Kind | What |
|---|---|---|
| `VERTRA_REGISTRY` | variable | where images and releases go, such as `us-docker.pkg.dev/my-project/catalog` |
| `VERTRA_SIGNING_MODE`, `VERTRA_SIGNING_KEY` | variables | `none`, `key` (a key pair or cloud KMS key) or `keyless` |
| `COSIGN_PRIVATE_KEY`, `COSIGN_PASSWORD` | secrets | a generated signing key |
| `GCP_WORKLOAD_IDENTITY_PROVIDER`, `PUBLISH_GCP_SERVICE_ACCOUNT` | variables | sign in to Artifact Registry through OIDC |
| `AWS_ROLE_ARN`, `AWS_REGION` | variables | or to ECR through OIDC (a role that may push under the registry's prefix) |
| `REGISTRY_USERNAME` / `REGISTRY_PASSWORD` | variable / secret | or a username and password |

CI needs only the registry: no console token, no cluster credential. Each
install points its console at the release (the console chart's
`catalog.release`) and trusts the same signing key or identity as its images.

From a laptop: `./vertra catalog publish [teams/<team>/products/<product> ...]`,
then `./vertra catalog release`, signed in to the registry with `docker login`.

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
`check-secret-stores.yml` checks that on the pull request, `release` again,
and each console again before applying them from the release. A stored
credential (a 1Password token, say) is never in the catalog: a team member
sets it in each install (Team page → Secrets → Stored credential), and the
console writes it to `eso-auth`, which no step can mount. GCP Secret Manager is proven;
other providers are designed but not yet proven.

## Removing a team

- **Retire** (automatic, reversible): merge a pull request that deletes
  `teams/<team>/`. Each install retires the team when it reads the next
  release (read-only, products unregistered) and relabels its namespace so
  nothing new runs there. Restoring the folder brings it back.
- **Purge** (permanent): each install's admin, in its console (Team page →
  Purge), once nothing is running. History is kept, the name can never be
  reused, and the namespace stays, labelled retired, for a cluster
  administrator to delete. A release never purges.
- **Images**: run `delete-team-images` from the Actions tab, typing the name
  twice, once every install has retired the team. It needs a `purge`
  Environment with required reviewers, restricted to `main`, holding the
  registry identity that may delete (`PURGE_GCP_SERVICE_ACCOUNT`).

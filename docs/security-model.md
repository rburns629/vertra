# Security model

How Vertra keeps each team's secrets to that team's reviewed products: what's
enforced today, by which layer, what isn't enforced yet, and what's out of
scope. Written for security reviewers evaluating Vertra, and kept honest:
where something is a plan rather than a fact, it says so.

Last reviewed 2026-10-18, for 0.x. Vertra is not production-ready yet; the
gaps in [Not yet enforced](#not-yet-enforced) are why.

## At a glance

| Question | Answer |
| --- | --- |
| Where do secret values live? | In Kubernetes Secrets, in the owning team's namespace. Synced secrets keep their source of truth in the team's own store (GCP Secret Manager and others, through External Secrets Operator). |
| Does Vertra's database store secret values? | No. The console stores which secrets each team registered, and the names of their keys, never values. The kernel never sees them. |
| Who can read a secret? | Steps of its team's registered products that list it in `secretRefs`, and cluster administrators. Not the console: it writes Secrets but has no right to read them. See [Who can read a secret](#who-can-read-a-secret). |
| Can one team's step reach another team's secret? | No. A step runs in its own team's namespace, and a Pod can only mount Secrets from its own namespace. |
| Can one product reach another product's secret in the same team? | By design, yes: a team's secrets are the team's, and the team chooses per step which ones it gets (`secretRefs`). What a team can't do is give one to an image that isn't its registered product (it runs with no secrets), or mount a Secret it never registered. The console checks this at submit time, and an admission policy makes the cluster enforce it on every step's Job. A product's own cloud identity (its declared ServiceAccount) is still its own: another product can't run as it. |
| Can a team register another team's product, or its image, as its own? | No. A product name and an image repository belong to the first team that registers them, the repository even after its products are deleted (an admin can release an unused one). Catalog CI also derives each image's path from its team's folder, so one team can't publish under another's name. |
| Can anything but the console submit work? | No. kernel-api accepts only the console's ServiceAccount token, issued for kernel-api alone and checked with a TokenReview. See [How kernel-api knows its caller](#how-kernel-api-knows-its-caller). |
| Is anything enforced if the console is bypassed? | Yes: which namespaces steps may run in, which image sources they may use, image signatures (with Sigstore's policy-controller installed) and who may delete a team namespace. These are admission policies the Kubernetes API server applies. |
| Are secrets encrypted at rest? | That depends on the cluster. Enabling encryption of Secrets at rest in etcd, ideally with a KMS provider, is the cluster operator's responsibility and a prerequisite for production. |
| What reaches logs and outputs? | Whatever a step prints or returns. Vertra stores step outputs and logs; a product must never print or return a secret. |

## Who is trusted

| Actor | Trusted to | Limited by |
| --- | --- | --- |
| Cluster administrators | Everything; they can read any Secret | Outside Vertra's control |
| Vertra admins (console) | Manage teams, people, bots, allowed image sources; act in any team | Console authorization; every admin action is logged |
| Catalog reviewers | Decide which product images exist, and which ServiceAccount and secrets each product declares | The catalog repository's review rules (CODEOWNERS, protected branches) |
| Team maintainers | Manage their team: its people and their roles, register its secrets and choose which step gets which, its bots, raw DAGs, cancelling its runs | Console authorization (`auth/access.ts`): the maintainer role, per-product identity, registered team secrets |
| Team members | See their team's runs, logs, Pods and secrets' names; run its actions and what's shared with it | The member role: nothing they can change |
| Product images | Do their one job with the inputs and secrets they're given | Their namespace, ServiceAccount and mounted secrets; admission policies |
| Pipelines (bots) | What their token's scopes allow | Scoped, hashed API tokens |

## Where secret values live

A secret enters in one of two ways, and ends up the same way:

1. **Pasted** on the console's Secrets tab. The value passes through the
   console in the request and is written straight into a Kubernetes Secret in
   the team's namespace (`console/src/k8s.ts`). It isn't stored in the console's
   database or written to its logs (request logging records method, URL and
   status, not bodies).
2. **Synced** from a team's own store. The console creates an ExternalSecret,
   which is only a reference; External Secrets Operator reads the value with the
   team's SecretStore identity and writes the Kubernetes Secret. The console
   never holds the value. SecretStores themselves arrive through a reviewed
   catalog pull request (in the catalog's release, which the console pulls
   and verifies), never from the console's own UI.

Either way, the console **registers** it for the team (`secret_grants`): the
secret's name and its key names. Only registered secrets can be mounted, and
only by the team's registered products.

- The console labels what it creates (`app.kubernetes.io/managed-by:
  vertra-console`) and won't replace, or register, a Secret it didn't
  create, such as a SecretStore's own credentials: that's refused with a 409.
  So a SecretStore's credentials can never be mounted by a step.
- No RBAC is involved: mounting doesn't consult it, and steps don't read
  Secrets through the API. The console creates no Roles (older versions made
  one per secret; the console removes them at startup).
- Revoking a secret (Team page, or `SecretService/RevokeSecret`)
  removes the registration and the Secret or ExternalSecret the console
  created. Tasks already running keep what they mounted.

### What a secret can hold

A secret is a set of named keys, each mounted as a file at
`/platform/secrets/<secret>/<key>`; Vertra doesn't interpret the values.
Typical shapes: one opaque value under `value` (an API key, a webhook
signing secret); a credential in several keys of one secret (`clientId` and
`clientSecret`, `username` and `password`, `tls.crt` and `tls.key`); or a
whole credential file under one key, for a platform with no federation to
use instead. Prefer workload identity wherever the target supports it: then
there's no secret at all.

A step that has a credential sends it to the service it authenticates to;
these rules decide which step can have it, where (one Pod) and for how long
(that process), not whether the credential exists. Short-lived credentials
(workload identity, a vault's dynamic secrets) are what shorten that window.

### Syncing secrets from a vault

A team that keeps its secrets in a vault (GCP Secret Manager, Azure Key
Vault, AWS Secrets Manager, HashiCorp Vault, 1Password) syncs them through
External Secrets Operator, an optional component. Two objects, provisioned
by different people on purpose:

| Object | Says | Who creates it |
| --- | --- | --- |
| **SecretStore** | This namespace may read this vault, as this identity: a scope grant | The team proposes it in the catalog (`teams/<team>/secret-stores/`); catalog admins approve; the console applies it after checking it only names a store in the team's namespace, ESO's own ServiceAccounts, and, for a store that needs a stored credential, the Secret `eso-auth` |
| **ExternalSecret** | Sync this key from that store into this Secret: a reference | Team members, self-service, on the Secrets tab |

So a team can sync as many secrets as it likes without ever widening what
its store can reach. Both are namespaced (never a ClusterSecretStore): an
ExternalSecret can't use another namespace's store, even applied by hand. A
store's own credential (for a vault that can't federate, such as a
1Password service account token) is set per install by a team member or
admin (Team page → Secrets → Stored credential, `TeamService/
SetSecretStoreCredential`), never carried by the catalog; it's written to
`eso-auth`, and can never be registered or mounted by a step. A synced secret rotates on the vault's side, with no
change in Vertra.

| Vault | Sign-in | Stored credential | Proven |
| --- | --- | --- | --- |
| GCP Secret Manager | GKE Workload Identity | None | Yes |
| Azure Key Vault | AKS Workload Identity | None | Not yet (`catalog-template/samples/azure`) |
| AWS Secrets Manager | EKS Pod Identity or IRSA | None | Not yet (`catalog-template/samples/aws`) |
| HashiCorp Vault | Vault's Kubernetes auth | None | Not yet |
| 1Password | A service account token | One, in `eso-auth` | Not yet |

## How a secret reaches a step

1. A team submits a DAG through the console. Each step names its team
   (its namespace) and any `secretRefs`; its `serviceAccount` is optional,
   filled in with its product's own (or `default`).
2. The console checks, before anything runs
   (`console/src/core/executions.ts`):
   - the caller maintains every team named, or is an admin;
   - the step runs as the ServiceAccount its product declares in the catalog,
     or as `default`; only a registered product may mount secrets at all;
   - each secret in `secretRefs` is registered for the step's team.
     (An action's `secretRefs` in product.yaml are recorded as its bindings;
     they don't restrict yet. Once consumers run templates, each step will
     use its action's own.)

   The console reads these fields by their documented names (`serviceAccount`,
   `secretRefs`), and builds kernel-api's request from exactly those names,
   refusing any other (`service_account`, `secret_refs`;
   `console/src/kernel/client.ts`): otherwise a submission could show the
   console one identity and give the kernel another.

   Retries and reruns are checked again against current memberships and
   secrets.
3. The kernel starts the step as a Kubernetes Job in that namespace, running
   as that ServiceAccount, with each secret mounted read-only at
   `/platform/secrets/<name>/`. The kernel itself has no permission to read
   Secrets.

Mounting happens through the kubelet, which doesn't consult the Pod's RBAC. That
is why this check exists: RBAC can't stop any Pod in the namespace from
mounting any Secret there. The console makes it in step 2, and the
cluster makes it again when the scheduler creates the Job (the identity
policy, below), so it holds even for a Job the console never checked.

## Consumers and templates

Running a team's template (`TemplateService`) needs no membership of the
teams its steps run in. Who may run one: its team's members, admins, and
whoever its `shareWith` covers (everyone, `*`, or members of the teams it
lists, who then run it on behalf of one of them). What runs is built by the
console from the registered products its steps name
(`console/src/core/templates.ts`): each step's image, ServiceAccount,
secrets (its action's `secretRefs`), token audiences and namespace are the
product's; the person running it supplies parameters, checked against the
template's schema, and nothing else. A step of another team's action needs
that action shared with the template's team: the team whose identity does
the work consents through its `shareWith`, checked by catalog CI, when a
release is applied (such a template isn't stored), on every run and on
every retry. Then every check a submission gets applies (identity,
registered secrets, images, scans), and the cluster's policies hold as for
any Job.

Where another team may aim a team's products is the owning team's: an
input typed as a target (`x-vertra-needs: gcp.project`, `gcp.folder`,
`aws.account`, `azure.subscription`) must match its team.yaml's
`allowedTargets` for the running team, or the run is refused before it
starts (`TARGET_NOT_ALLOWED`, `console/src/targets.ts`). The owning team's
own runs aren't limited, and a value an earlier step produced isn't
checked. The identity's cloud permissions, scoped to the same folders,
hold if the console's check is ever bypassed.

A team can also make a step wait for a person (approvals): product.yaml's
`approval` (`always`, or `otherTeams` for another team's runs), or an
`allowedTargets` rule's `approval: true`. The console marks such a step
`approvalRequired` (a submitter can't set or clear it), and the kernel holds
it in `AWAITING_APPROVAL`, never claimed, until a maintainer of the step's
team approves it. The person who submitted the run can't decide, even as a
maintainer, so two people agree before it runs (`console/src/core/
approvals.ts`). Each decision is in the audit log and, with who decided, in
the step's events; a declined or expired step fails (`APPROVAL_DECLINED`,
`APPROVAL_EXPIRED`), and retrying it asks again. The check is the console's:
kernel-api trusts its caller, as it does for everything else.

A raw DAG needs a maintainer of every team it names. The run belongs to
whoever ran it as well as to its steps' teams: they may see, cancel, retry
and rerun it (a rerun runs the template again, as it is now; a retry is
refused once it, or a step's action, is no longer shared).

## Who sees a step's logs

A step's output is stored (the kernel redacts recognizable credentials
first) and shown by level (decided 2026-10-21, `console/src/logLevels.ts`):
lines the step logs as JSON with `"level": "info"` to everyone who can see
the run; every other line (debug, warn, error, and any plain line, so
nothing reaches a consumer by accident) only to the step's team and admins.
A consumer sees how many lines were held back and which team sees them.

Observe's log search (the console chart's `logs`, off by default) keeps the
same rule over Loki, which has no users of its own: the console adds the
caller's visibility to every query (`console/src/core/logs.ts`), and Loki
accepts only the collector's pushes and the console's queries
(NetworkPolicy). The collector, Grafana Alloy, redacts credentials before
anything is stored, with the kernel's patterns, and may read every Pod's
logs in the cluster (a read-only ClusterRole on `pods` and `pods/log`:
steps run in every team's namespace); it keeps only steps' Pods and the
platform's own. The platform's own logs are for admins only.

## The API gateway

API products (decision 20) publish a team's own backend through one
gateway (`gateway/`). The gateway forwards a request only when its method
and path are an operation in the API's reviewed OpenAPI document and it fits
that operation's schemas; anything else is answered by the gateway (404 or
400) and never reaches the backend. Callers sign in as at the console (a
session or a bot token, checked against the console's database the same
way), and may call an API only when it's shared with one of their teams.
The caller's `Authorization` stops at the gateway; the backend gets its own
credential instead, minted per request, and `Vertra-Caller`, an EdDSA JWT
the gateway signs (its key at `/.vertra/jwks.json`) naming the caller,
their team and the API. A caller's own `Vertra-*` headers are dropped.
Paths with encoded slashes or dot segments are refused, so what's checked
is what's forwarded.

Backends must be under hosts the admins allow (`gateway.backendHosts`), or
the API is held: the gateway can't be pointed anywhere a catalog says. Its
only Kubernetes right is minting ServiceAccount tokens, and an admission
policy limits that to API ServiceAccounts (`*-api`) in team namespaces, so
it can't mint the platform's or a team's other identities. It reads the
console's database and never writes it. Requests are logged and counted by
API, team, caller and outcome, never with bodies, header values or
credentials; the counts kept for each API's page (`api_traffic`, a week)
hold only the calling team, never who. Its egress excludes the cloud
metadata server, so no backend URL can reach the node's credentials
through it, and it reads no Secrets: a backend that takes only a static
key can't be published.

## Tokens for another cloud

A step can sign in to a cloud other than the one hosting the cluster by
OIDC federation (AWS web identity, Entra workload identity, a GCP workload
identity pool), with a ServiceAccount token issued for that cloud. A
product asks for one by declaring its audiences (`tokenAudiences` in
`product.yaml`); a submitter can't choose them, as they can't choose a
ServiceAccount.

- The kernel mounts one projected token per declared audience at
  `/platform/tokens/<audience>` (characters outside `[A-Za-z0-9._-]` become
  `_`), each issued for that audience only and lasting an hour; the kubelet
  renews them. Steps still get no Kubernetes API token.
- The console refuses, at registration, any audience that would make the
  token good inside this cluster: the Kubernetes API server's (read from
  the console's own API token's `aud` claim) and kernel-api's
  (`console/src/tokenAudiences.ts`).
- The identity policy refuses a Job with a token for any audience its
  product didn't declare, or one lasting over an hour, so it holds for a
  Job the console never checked.

What the token is good for is the cloud's decision: trust the cluster's
issuer for the specific ServiceAccount (`system:serviceaccount:<team>:<sa>`),
never for the whole issuer.

## How kernel-api knows its caller

kernel-api knows nothing about users or teams; it acts on whatever the
console asks, because the console has already authorized it. So it checks
one thing on every call: that the caller is the console
(`kernel/internal/api/auth.go`).

- The console's Pod gets its ServiceAccount token projected for the
  audience `vertra-kernel-api` (rotated by the kubelet, valid an hour), so
  the token is useless against the Kubernetes API or anything else.
- kernel-api asks the API server whose token it is (a TokenReview, for that
  audience) and accepts only the ServiceAccounts in
  `api.auth.allowedServiceAccounts`. kernel-api's own ServiceAccount holds
  only the built-in `system:auth-delegator` role needed for that.
- No token, or one for another audience: 401. A valid token from anyone
  else, such as a step's own ServiceAccount: 403. Proven on kind.
- A successful review is reused for up to 60 seconds, so a revoked token
  can stay accepted that long. If the API server can't be asked, the
  request fails.

`/health` and `/metrics` stay open for probes and scrapers; they carry no
execution data. Every metrics port (kernel-api's, the scheduler's, the
console's and the gateway's) accepts only `networkPolicy.metricsFrom`, so a
step can't read them, and no metric is labelled with a user, a team or a
token.

## Signing in

People sign in with a password, or with single sign-on when the console
chart's `sso` is set (Google, through OpenID Connect:
`console/src/auth/oidc.ts`). The sign-in uses the authorization code flow
with PKCE; its state, nonce and verifier live in a signed, HttpOnly cookie
for ten minutes. The ID token must carry the provider's signature, this
console as its audience, this sign-in's nonce, a verified email, and a
Workspace domain listed in `sso.allowedDomains` (a personal Google account
has none, so it can't sign in). The first sign-in binds the account to the
provider's identity (`users.oidc_subject`): from then on, a different
provider account given the same email is refused. The session comes back in
the URL's fragment, which browsers never send to a server.

While single sign-on is on, a password signs in an admin only (a way in if
the provider fails), checked only after the password itself, and nobody
registers themselves. Bots keep their tokens.

## In the browser

The console sends a Content-Security-Policy on every response: scripts only
from its own origin, no plugins, and it can't be framed (`frame-ancestors
'none'`), plus `nosniff`, `X-Frame-Options` and HSTS. The session token sits
in `localStorage`, so the policy matters: it's what stops an injected script
from running at all. Styles may be inline, because the UI library injects
them. Checked in a real browser (headless Chrome, every signed-in page: no
violations).

## Who can read a secret

- **Steps of the team's registered products that list it** in `secretRefs`,
  through the mounted files. Steps get no API access to Secrets.
- **Not the console.** Its role can create, replace and delete Secrets, but
  not read them (no `get` or `list`): whether a Secret is a team's comes
  from its own records. Its writes are fenced to team namespaces (below),
  and it can't grant RBAC (it may only delete Roles, never create them). A
  compromised console could still write a team's secret values, so it
  remains the most privileged component and should be treated that way.
- **Nobody, for the registry pull Secret.** With the console chart's
  `registryCheck.copyToTeams` on, the console copies the platform's
  registry credential into every team namespace as `vertra-pull`, and the
  kernel names it as every step Pod's `imagePullSecret`
  (`scheduler.taskImagePullSecret`). Only the kubelet uses it: the name is
  reserved, so it can never be registered as a team secret and mounted.
  The console has it as a mounted file and rewrites every team's copy on
  each policy resync, so a rotation reaches every team within one
  interval. Turning the option off leaves the copies; delete them by hand.
  Reading another cloud's Artifact Registry (`registryCheck.gcpFederation`),
  the copy is a token the console minted that hour by Workload Identity
  Federation, renewed every resync; it reads the catalog's repository and
  nothing else, and lapses within the hour once the provider is deleted.
- **Cluster administrators**, and anyone else the cluster's own RBAC lets read
  Secrets in a team namespace. Vertra doesn't grant people Kubernetes
  access, but doesn't prevent a cluster operator from doing so.

## Guardrails the cluster enforces

These are ValidatingAdmissionPolicies (and, optionally, Sigstore's
policy-controller), so they hold even for a request that reaches the kernel
without going through the console:

| Guardrail | What it refuses | Where |
| --- | --- | --- |
| Dispatch namespaces | Jobs in any namespace not labelled `vertra/team=true`, and in the platform's own namespace (`DISPATCH_REJECTED`) | `helm/charts/execution-kernel/templates/dispatch-policy.yaml` |
| Image sources | Images outside the allowed registries (`IMAGE_NOT_ALLOWED`) | `templates/image-policy.yaml` |
| Image signatures | Unsigned images, where policy-controller is installed (`IMAGE_NOT_SIGNED`) | `templates/image-signature.yaml` |
| Image scans | An image not pinned by digest (`IMAGE_NOT_PINNED`), or one whose digest failed its security scan unless an admin accepted it (`IMAGE_SCAN_FAILED`). The console scans every image before it's registered or run, and daily while in use | `templates/scan-policy.yaml` |
| Step identity | A step running as any ServiceAccount but `default` unless it's a registered product running as the one its `product.yaml` declares; any step mounting a Secret unless it's a registered product and the Secret is registered for its team; Secrets reaching a step any way but a volume (`IDENTITY_NOT_ALLOWED`). The console keeps the policy's products and team secrets current. | `templates/identity-policy.yaml` |
| Team deletion | A configured purger deleting a team namespace that isn't labelled retired. None is configured by default: the console leaves a purged team's namespace, labelled retired, for a cluster administrator to delete, so the identity that retires a namespace can't also delete it (`teamNamespaces.purge` would let it) | `templates/purge-policy.yaml` |
| Console namespaces | The console creating a namespace that isn't labelled a team's, adopting one that isn't a team's, changing anything about a team namespace but its team label, or touching kube-* or the platform's own | console chart, `templates/namespace-policy.yaml` |
| Console write fence | The console's ServiceAccount creating, changing or deleting Secrets, ServiceAccounts, Roles, RoleBindings or ExternalSecrets outside team namespaces (kube-system, the platform's own) | console chart, `templates/write-fence-policy.yaml` |

Two platform identities only change replica counts, through the scale
subresource (which can't change what a Deployment runs), on Deployments
named in their Roles: the kernel's sleeper (`scaleDown`, the platform's
own Deployments, plus its own `-sleep` ConfigMap and a read of the
console's `-activity` one) and the console (only the image scanner's, to
idle it, and its own `-activity` ConfigMap). A stolen token of either can
stop the platform, not change it.

And at the network level, NetworkPolicies (`templates/networkpolicy.yaml` in both charts) let only the platform's own Pods connect to its Postgres, and only the console connect to kernel-api: a step's Pod can reach neither. Every team namespace also holds `vertra-default-deny`, which the console writes with the namespace and rewrites on every policy resync (`console/src/teamNetwork.ts`): its Pods accept connections only from Pods in the same namespace, so one team's steps can't reach another team's Pods or Services. The console's write fence accepts no other NetworkPolicy from it, and only that shape, and its RBAC can't delete one, so a compromised console can't open a team namespace up. Outgoing traffic isn't restricted: steps call their clouds. They need a CNI that enforces NetworkPolicy, and they select Pods by label, so creating Pods in the platform namespace must stay limited to administrators. The bundled databases' passwords are generated on install.

## What Vertra stores

| Where | What | Notes |
| --- | --- | --- |
| Console database | Users (argon2id password hashes), teams, memberships, bots (hashed API tokens), registered secrets (names and key names, no values), products, a record of submitted executions including their DAG | Sessions are signed tokens that expire (8 hours by default) |
| Kernel database | Each execution's DAG, step inputs (as submitted and as resolved), outputs, logs and events | Never put a secret in a step's `inputs`: inputs are stored and shown to the execution's viewers. When the console's database shares this Postgres instance (`postgres.consoleDatabase`), the console signs in as its own role, which owns only its database and is refused a connection to the kernel's |
| Team namespace | A ConfigMap per step attempt holding its `request.json` (its resolved inputs), deleted with the step's Job | Readable by anyone with ConfigMap access in that namespace |

## Rules for product authors

Products are written by catalog contributors, not by Vertra, so these are
requirements on product code:

- **Never print or return a secret.** Logs and `result.json` outputs are stored
  and shown to everyone who can see the execution. The kernel catches the
  common mistakes (`kernel/internal/domain/credentials.go`): it redacts
  well-known credential shapes from logs and error messages (PEM private
  keys, AWS/Google/Azure keys, GitHub, Slack and Stripe tokens, bearer
  tokens, JWTs), fails a step whose outputs contain one
  (`OUTPUT_CONTAINS_CREDENTIAL`), and refuses a submission whose inputs do
  (`INPUT_CONTAINS_CREDENTIAL`). It can only recognize shapes, not values
  (it never sees a secret's value), so a password or an opaque token is
  still stored if printed. Log what you did, not what you used.
- **Be idempotent.** Steps run at least once: a retried step must not create
  something twice or charge twice.
- **Read secrets only from `/platform/secrets/`**, never from inputs, and never
  bake one into an image. Images are shared, cached and pulled by every team.

## Not yet enforced

Known gaps in 0.x, all tracked in [`TODO.md`](../TODO.md). They're the reason
Vertra isn't production-ready yet.

| Gap | Impact | Plan |
| --- | --- | --- |
| The console can still create and replace Secrets in any team namespace | A compromised console could plant or overwrite a team's secret values (it can't read them) | Bind its Secret rights per team namespace as teams are created |
| No TLS in the chart | The console must be put behind TLS by the operator | An optional Ingress or Gateway with certificates |
| Teams aren't taken from the identity provider | Leaving a Google Group doesn't remove anyone from a team | Google Groups (and later Entra, Okta) mapped to teams |
| The audit log lives in the console's own database (Observe shows it: everything to admins; to anyone else, their own entries and those about their teams and runs) | Someone who can write that database could change it | Ship the `event: "audit"` log lines to a SIEM or write-once store |
| Any member of one team in a multi-team execution can read all of its outputs (its steps' logs are filtered by level: other teams see INFO lines only) | Cross-team visibility of outputs within shared executions | Decide: filter outputs by team, or require every team for reads |

## Out of scope

- **A malicious product a reviewer approved.** Review, scanning and signing
  reduce this risk; a product that passes them runs with whatever its
  ServiceAccount and the secrets its team's steps give it allow.
- **A compromised cluster administrator, node or control plane.**
- **Side channels between Pods on the same node.**
- **The security of a team's own secret store** and of the identities it trusts.

## Reporting a vulnerability

See [`SECURITY.md`](../SECURITY.md). Please report privately, never in a
public issue.

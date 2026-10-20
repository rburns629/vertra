# Security model

How Acyclix keeps each team's secrets to that team's reviewed products: what's
enforced today, by which layer, what isn't enforced yet, and what's out of
scope. Written for security reviewers evaluating Acyclix, and kept honest:
where something is a plan rather than a fact, it says so.

Last reviewed 2026-10-18, for 0.x. Acyclix is not production-ready yet; the
gaps in [Not yet enforced](#not-yet-enforced) are why.

## At a glance

| Question | Answer |
| --- | --- |
| Where do secret values live? | In Kubernetes Secrets, in the owning team's namespace. Synced secrets keep their source of truth in the team's own store (GCP Secret Manager and others, through External Secrets Operator). |
| Does Acyclix's database store secret values? | No. The console stores which secrets each team registered, and the names of their keys, never values. The kernel never sees them. |
| Who can read a secret? | Steps of its team's registered products that list it in `secretRefs`, and cluster administrators. Not the console: it writes Secrets but has no right to read them. See [Who can read a secret](#who-can-read-a-secret). |
| Can one team's step reach another team's secret? | No. A step runs in its own team's namespace, and a Pod can only mount Secrets from its own namespace. |
| Can one product reach another product's secret in the same team? | By design, yes: a team's secrets are the team's, and the team chooses per step which ones it gets (`secretRefs`). What a team can't do is give one to an image that isn't its registered product (it runs with no secrets), or mount a Secret it never registered. The console checks this at submit time, and an admission policy makes the cluster enforce it on every step's Job. A product's own cloud identity (its declared ServiceAccount) is still its own: another product can't run as it. |
| Can a team register another team's product, or its image, as its own? | No. A product name and an image repository belong to the first team that registers them, the repository even after its products are deleted (an admin can release an unused one). Catalog CI also derives each image's path from its team's folder, so one team can't publish under another's name. |
| Can anything but the console submit work? | No. kernel-api accepts only the console's ServiceAccount token, issued for kernel-api alone and checked with a TokenReview. See [How kernel-api knows its caller](#how-kernel-api-knows-its-caller). |
| Is anything enforced if the console is bypassed? | Yes: which namespaces steps may run in, which image sources they may use, image signatures (with Sigstore's policy-controller installed) and who may delete a team namespace. These are admission policies the Kubernetes API server applies. |
| Are secrets encrypted at rest? | That depends on the cluster. Enabling encryption of Secrets at rest in etcd, ideally with a KMS provider, is the cluster operator's responsibility and a prerequisite for production. |
| What reaches logs and outputs? | Whatever a step prints or returns. Acyclix stores step outputs and logs; a product must never print or return a secret. |

## Who is trusted

| Actor | Trusted to | Limited by |
| --- | --- | --- |
| Cluster administrators | Everything; they can read any Secret | Outside Acyclix's control |
| Acyclix admins (console) | Manage teams, people, bots, allowed image sources; act in any team | Console authorization; every admin action is logged |
| Catalog reviewers | Decide which product images exist, and which ServiceAccount and secrets each product declares | The catalog repository's review rules (CODEOWNERS, protected branches) |
| Team members | Run their team's products, register their team's secrets and choose which step gets which, manage their team's bots | Console authorization: team membership, per-product identity, registered team secrets |
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
   catalog pull request, never from the console.

Either way, the console **registers** it for the team (`secret_grants`): the
secret's name and its key names. Only registered secrets can be mounted, and
only by the team's registered products.

- The console labels what it creates (`app.kubernetes.io/managed-by:
  acyclix-console`) and won't replace, or register, a Secret it didn't
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
`/platform/secrets/<secret>/<key>`; Acyclix doesn't interpret the values.
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
1Password service account token) comes from the team's own GitHub
Environment, is written to `eso-auth`, and can never be registered or
mounted by a step. A synced secret rotates on the vault's side, with no
change in Acyclix.

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
   - the caller is a member of every team named, or an admin;
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

## How kernel-api knows its caller

kernel-api knows nothing about users or teams; it acts on whatever the
console asks, because the console has already authorized it. So it checks
one thing on every call: that the caller is the console
(`kernel/internal/api/auth.go`).

- The console's Pod gets its ServiceAccount token projected for the
  audience `acyclix-kernel-api` (rotated by the kubelet, valid an hour), so
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
execution data.

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
  registry credential into every team namespace as `acyclix-pull`, and the
  kernel names it as every step Pod's `imagePullSecret`
  (`scheduler.taskImagePullSecret`). Only the kubelet uses it: the name is
  reserved, so it can never be registered as a team secret and mounted.
  The console has it as a mounted file and rewrites every team's copy on
  each policy resync, so a rotation reaches every team within one
  interval. Turning the option off leaves the copies; delete them by hand.
- **Cluster administrators**, and anyone else the cluster's own RBAC lets read
  Secrets in a team namespace. Acyclix doesn't grant people Kubernetes
  access, but doesn't prevent a cluster operator from doing so.

## Guardrails the cluster enforces

These are ValidatingAdmissionPolicies (and, optionally, Sigstore's
policy-controller), so they hold even for a request that reaches the kernel
without going through the console:

| Guardrail | What it refuses | Where |
| --- | --- | --- |
| Dispatch namespaces | Jobs in any namespace not labelled `acyclix/team=true`, and in the platform's own namespace (`DISPATCH_REJECTED`) | `helm/charts/execution-kernel/templates/dispatch-policy.yaml` |
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

And at the network level, NetworkPolicies (`templates/networkpolicy.yaml` in both charts) let only the platform's own Pods connect to its Postgres, and only the console connect to kernel-api: a step's Pod can reach neither. They need a CNI that enforces NetworkPolicy, and they select Pods by label, so creating Pods in the platform namespace must stay limited to administrators. The bundled databases' passwords are generated on install.

## What Acyclix stores

| Where | What | Notes |
| --- | --- | --- |
| Console database | Users (argon2id password hashes), teams, memberships, bots (hashed API tokens), registered secrets (names and key names, no values), products, a record of submitted executions including their DAG | Sessions are signed tokens that expire (8 hours by default) |
| Kernel database | Each execution's DAG, step inputs (as submitted and as resolved), outputs, logs and events | Never put a secret in a step's `inputs`: inputs are stored and shown to the execution's viewers. When the console's database shares this Postgres instance (`postgres.consoleDatabase`), the console signs in as its own role, which owns only its database and is refused a connection to the kernel's |
| Team namespace | A ConfigMap per step attempt holding its `request.json` (its resolved inputs), deleted with the step's Job | Readable by anyone with ConfigMap access in that namespace |

## Rules for product authors

Products are written by catalog contributors, not by Acyclix, so these are
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
Acyclix isn't production-ready yet.

| Gap | Impact | Plan |
| --- | --- | --- |
| Steps can reach other Pods in the cluster | A step can connect to other teams' Pods and Services (not to the platform's databases or kernel-api) | A default-deny ingress policy in every team namespace |
| The console can still create and replace Secrets in any team namespace | A compromised console could plant or overwrite a team's secret values (it can't read them) | Bind its Secret rights per team namespace as teams are created |
| No TLS in the chart | The console must be put behind TLS by the operator | An optional Ingress or Gateway with certificates |
| Password sign-in only | No single sign-on or central account control | OIDC sign-in with groups mapped to teams |
| The audit log lives in the console's own database | Someone who can write that database could change it | Ship the `event: "audit"` log lines to a SIEM or write-once store |
| Any member of one team in a multi-team execution can read all of its outputs and logs | Cross-team visibility within shared executions | Decide: filter by team, or require every team for reads |

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

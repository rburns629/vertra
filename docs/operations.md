# Operations

Installing, upgrading and running Vertra: on your machine with `kind`, and
on a cloud cluster. For how it works, see [architecture.md](architecture.md);
for what it enforces, [security-model.md](security-model.md).

An installer CLI (`vertra`, see [TODO.md](../TODO.md)) will do the cloud
setup, the install and the catalog repository in one place. Until then,
`make` targets do it on `kind`, and the Helm charts directly anywhere else.
Either way, the charts are complete on their own: `helm install` creates both
databases, generates their passwords and creates the first admin.

## Local install with kind

Needs Docker (running), `kind`, `kubectl`, `helm` and `curl`.

```
make quickstart    # from nothing (or any state) to a running install; safe to re-run
```

It creates the `kind` cluster `vertra-local` and a local registry
(`localhost:5001`, where task images live), builds both platform images,
installs both charts into `vertra-system` with `helm/values/kind/*.yaml`,
creates the team `team-a`, and port-forwards the console to
http://localhost:18080. Sign in as `admin@example.com` / `vertra-local`:
that password is set only in the kind values, for a cluster nobody else can
reach. Never use it anywhere else.

Every day:

| Command | Does |
| --- | --- |
| `make up` | Resumes the node, clears Pods stuck as Unknown, port-forwards the console |
| `make down` | Stops the node and keeps everything (never `kind delete cluster` unless you mean to start over) |
| `make logs` | Tails kernel-api, the scheduler and the console together |
| `make catalog-publish` | Publishes `catalog-template/` with its `local` sample team (one product in five languages); `CATALOG=<folder>` publishes your own catalog, `SAMPLES=` other samples |
| `make kind-deploy` | Rebuilds both platform images and upgrades both releases (`kind-deploy-kernel`, `kind-deploy-console` for one) |
| `make test` | Starts a throwaway Postgres on `127.0.0.1:55432` and runs both projects' tests |

To try it: publish the samples, then paste the DAG from
`catalog-template/samples/local/README.md` into **Executions → Submit new**.
Each step is the same product in another language, chained with
`$fromTask`; the detail page follows it live.

## Installing on a cluster with Helm

Needs Kubernetes 1.30 or later, Helm 4, and a CNI that enforces
NetworkPolicy (GKE Dataplane V2, which Autopilot always has; on EKS the
network policy agent or Calico; on AKS a network policy engine).

1. **Images and charts.** Each release publishes both images (amd64 and
   arm64, scanned, signed keyless by the release workflow) and both charts
   to `ghcr.io/rburns629/vertra`, and the charts default to the images
   released with them: install from
   `oci://ghcr.io/rburns629/vertra/charts/execution-kernel` and
   `…/execution-console` with `--version <release>`. To run your own build
   instead, push `kernel/` and `console/` to your registry and set
   `image.repository` and `image.tag` (or `image.digest`).
2. **The platform namespace**, e.g. `vertra-system`. It's never a team's:
   the kernel's dispatch policy refuses to run steps in it. Keep who may
   create Pods there to administrators (NetworkPolicies trust its labels).
3. **Optional components**, before the charts that use them:
   - **Image signatures:** Sigstore's policy-controller
     (`helm/values/gke/policy-controller.yaml` is an example; it must exclude
     the platform namespace), then the kernel's `imageSignature` values.
   - **Syncing secrets from a vault:** External Secrets Operator
     (`helm repo add external-secrets https://charts.external-secrets.io`).
4. **Values.** Copy `helm/values/gke/` (or `kind/`) as a starting point;
   each file's comments say what its settings are for, and every setting is
   documented in the charts' `values.yaml`. The files are the whole of an
   environment's settings: deploy with `--reset-values`, so nothing set by
   hand lingers. At minimum: the image source tasks may use
   (`imagePolicy.sourceRegistry`), the console's `kernelApiUrl`
   (`http://<kernel release>-execution-kernel-api.<namespace>.svc.cluster.local:8000`),
   and the first admin's email.
5. **Install**, kernel first, with a size preset under your values (see
   [Sizes, sleeping and headroom](#sizes-sleeping-and-headroom)). Not
   `--wait` on a first install: each chart migrates its database in a
   post-install hook, which Helm runs only after `--wait` sees every Pod
   ready, and the console isn't ready until its tables exist. Helm still
   waits for the hook; wait for the rollout after it.

   ```
   CHARTS=oci://ghcr.io/rburns629/vertra/charts; V=<release, e.g. 0.1.0>; SIZE=minimal
   helm pull $CHARTS/execution-kernel --version $V --untar; helm pull $CHARTS/execution-console --version $V --untar
   helm install kernel ./execution-kernel -n vertra-system -f execution-kernel/sizes/$SIZE.yaml -f <values>/kernel.yaml
   helm install console ./execution-console -n vertra-system -f execution-console/sizes/$SIZE.yaml -f <values>/console.yaml
   kubectl -n vertra-system rollout status deployment -l 'app.kubernetes.io/instance in (kernel,console)'
   kubectl -n vertra-system logs job/console-execution-console-migrate   # the first admin's password, shown once
   ```

   Upgrades (`helm upgrade`) can use `--wait`: they migrate before the
   rollout.

6. **Reach the console** with `kubectl port-forward svc/console-execution-console 18080:8080`,
   or expose it. The charts don't add TLS: put the console behind TLS (an
   Ingress or Gateway with a certificate, ideally an identity-aware proxy)
   before anyone signs in over a network. kernel-api must stay `ClusterIP`.
7. **Sign in, change the password**, and on the Admin page: add admins,
   mint the catalog's automation token, and set the allowed image sources.

`make gke-deploy` (and `gke-deploy-kernel`, `-console`, `-policy-controller`,
`-eso`) does the build and upgrade for GKE with Cloud Build, with the
settings in `helm/values/gke/` and the context named in the Makefile; it
shows what's about to ship and asks you to type the cluster's name first.

### Cloud identities

No component needs a stored cloud key. Bind these Kubernetes ServiceAccounts
to cloud identities with the cloud's workload identity (GKE Workload
Identity, EKS Pod Identity or IRSA, AKS Workload Identity), each with only
what it needs:

| ServiceAccount | Needs | Set by |
| --- | --- | --- |
| The console's | Read manifests in the registries it checks and pins (`registryCheck`) | `serviceAccount.annotations` |
| The image scanner's | Pull from those registries | `scanning.serviceAccountAnnotations` |
| `vertra-pg-backup` | Write to the backup bucket | You create it ([Backups](#backups)) |
| A team's `eso-<cloud>` | Read that team's secrets in its vault | The team's SecretStore file |
| A product's own | Whatever that product does | The product's `serviceAccount`; an admin adds the binding |

For a registry that needs a password instead, put a
`kubernetes.io/dockerconfigjson` Secret in the platform namespace and name
it in `registryCheck.pullSecretName`; with `registryCheck.copyToTeams`, the
console copies it into every team namespace as `vertra-pull` and the
kernel's `scheduler.taskImagePullSecret` names it on step Pods.

### The API gateway

API products are served by the gateway, which the console chart runs when
`gateway.enabled` is on. Set `gateway.backendHosts` to the hosts backends
may be under (`orders.example.com`, or `*.a.run.app` for any name below
it); an API under none is held. `gateway.url` is where callers reach it
inside the cluster (its Service, `<release>-execution-console-gateway:8080`);
with `gateway.publicListener`, port 8081 serves the APIs of
`gateway.internetTeams` that ask to be reachable from the internet: put an
Ingress or load balancer in front of it, at `gateway.publicUrl`.
An admin closes it from the Admin page (every API answers 503 with their
message), or `gateway.closed` keeps it closed; a team's maintainers pause
one of theirs from its page. With `gateway.ingress`, an Ingress serves the
public listener at `gateway.ingress.host`. Its NetworkPolicy lets it reach
anything but the cloud metadata server; narrow it with `gateway.egress`.
Backend credentials: `googleIdToken` needs `gateway.gcp` (vertra sets it
on GKE; the API's Google service account grants its ServiceAccount's
principal `roles/iam.serviceAccountOpenIdTokenCreator`), and `awsSigV4` a
role whose trust policy accepts the cluster's OIDC issuer for
`system:serviceaccount:<team>:<api>-api`, audience `sts.amazonaws.com`
(the issuer registered as an IAM OIDC provider; a GKE cluster's is public,
so a GKE install calls AWS backends with no AWS cluster). A Lambda
function URL needs both `lambda:InvokeFunctionUrl` and
`lambda:InvokeFunction` on the role. On kind, `make kind-deploy-console` builds
it and allows backends in the `vertra-samples` namespace.

### Reading another install's catalog

One catalog serves many installs. An install that reads another's sets
`externalCatalog.registry` in its vertra.yaml (the image source, and where
its release lives) and `catalogSignature.publicKeyFile` (the catalog's
cosign public key: only releases it signed are applied). On the same cloud,
grant the install's console and scanner identities read on that registry.

For a Google Artifact Registry read from another cloud (EKS, AKS, any
cluster with an OIDC issuer), nothing is stored: the console exchanges its
own ServiceAccount token for an hour's Google token (Workload Identity
Federation) and hands it to the kubelet (`vertra-pull` in each team
namespace) and its Jobs (`vertra-registry-token`), renewed every policy
sync. After the first `vertra apply`, the registry's owner runs, in its
project, the commands apply prints:

```
gcloud iam workload-identity-pools create vertra-installs --location=global --project=<project>
gcloud iam workload-identity-pools providers create-oidc <cluster> --location=global \
  --workload-identity-pool=vertra-installs --project=<project> --issuer-uri=<cluster's OIDC issuer> \
  --attribute-mapping=google.subject=assertion.sub \
  --attribute-condition="assertion.sub=='system:serviceaccount:vertra-system:console-execution-console'"
gcloud artifacts repositories add-iam-policy-binding <repository> --location=<region> --project=<project> \
  --role=roles/artifactregistry.reader \
  --member=principal://iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/vertra-installs/subject/system:serviceaccount:vertra-system:console-execution-console
```

then sets `externalCatalog.gcpWorkloadIdentityProvider` to
`projects/<number>/locations/global/workloadIdentityPools/vertra-installs/providers/<cluster>`
and applies again. The provider trusts only that cluster's issuer, and only
the console's ServiceAccount from it. Revoke the install by deleting its
provider.

### Sizes, sleeping and headroom

Each chart ships four presets in `sizes/` (`minimal`, `resilient`,
`scaled`, `auto`), layered under your values with `-f`. They set the
copies of the console and kernel-api (with PodDisruptionBudgets from two
copies, so drains and upgrades take one at a time), the scheduler's step
caps and default step size, how long executions are kept and the database
volume's size; `auto` scales the console and kernel-api from one to three
copies on CPU load, and needs the cluster's metrics API (metrics-server;
built into GKE, EKS Auto Mode and AKS Automatic). `vertra` picks one
from its `size` setting. A preset doesn't say where steps run: Spot is
`scheduler.taskPlacement`. Labels every step Pod needs, such as AKS
Workload Identity's `azure.workload.identity/use: "true"`, go in
`scheduler.taskPodLabels`.

- **Sleeping when idle** (kernel chart, `scaleDown`): a CronJob scales both
  releases' Deployments to zero after `idleAfterMinutes` with no execution
  unfinished or recently finished, nobody using the console (the console
  records its last use in its `activity` ConfigMap) and kernel-api not
  restarted; `schedule` also sleeps it at set times once nothing runs.
  Volumes stay. Wake it with `vertra wake`, or by scaling each
  Deployment back to the copies recorded in the
  `kernel-execution-kernel-sleep` ConfigMap (the database first). While
  asleep, the console and kernel-api don't answer, so catalog CI fails
  until it's woken. A `helm upgrade` while asleep wakes it (pass
  `--force-conflicts`: the sleeper owns the replica counts it set).
- **The image scanner idles** on its own (console chart,
  `scanning.idleMinutes`, 15 by default): scaled to zero when no scan has
  been asked for in that long, and back up for the next, whose first scan
  then waits about a minute for it.
- **Warm headroom** (kernel chart, `stepHeadroom.replicas`): placeholder
  Pods the size of a default step, at a priority every step outranks, so
  a step takes a placeholder's place instead of waiting for a node. It's
  reserved around the clock: for always-on installs.

## Upgrading

`helm upgrade` with the same values files and `--reset-values`. Two things
to know:

- **Upgrade the kernel chart with `--force-conflicts`.** The console edits
  the kernel's image, identity and scan policies, so Helm's server-side
  apply sees it as their owner; without the flag the upgrade fails with a
  conflict. The chart writes back what the console last set, so nothing is
  lost.
- **Migrations run first**, as a Helm hook, before any new Pod starts, on
  every upgrade (a no-op when nothing's pending). The scheduler waits for
  them on a fresh install.

**Images reused under the same tag.** With `pullPolicy: IfNotPresent` (the
default) and a reused tag such as `:latest`, a node that already has the old
image keeps it. Deploy by digest (`image.digest`) or a new tag, or set
`pullPolicy: Always` and `kubectl rollout restart` the Deployments (a Helm
upgrade that changes nothing in the Pod template doesn't restart them).
Check what's really running with
`kubectl get pods -o jsonpath='{..imageID}'`.

## Databases

Each chart can run its own Postgres (`postgres.enabled`), a single replica
on a volume; or use an external database. On a small install the kernel's
Postgres can also hold the console's database (`postgres.consoleDatabase`),
where the console signs in as its own role, which owns only its database.

**Passwords** are generated on install when left empty, kept in the
release's Secret (`<release>-execution-kernel-db` for the kernel,
`<release>-execution-console` for the console) and read back on every
upgrade. To rotate one:

```
NS=vertra-system; PG=deploy/kernel-execution-kernel-postgres; SECRET=kernel-execution-kernel-db
NEW=$(openssl rand -hex 24)
# 1. The role, sent on stdin so it never shows in a process list.
printf "ALTER ROLE postgres PASSWORD '%s';\n" "$NEW" | kubectl -n $NS exec -i $PG -- psql -q -U postgres -v ON_ERROR_STOP=1
# 2. Both fields of the Secret, before any helm upgrade (the migration hook reads database-url).
URL=$(kubectl -n $NS get secret $SECRET -o jsonpath='{.data.database-url}' | base64 -d | sed "s|^\([^:]*://[^:]*\):[^@]*@|\1:$NEW@|")
kubectl -n $NS patch secret $SECRET --type merge -p "{\"stringData\":{\"postgres-password\":\"$NEW\",\"database-url\":\"$URL\"}}"
# 3. Restart what holds the old one.
kubectl -n $NS rollout restart deployment kernel-execution-kernel-api kernel-execution-kernel-scheduler
```

The console's own Postgres is the same with its Secret, then restart the
console. Checking a password from inside the Postgres Pod proves nothing:
local connections are trusted there.

**Connecting.** Neither database is exposed outside the cluster, and
NetworkPolicies admit only the platform's own Pods. To look at one:

```
kubectl -n vertra-system exec -it deploy/kernel-execution-kernel-postgres -- psql -U postgres -d execution_kernel
# or execution_console (in the console's Postgres, or the kernel's when it holds both)
```

Always pass `--context`: port-forward output doesn't say which cluster it
reached. Writing by hand bypasses every check the console makes; use the
API for anything it can do. What's in each database:
[architecture.md](architecture.md#data).

**Retention.** Finished executions (with their tasks, outputs, logs and
events) are deleted 90 days after their last event
(`executionRetentionDays`; the console's record of them, its audit log and
scan verdicts have their own settings in `retention`). 0 keeps them forever.

## Backups

Off by default (`backup.enabled`), for the bundled Postgres only. A CronJob
in each chart runs `pg_dump -Fc`, checks the dump with `pg_restore --list`,
names it `<release>/<UTC timestamp>.pgdump` (with the console's database, on
a shared instance, as `<backupPrefix>/<same timestamp>.pgdump`), and copies it
to `backup.destination`:

| `destination` | Copies with | Signs in with | Proven |
| --- | --- | --- | --- |
| `gcs` | `gsutil cp` | GKE Workload Identity | Not since a template fix; see TODO.md |
| `s3` | `aws s3 cp` | EKS Pod Identity or IRSA; a key in `s3.credentialsSecret` for an S3-compatible service without one | On kind, against an S3-compatible service |
| `azure` | `az storage blob upload --auth-mode login` | AKS Workload Identity | Not yet |
| `pvc` | `cp`, deleting dumps older than `pvc.keepDays` | Nothing | On kind |

For the cloud destinations, the copy runs as `backup.serviceAccountName`
(default `vertra-pg-backup`). Create it in the platform namespace and bind
it to an identity that may write to the bucket and nothing else: on GCS,
`roles/storage.objectCreator` and `roles/storage.objectViewer` on the bucket
(`gsutil` lists before writing); on S3, `s3:PutObject`; on Azure, Storage Blob
Data Contributor on the container. Keep dumps as long as you need with a
lifecycle rule on the bucket. For `pvc`, create the claim yourself
(`backup.pvc.claimName`): most storage classes bind a volume only once a Pod
uses it, which would hang `helm upgrade --wait`.

**Restoring** (proven on kind, replacing both live databases on a shared
instance; with two instances, restore each on its own):

```
# 1. Download a matching pair (gcloud storage cp, aws s3 cp, az storage blob download).
# 2. Stop everything that writes (the scheduler releases its leases on the way out).
kubectl -n $NS scale deployment kernel-execution-kernel-api kernel-execution-kernel-scheduler console-execution-console --replicas=0
# 3. Copy the dumps into the Postgres Pod.
kubectl -n $NS exec -i deploy/kernel-execution-kernel-postgres -- sh -c 'cat > /tmp/kernel.pgdump' < kernel.pgdump
kubectl -n $NS exec -i deploy/kernel-execution-kernel-postgres -- sh -c 'cat > /tmp/console.pgdump' < console.pgdump
# 4. Inside the Pod (kubectl exec -it ... -- sh):
export PGUSER=postgres
dropdb --force execution_kernel && createdb execution_kernel
pg_restore --exit-on-error -d execution_kernel /tmp/kernel.pgdump
dropdb --force execution_console && createdb -O console execution_console
pg_restore --exit-on-error --no-owner --role=console -d execution_console /tmp/console.pgdump
psql -c 'REVOKE CONNECT ON DATABASE execution_kernel FROM PUBLIC' \
     -c 'REVOKE CONNECT ON DATABASE execution_console FROM PUBLIC' \
     -c 'GRANT CONNECT ON DATABASE execution_console TO console'
rm /tmp/*.pgdump
# 5. Start everything again.
kubectl -n $NS scale deployment kernel-execution-kernel-api kernel-execution-kernel-scheduler console-execution-console --replicas=1
```

The console's database must stay owned by its own role, or the console
can't use its tables. To only check a backup, restore it into a new
database instead.

## Network policies

Both charts ship NetworkPolicies (`networkPolicy.enabled`, on by default):

| Pod | Accepts connections from |
| --- | --- |
| Kernel Postgres | The kernel release's Pods, and the console's when it holds the console's database |
| kernel-api | The console (`networkPolicy.consoleSelector`), and `networkPolicy.metricsFrom` |
| Scheduler | `networkPolicy.metricsFrom` only |
| Console Postgres | The console release's Pods |

So a step can reach neither database nor kernel-api.

Each team namespace gets one too, `vertra-default-deny`, written by the
console with the namespace and rewritten on every policy resync (console
chart, `teamNamespaces.defaultDenyIngress`, on by default; only when the
console manages team namespaces). Its Pods accept connections only from
Pods in the same namespace, so teams can't reach each other. A namespace
the console doesn't manage needs the same policy from whoever made it.
Outbound traffic isn't restricted.

## Troubleshooting

**`401` from the console's API.** The token is missing, malformed, expired
(sessions last 8 hours), from before a password change (which signs out
every session), or a revoked bot token.

**`429` signing in.** Too many attempts from one address for one account:
wait for the time shown. The counter is in memory, so restarting the
console clears it.

**A submission is refused.** The response says why:
- `403`: not a member of a team the DAG names; a secret not registered for
  its team; or an image that isn't one of the team's products asking for
  secrets or an identity.
- `422`: the DAG itself (every problem listed), an input that looks like a
  credential, or `IMAGE_NOT_RESOLVED` (the registry doesn't have the tag,
  or the console can't reach it: check `registryCheck` and, on kind,
  `make kind-registry`).
- `409 IMAGE_SCAN_PENDING`: its first scan is still running; submit again
  in a minute. `IMAGE_SCAN_FAILED`: it has a fixable HIGH/CRITICAL
  vulnerability or a secret in it; rebuild it, or an admin accepts it with a
  reason (Admin page, or `ImageService/AcceptImageScan`).

**A task fails with a policy code** (non-retryable, refused by the cluster):

| Code | Meaning |
| --- | --- |
| `DISPATCH_REJECTED` | Its namespace isn't labelled `vertra/team=true` |
| `IMAGE_NOT_ALLOWED` | Its image isn't under an allowed source (Admin page) |
| `IMAGE_NOT_PINNED`, `IMAGE_SCAN_FAILED` | Not pinned by digest; a failed scan |
| `IMAGE_NOT_SIGNED` | Not signed by the catalog's key (with policy-controller) |
| `INPUT_INVALID`, `OUTPUT_INVALID` | Not refused by the cluster but by the kernel: its resolved inputs, or its outputs, don't fit its product's schema (`product.yaml`'s `input` and `output`) |
| `IDENTITY_NOT_ALLOWED` | A ServiceAccount or secret its product isn't allowed. If the console allowed it, the policy may be behind: the Admin's policy sync (`AdminService/GetPolicySync`) shows the last sync's outcome |

**A task never starts, or stays `RUNNING`.** `kubectl get pods -n <team>`
and `kubectl describe pod` name the real problem. A first pull on a cloud
cluster can take a minute while a node scales up. `IMAGE_NOT_FOUND` fails
at once; other pull errors (registry auth, network) fail as
`IMAGE_PULL_FAILED` after two minutes.

**A task stays `AWAITING_APPROVAL`.** Its product (or its team's
`allowedTargets`) asks a maintainer of its team to approve it, on the run's
page; the person who ran it can't. Nobody deciding within the kernel
chart's `scheduler.approvalTimeoutSeconds` (3 days; 0 never) fails it with
`APPROVAL_EXPIRED`.

**A task fails with `OUTPUT_CONTAINS_CREDENTIAL`.** Its outputs held
something shaped like a credential, so they weren't stored: the product must
output a reference instead.

**A synced secret doesn't arrive.** `kubectl describe externalsecret <name>
-n <team>` names the failure. Check the store too: `kubectl get secretstore
-n <team>` showing `Ready: False` means the store's own sign-in is broken
(its workload identity binding, or an expired bootstrap credential).

**Old code still runs after a redeploy.** See [Upgrading](#upgrading):
reused tags.

**A catalog workflow shows "a workflow file issue" and runs no jobs.** It
didn't parse. Run `actionlint` on it; a common cause is using `secrets` in a
step's `if:` (move it to `env:` and test that).

**On kind:**
- Docker Desktop restarted and the node stopped (`docker ps -a` shows
  `vertra-local-control-plane` as `Exited`): `make up`. If `docker start`
  itself fails, restart Docker Desktop.
- The console stopped answering after a redeploy: its port-forward was on
  the old Pod; `make up`.
- `postgres:16` won't load with a TLS error on some networks: `docker save`
  it, `docker cp` it onto the node, and import it with
  `ctr --namespace=k8s.io images import` there.
- Forgotten local admin password:

  ```
  HASH=$(kubectl -n vertra-system exec deploy/console-execution-console -- \
    node -e "require('./dist/auth/password.js').hashPassword('vertra-local').then(console.log)")
  kubectl -n vertra-system exec deploy/kernel-execution-kernel-postgres -- \
    psql -U postgres -d execution_console -c "UPDATE users SET password_hash = '$HASH' WHERE email = 'admin@example.com';"
  ```

  On a real install, another admin creates a new admin account instead.

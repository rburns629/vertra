// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";

/**
 * One validated config object, read once at startup — same principle as
 * kernel/app/config.py's Settings: fail immediately and legibly on a
 * missing/invalid value, not three calls deep into a request.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** A session lifetime like "8h", "30m", or "1d" -- the subset of fast-jwt's
 * `expiresIn` string format this service actually accepts. Checked here,
 * at startup, rather than left for fast-jwt to reject: a typo would
 * otherwise only surface as a 500 on the first login attempt. */
function parseSessionTtl(value: string): string {
  if (!/^\d+(m|h|d)$/.test(value)) {
    throw new Error(`Invalid JWT_TTL "${value}": expected a number followed by m, h, or d (e.g. "8h").`);
  }
  return value;
}

function parseBoolean(name: string): boolean {
  const value = process.env[name];
  if (value === undefined || value === "" || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`Invalid ${name} "${value}": expected "true" or "false".`);
}

/** Registry credentials by host, from a Docker config file -- the same
 * `.dockerconfigjson` format as a Kubernetes image pull Secret, so any
 * registry that works as an imagePullSecret works here. Read at startup
 * so a bad mount fails the deploy, not the first image check. */
export type RegistryCredentials = Map<string, { username: string; password: string }>;

/**
 * Where to reach a registry from inside the cluster when that differs from
 * its name in image references: "host=url" pairs, comma-separated. On kind,
 * images are named localhost:5001/..., which the nodes map to the
 * kind-registry container, but which from a Pod is the Pod itself:
 * "localhost:5001=http://kind-registry:5000". Plain http only when listed.
 */
function parseRegistryMirrors(value: string | undefined): Map<string, string> {
  const mirrors = new Map<string, string>();
  for (const pair of (value ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [host, url] = pair.split("=", 2).map((s) => s.trim());
    if (!host || !url || !/^https?:\/\/[^/]+$/.test(url)) {
      throw new Error(`REGISTRY_MIRRORS entry "${pair}" isn't "host=http(s)://host[:port]".`);
    }
    mirrors.set(host, url);
  }
  return mirrors;
}

function loadRegistryCredentials(path: string | undefined): RegistryCredentials {
  const credentials: RegistryCredentials = new Map();
  if (!path) return credentials;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`REGISTRY_AUTH_FILE "${path}" isn't a readable JSON file: ${String(error)}`);
  }
  const auths = (parsed as { auths?: Record<string, { auth?: string; username?: string; password?: string }> }).auths;
  if (typeof auths !== "object") {
    throw new Error(`REGISTRY_AUTH_FILE "${path}" has no "auths" object.`);
  }
  for (const [key, entry] of Object.entries(auths)) {
    // Keys are hosts, or URLs like "https://index.docker.io/v1/".
    const host = key.includes("://") ? new URL(key).host : key.replace(/\/.*$/, "");
    const decoded = entry.auth ? Buffer.from(entry.auth, "base64").toString("utf8") : null;
    const separator = decoded?.indexOf(":") ?? -1;
    const username = decoded && separator > 0 ? decoded.slice(0, separator) : entry.username;
    const password = decoded && separator > 0 ? decoded.slice(separator + 1) : entry.password;
    if (!username || !password) {
      throw new Error(`REGISTRY_AUTH_FILE entry "${key}" has no usable credentials.`);
    }
    credentials.set(host === "index.docker.io" ? "registry-1.docker.io" : host, { username, password });
  }
  return credentials;
}

export const config = {
  port: Number(process.env["PORT"] ?? 8080),
  databaseUrl: requireEnv("DATABASE_URL"),
  // Signs and verifies session JWTs. Must be long and random in any real
  // deployment — this is not a value with a safe default.
  jwtSecret: requireEnv("JWT_SECRET"),
  // How long a login session stays valid before the user has to sign in
  // again. Bounded on purpose: with no expiry, a leaked token was usable
  // forever, and rotating JWT_SECRET (logging *everyone* out) was the only
  // way to revoke one. A password change/reset additionally revokes a
  // user's earlier sessions immediately (see auth/plugin.ts).
  jwtTtl: parseSessionTtl(process.env["JWT_TTL"] ?? "8h"),
  // Only read by db/migrate.ts's one-time bootstrap seed, never by the
  // running server. Deliberately no hardcoded default password: if
  // BOOTSTRAP_ADMIN_PASSWORD isn't set, migrate.ts generates a random one
  // instead of falling back to anything guessable — see its own comment.
  bootstrapAdminEmail: process.env["BOOTSTRAP_ADMIN_EMAIL"] ?? "admin@example.com",
  bootstrapAdminPassword: process.env["BOOTSTRAP_ADMIN_PASSWORD"],
  // kernel-api knows nothing of users or teams: this service is its only
  // accepted caller (kernelApiTokenFile below) and authorizes every request
  // first (routes/executions.ts). Reachable only from inside the cluster.
  kernelApiUrl: requireEnv("KERNEL_API_URL"),
  // This Pod's ServiceAccount token, projected for kernel-api's audience
  // (the chart mounts it), sent on every kernel-api call: kernel-api checks
  // it with a TokenReview and accepts only this console (kernel/app/api/
  // auth.py). Read on each call, since the kubelet rotates it. Unset only
  // when kernel-api runs with its check disabled, in local development.
  kernelApiTokenFile: process.env["KERNEL_API_TOKEN_FILE"],
  // Purely cosmetic -- rendered as a badge in the UI so it's visually
  // obvious which deployment a browser tab is actually talking to (a
  // local `kind` cluster vs a real GKE deployment, both of which run the
  // identical chart). Never used for any behavioral decision, so an
  // unset/wrong value is never a correctness bug, just a confusing badge
  // -- a sensible default is fine here, unlike the values above.
  environmentLabel: process.env["ENVIRONMENT_LABEL"] ?? "unlabeled environment",
  // Off unless set: accounts are created by an admin (Admin page ->
  // Accounts, POST /api/users), with their teams attached. Open
  // registration has no email verification, so anyone who can reach the
  // console could make an account; turn it on only behind a trusted
  // network boundary.
  allowSelfRegistration: parseBoolean("ALLOW_SELF_REGISTRATION"),
  // The proxies in front of the console, as addresses and CIDR ranges
  // (comma-separated), so request.ip (the sign-in throttle, rate limits,
  // logs) is the real client: behind Google's external Application Load
  // Balancer, its front ends (35.191.0.0/16, 130.211.0.0/22) and its own
  // address, which it appends after the client's. Empty (the default):
  // X-Forwarded-For is ignored, since anything could have written it.
  trustProxy: (process.env["TRUST_PROXY"] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  // Checking that a DAG's images still exist before running it (see
  // registry.ts). Only registries named here are ever contacted: those in
  // REGISTRY_AUTH_FILE, plus Artifact Registry/GCR when
  // REGISTRY_GCP_METADATA_TOKEN is on (short-lived tokens from the GKE
  // metadata server via Workload Identity, so GKE needs no stored key).
  // With neither set, nothing is checked and the kernel's own dispatch
  // (IMAGE_NOT_FOUND) is the only guard.
  registryCredentials: loadRegistryCredentials(process.env["REGISTRY_AUTH_FILE"]),
  registryGcpMetadataToken: parseBoolean("REGISTRY_GCP_METADATA_TOKEN"),
  // EKS: short-lived ECR credentials from the console's own AWS identity
  // (EKS Pod Identity), for ECR registries, instead of a stored key.
  registryEcrToken: parseBoolean("REGISTRY_ECR_TOKEN"),
  registryMirrors: parseRegistryMirrors(process.env["REGISTRY_MIRRORS"]),
  // Every task's image is pinned to its digest at submission (routes/
  // executions.ts): "required" refuses a submission whose image the registry
  // can't resolve; "off" sends tags as they are (tests, a registry the
  // console can't reach).
  imagePinning: (process.env["IMAGE_PINNING"] ?? "required") === "off" ? ("off" as const) : ("required" as const),
  // Where the allowed image sources live: inside the execution-kernel
  // chart's image admission policy itself (helm/charts/execution-kernel/
  // templates/image-policy.yaml), which the Admin page edits; see
  // imagePolicy.ts. Named after that release: "<release>-execution-kernel-image".
  imagePolicyName: process.env["IMAGE_POLICY_NAME"] ?? "kernel-execution-kernel-image",
  // The kernel chart's identity admission policy (identity-policy.yaml),
  // whose list of registered products this console keeps in step with its
  // own (productPolicy.ts), so the cluster enforces each product's
  // ServiceAccount and Secrets too. The chart always sets it; unset (as in
  // tests) means the console never writes to the cluster.
  identityPolicyName: process.env["IDENTITY_POLICY_NAME"] ?? "",
  // How often the identity and scan policies are rewritten from the
  // database whatever changed (policySync.ts), so drift doesn't last.
  policySyncIntervalSeconds: Number(process.env["POLICY_SYNC_INTERVAL_SECONDS"] ?? "300"),
  // How long things are kept, in days (retention.ts); 0 keeps them forever.
  retention: {
    // Submitted-execution records; set it as the kernel's
    // execution_retention_days, which deletes the executions themselves.
    executionDays: Number(process.env["EXECUTION_RETENTION_DAYS"] ?? "90"),
    auditDays: Number(process.env["AUDIT_RETENTION_DAYS"] ?? "365"),
    // Scan verdicts of images not used for this long.
    scanDays: Number(process.env["SCAN_RETENTION_DAYS"] ?? "90"),
  },
  // The platform's registry pull Secret (a .dockerconfigjson file, mounted
  // from the chart's registryCheck.pullSecretName), which the console copies
  // into every team namespace as k8s.ts's TEAM_PULL_SECRET (pullSecret.ts),
  // so steps can run images from private registries. Unset: not copied.
  teamPullSecretFile: process.env["TEAM_PULL_SECRET_FILE"] ?? "",
  // This release's own namespace (where scan Jobs run).
  platformNamespace: process.env["PLATFORM_NAMESPACE"] ?? "",
  // The ConfigMap the console records its last use in (activity.ts), for
  // the kernel's sleeper. Empty (as in tests): not recorded.
  activityConfigMap: process.env["ACTIVITY_CONFIGMAP"] ?? "",
  // Scanning every image before it's registered or run (scanning.ts): a
  // Trivy client Job per digest, in the platform's namespace, against the
  // chart's Trivy server. Off (as in tests) means no scans and no checks.
  scanning: {
    enabled: process.env["SCANNING_ENABLED"] === "true",
    serverUrl: process.env["SCANNER_SERVER_URL"] ?? "",
    image: process.env["SCANNER_IMAGE"] ?? "",
    serviceAccount: process.env["SCANNER_SERVICE_ACCOUNT"] ?? "",
    // The registryCheck pull Secret, for private registries.
    pullSecretName: process.env["SCANNER_PULL_SECRET"] ?? "",
    // How long a submission waits for an image's first scan before asking
    // the caller to try again.
    waitSeconds: Number(process.env["SCAN_WAIT_SECONDS"] ?? "60"),
    // Images in use are scanned again once their verdict is this old.
    rescanHours: Number(process.env["SCAN_RESCAN_HOURS"] ?? "24"),
    // The kernel chart's scan admission policy, which holds the failed digests.
    policyName: process.env["SCAN_POLICY_NAME"] ?? "",
    // The Trivy server's Deployment, which the console scales to zero after
    // idleMinutes with no scans and back up when one is wanted. Empty: it's
    // left running.
    scannerDeployment: process.env["SCANNER_DEPLOYMENT"] ?? "",
    idleMinutes: Number(process.env["SCANNER_IDLE_MINUTES"] ?? "15"),
    // Which image of a multi-platform index to scan: what the cluster runs.
    // Defaults to the console's own (its nodes'), as Trivy would otherwise
    // pick linux/amd64 whatever the cluster is.
    platform: process.env["SCAN_PLATFORM"] || `linux/${process.arch === "x64" ? "amd64" : process.arch}`,
  },
  // Team namespaces (k8s.ts's team namespace functions, routes/teams.ts):
  // the console creates a team's namespace with the team label, relabels it
  // when the team is retired or un-retired, and (with purge) deletes it when
  // the team is purged, so catalog CI needs no cluster credentials. The
  // chart turns it on; unset (as in tests) the console leaves namespaces
  // to someone else.
  teamNamespaces: {
    manage: process.env["TEAM_NAMESPACES_MANAGE"] === "true",
    purge: process.env["TEAM_NAMESPACES_PURGE"] === "true",
    // The kernel's dispatch policy runs steps only in namespaces with this
    // label set to "true"; "retired" stops it.
    label: process.env["TEAM_NAMESPACE_LABEL"] ?? "acyclix/team",
    // Pod Security level enforced in the namespaces it creates (the kernel's
    // step Pods meet `restricted`); empty for none.
    podSecurity: process.env["TEAM_NAMESPACE_POD_SECURITY"] ?? "",
    // Never a team's, whatever a team is called: the platform's own, and
    // any the operator lists. (kube-* always.)
    protected: [
      ...(process.env["PLATFORM_NAMESPACE"] ? [process.env["PLATFORM_NAMESPACE"]] : []),
      ...(process.env["PROTECTED_NAMESPACES"] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      "kube-system",
      "kube-public",
      "kube-node-lease",
    ],
  },
  // What the Team page's "Connect a source" wizard needs to tell a platform
  // owner: which repo the connection's PR goes to, and the facts a cloud
  // provider must trust for this cluster's identities. Display only: a
  // wrong value produces a wrong instruction, never a wrong permission
  // (the SecretStore still goes through review). Empty means "not available
  // on this cluster", and the wizard says so instead of guessing.
  secretSources: {
    // owner/repo of the catalog, where teams/<team>/secret-stores/ lives.
    catalogRepo: process.env["SECRET_SOURCES_CATALOG_REPO"] ?? "",
    // This cluster's service-account token issuer, for Azure and AWS to
    // federate with (on GKE: https://container.googleapis.com/v1/projects/
    // <project>/locations/<location>/clusters/<cluster>).
    clusterIssuer: process.env["SECRET_SOURCES_CLUSTER_ISSUER"] ?? "",
    // GKE Workload Identity: the pool (<project>.svc.id.goog) and the
    // cluster's name and location, which a gcpsm SecretStore names.
    gcpWorkloadIdentityPool: process.env["SECRET_SOURCES_GCP_WORKLOAD_IDENTITY_POOL"] ?? "",
    gkeClusterName: process.env["SECRET_SOURCES_GKE_CLUSTER_NAME"] ?? "",
    gkeClusterLocation: process.env["SECRET_SOURCES_GKE_CLUSTER_LOCATION"] ?? "",
  },
};

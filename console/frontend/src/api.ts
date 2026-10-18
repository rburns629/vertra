// SPDX-License-Identifier: MIT
/**
 * Typed client for the execution-console API (../src/routes/*.ts). Hand-written
 * to match those TypeBox schemas exactly rather than generated -- there's no
 * OpenAPI spec to generate from, and the surface is small enough that keeping
 * the two in sync by hand is the actually-simpler option here.
 *
 * In dev, requests go through Vite's proxy (vite.config.ts) so they're
 * same-origin as far as the browser is concerned; in production the built
 * assets are served by the same Fastify process as the API (see
 * ../../src/index.ts), so they're genuinely same-origin. Either way this
 * client never needs to know the API's origin.
 */

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * execution-console's own errors look like {error, message}. Errors
 * relayed straight through from kernel-api (see ../../src/routes/
 * executions.ts's relayKernelError) are FastAPI's shape instead --
 * {detail: string} for a plain HTTPException, or {detail: [{code,
 * message, taskId}, ...]} for a DAG validation failure. Without handling
 * both, a kernel-native error (e.g. "Only a FAILED task can be retried")
 * would silently degrade to a generic "request failed with status 409".
 */
function extractErrorMessage(body: unknown, path: string, status: number): string {
  if (body !== null && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record["message"] === "string") return record["message"];
    if (typeof record["detail"] === "string") return record["detail"];
    if (Array.isArray(record["detail"])) {
      return record["detail"]
        .map((issue: unknown) =>
          issue !== null && typeof issue === "object" && "message" in issue
            ? String((issue as Record<string, unknown>)["message"])
            : JSON.stringify(issue),
        )
        .join("; ");
    }
  }
  return `Request to ${path} failed with status ${status}`;
}

/** Dispatched on `window` when an authenticated request comes back 401. */
export const SESSION_EXPIRED_EVENT = "auth:session-expired";

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem("token");
  const headers = new Headers(options.headers);
  // Only with a body: Fastify's JSON parser refuses an empty body sent with
  // this header (a bodyless POST, like cancel, retry or rerun).
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  // Every real API route lives under /api (see ../../src/index.ts) --
  // specifically so this path can never collide with a same-named React
  // Router page and get served by the wrong handler on a hard refresh.
  const response = await fetch(`/api${path}`, { ...options, headers });

  if (response.status === 204) {
    return undefined as T;
  }

  const body: unknown = await response.json().catch(() => null);

  // A 401 on a request that *carried* a token means the session is over
  // (expired, or revoked by a password change). Tell AuthContext so it can
  // sign the user out instead of every page showing its own confusing
  // "Missing or invalid token" error. A 401 without a token (a failed
  // login) is just a failed login.
  if (response.status === 401 && token) {
    localStorage.removeItem("token");
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  }

  if (!response.ok) {
    throw new ApiError(response.status, extractErrorMessage(body, path, response.status));
  }

  return body as T;
}

export interface Environment {
  label: string;
  /** Whether /auth/register is open; otherwise admins create accounts. */
  selfRegistration: boolean;
}

/** Unauthenticated -- see ../../src/index.ts's /environment route. */
export function getEnvironment(): Promise<Environment> {
  return request("/environment");
}

export interface Me {
  id: string;
  email: string;
  teamNames: string[];
  isAdmin: boolean;
}

export interface Team {
  id: string;
  name: string;
  createdAt: string;
  /** Set while the team is retired: read-only, its platform being wound
   * down (see ../../src/db/schema.ts). */
  retiredAt: string | null;
  /** Set once the team has been purged; its name stays reserved. */
  deletedAt: string | null;
}

export function register(email: string, password: string): Promise<{ id: string; email: string }> {
  return request("/auth/register", { method: "POST", body: JSON.stringify({ email, password }) });
}

export async function login(email: string, password: string): Promise<string> {
  const { token } = await request<{ token: string }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  return token;
}

export function getMe(): Promise<Me> {
  return request("/me");
}

export function createTeam(name: string): Promise<Team> {
  return request("/teams", { method: "POST", body: JSON.stringify({ name }) });
}

export function addTeamMember(teamName: string, email: string): Promise<void> {
  return request(`/teams/${encodeURIComponent(teamName)}/members`, {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export interface TeamMember {
  id: string;
  email: string;
  isBot: boolean;
  /** An Acyclix admin (platform-wide), not just this team's member. */
  isAdmin: boolean;
  addedAt: string;
}

export function listTeamMembers(teamName: string): Promise<TeamMember[]> {
  return request(`/teams/${encodeURIComponent(teamName)}/members`);
}

/** Refused (409) for a team's last person -- see ../../src/routes/teams.ts. */
export function removeTeamMember(teamName: string, userId: string): Promise<void> {
  return request(`/teams/${encodeURIComponent(teamName)}/members/${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });
}

/** Admin-only -- see ../../src/routes/teams.ts. A non-admin's own teams
 * come from Me.teamNames instead; this is for browsing every team. */
export function listAllTeams(): Promise<Team[]> {
  return request("/teams");
}

export function getTeam(teamName: string): Promise<Team> {
  return request(`/teams/${encodeURIComponent(teamName)}`);
}

/** Reversible: the team becomes read-only and its products are
 * unregistered. Admin (or catalog CI) only. */
export function retireTeam(teamName: string): Promise<void> {
  return request(`/teams/${encodeURIComponent(teamName)}/retire`, { method: "POST" });
}

export function unretireTeam(teamName: string): Promise<void> {
  return request(`/teams/${encodeURIComponent(teamName)}/unretire`, { method: "POST" });
}

/** Which images tasks may run: only those under `allowed` (the source
 * registry plus any additional sources). The cluster enforces the same
 * list; see ../../src/imagePolicy.ts. */
export interface ImagePolicy {
  /** False when the policy ConfigMap is missing (the kernel isn't installed). */
  exists: boolean;
  source: string;
  additional: string[];
  allowed: string[];
  version: string;
}

export function getImagePolicy(): Promise<ImagePolicy> {
  return request("/image-policy");
}

/** Admin only. `version` is the one loaded, so a concurrent change is
 * refused (409) instead of overwritten. */
export function updateImagePolicy(source: string, additional: string[], version: string): Promise<ImagePolicy> {
  return request("/image-policy", { method: "PUT", body: JSON.stringify({ source, additional, version }) });
}

/** Irreversible, console side only: a retired team with nothing still
 * running. Its namespace and images are the catalog's purge workflow's
 * job. Admin only. */
export function purgeTeam(teamName: string): Promise<void> {
  return request(`/teams/${encodeURIComponent(teamName)}`, { method: "DELETE" });
}

/** A human account and its active teams (Admin page; admin only). */
export interface UserAccount {
  email: string;
  isAdmin: boolean;
  createdAt: string;
  teamNames: string[];
}

export function listUsers(): Promise<UserAccount[]> {
  return request("/users");
}

/** Admin only. The temporary password comes back exactly once; hand it
 * over out of band and have the user change it after signing in. */
export function createAccount(
  email: string,
  teams: string[],
  admin: boolean,
): Promise<{ email: string; temporaryPassword: string }> {
  return request("/users", { method: "POST", body: JSON.stringify({ email, teams, admin }) });
}

/** Admin only. The account's executions stay in the history. */
export function deleteAccount(email: string): Promise<void> {
  return request(`/users/${encodeURIComponent(email)}`, { method: "DELETE" });
}

/** Admin-only both ways -- see ../../src/routes/users.ts. */
export function grantAdmin(email: string): Promise<void> {
  return request(`/users/${encodeURIComponent(email)}/admin`, { method: "POST" });
}

export function revokeAdmin(email: string): Promise<void> {
  return request(`/users/${encodeURIComponent(email)}/admin`, { method: "DELETE" });
}

/** Must match NewPassword in ../../src/auth/password.ts. */
export const PASSWORD_MIN_LENGTH = 12;

/** Returns a fresh session token -- every earlier session for this account,
 * including the one that made this call, is revoked by the change. */
export async function changePassword(currentPassword: string, newPassword: string): Promise<string> {
  const { token } = await request<{ token: string }>("/me/password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  return token;
}

export function resetUserPassword(email: string, newPassword: string): Promise<void> {
  return request(`/users/${encodeURIComponent(email)}/password`, {
    method: "POST",
    body: JSON.stringify({ newPassword }),
  });
}

export interface SecretGrantInput {
  namespace: string;
  secretName: string;
  data: Record<string, string>;
}

export function registerSecret(input: SecretGrantInput): Promise<void> {
  return request("/secrets", { method: "POST", body: JSON.stringify(input) });
}

/** Syncs from a `SecretStore` already in this namespace (see
 * listSecretStores) rather than a pasted value. Only the reference is
 * sent; no secret value passes through this request. `property` picks one
 * field of the remote secret (a 1Password item's field, a key of a JSON
 * secret). */
export interface ExternalSecretGrantInput {
  namespace: string;
  secretName: string;
  secretStoreName: string;
  keys: { secretKey: string; remoteKey: string; property?: string }[];
}

export function registerExternalSecret(input: ExternalSecretGrantInput): Promise<void> {
  return request("/secrets/external", { method: "POST", body: JSON.stringify(input) });
}

/** A team's secret source -- see ../../src/k8s.ts's SecretStoreSummary. */
export interface SecretStoreSummary {
  name: string;
  provider: string;
  providerLabel: string;
  location: string | null;
  identity: string | null;
  usesStoredCredential: boolean;
  /** Null until ESO has checked it once. */
  ready: boolean | null;
  message: string | null;
  /** How many other teams' stores sign in as the same identity. */
  sharedWithCount: number;
  /** Which teams: only filled in for an admin. */
  sharedWith: string[] | null;
}

export function listSecretStores(teamName: string): Promise<SecretStoreSummary[]> {
  return request(`/teams/${encodeURIComponent(teamName)}/secret-stores`);
}

/** Live from the cluster on every call -- see ../../src/k8s.ts. */
export interface ExternalSecretDetails {
  name: string;
  storeName: string | null;
  entries: { secretKey: string; remoteKey: string; property: string | null }[];
  refreshInterval: string | null;
  lastSyncedAt: string | null;
  status: "synced" | "syncing" | "error";
  message: string | null;
}

/** One row of a team's secrets: key names only, never values. `managed`
 * is false for an ExternalSecret created outside the console, which no step
 * can mount until it's registered here. */
export interface TeamSecret {
  id: string;
  secretName: string;
  keys: string[];
  source: "literal" | "external";
  managed: boolean;
  updatedAt: string | null;
  external: ExternalSecretDetails | null;
}

export function listTeamSecrets(teamName: string): Promise<TeamSecret[]> {
  return request(`/teams/${encodeURIComponent(teamName)}/secrets`);
}

/** Removes the grant, the ServiceAccount's access, and the Secret the
 * console created. Tasks already running keep what they mounted. */
export function revokeSecret(teamName: string, secretName: string): Promise<void> {
  return request(`/teams/${encodeURIComponent(teamName)}/secrets/${encodeURIComponent(secretName)}`, {
    method: "DELETE",
  });
}

/** Deployment facts for the "Connect a source" wizard -- see
 * ../../src/config.ts's secretSources. Empty strings mean "not available
 * on this cluster". */
export interface PlatformInfo {
  secretSources: {
    catalogRepo: string;
    clusterIssuer: string;
    gcpWorkloadIdentityPool: string;
    gkeClusterName: string;
    gkeClusterLocation: string;
  };
}

export function getPlatform(): Promise<PlatformInfo> {
  return request("/platform");
}

export interface Product {
  id: string;
  name: string;
  image: string;
  action: string;
  teamId: string | null;
  /** The owning team's name, i.e. the product's platform. Null for a
   * platform-provided product that no team owns. */
  teamName: string | null;
  inputSchema: Record<string, unknown>;
  /** The rest of its product.yaml, as catalog CI registers it (null or
   * empty until it does): see the catalog's docs/product-schema.md. */
  displayName: string | null;
  description: string | null;
  outputSchema: Record<string, unknown>;
  serviceAccount: string | null;
  requiredSecrets: string[];
  createdAt: string;
  /** Every image this product has been registered with, newest first.
   * `image` above is the current one, which the UI marks "latest". */
  releases: ProductRelease[];
}

export interface ProductRelease {
  image: string;
  registeredAt: string;
}

/** Open to any authenticated user -- discovering what products exist to
 * build a DAG from isn't scoped the way registering one is. Normally
 * populated by catalog CI (see ../../src/routes/products.ts), not by hand. */
export function listProducts(): Promise<Product[]> {
  return request("/products");
}

export interface ApiTokenMeta {
  id: string;
  label: string;
  createdAt: string;
  /** Recorded to within a few minutes; null if never used. */
  lastUsedAt: string | null;
}

export interface Bot {
  id: string;
  email: string;
  tokens: ApiTokenMeta[];
}

export function listBots(teamName: string): Promise<Bot[]> {
  return request(`/teams/${encodeURIComponent(teamName)}/bots`);
}

/** The raw `token` in the response is shown to the caller exactly once --
 * this client never stores or logs it, same as the backend never persists
 * it in plaintext (see ../../src/db/schema.ts's apiTokens). */
export function createBot(
  teamName: string,
  email: string,
  label: string,
): Promise<{ email: string; token: string; tokenId: string }> {
  return request(`/teams/${encodeURIComponent(teamName)}/bots`, {
    method: "POST",
    body: JSON.stringify({ email, label }),
  });
}

export function revokeToken(tokenId: string): Promise<void> {
  return request(`/tokens/${encodeURIComponent(tokenId)}`, { method: "DELETE" });
}

/** Must match SCOPES in ../../src/auth/scopes.ts. */
export const AUTOMATION_SCOPES = [
  { scope: "teams:create", description: "Create teams and their namespaces (catalog CI onboarding a new platform)", defaultOn: true },
  {
    scope: "products:register",
    description: "Register and update any team's products (catalog CI after a build)",
    defaultOn: true,
  },
  {
    scope: "teams:retire",
    description: "Retire or un-retire a team, reversible (catalog CI when a team's folder is removed or restored)",
    defaultOn: true,
  },
  {
    // Off by default on purpose: this belongs on its own token, held only
    // by the catalog's reviewer-gated purge workflow.
    scope: "teams:delete",
    description: "Purge a retired team for good, namespace included. Give this to a separate token used only by the purge workflow",
    defaultOn: false,
  },
  {
    scope: "secret-stores:apply",
    description: "Apply a team's reviewed SecretStore file (catalog CI after a secret-stores pull request merges)",
    defaultOn: true,
  },
] as const;

export interface AutomationToken {
  id: string;
  label: string;
  scopes: string[];
  botEmail: string;
  createdAt: string;
}

export function listAutomationTokens(): Promise<AutomationToken[]> {
  return request("/automation-tokens");
}

/** The raw `token` is only ever returned here, once. */
export function createAutomationToken(
  label: string,
  scopes: string[],
): Promise<{ tokenId: string; label: string; scopes: string[]; token: string }> {
  return request("/automation-tokens", { method: "POST", body: JSON.stringify({ label, scopes }) });
}

/** console/'s own record of an execution -- who submitted it and which teams'
 * tasks it contains (see ../../src/db/schema.ts's submittedExecutions).
 * This, not kernel-api, is what a listing comes from: kernel-api has no
 * concept of "which executions can this caller see." */
export interface ExecutionSummary {
  executionId: string;
  teams: string[];
  submittedBy: string;
  name: string;
  createdAt: string;
  /** Live, fetched from kernel-api in bulk on every list load -- `null`
   * only if that lookup itself failed (kernel-api briefly unreachable),
   * not a real execution state. */
  state: string | null;
}

export interface ExecutionPage {
  executions: ExecutionSummary[];
  /** Pass back as `cursor` for the next page; null on the last. */
  nextCursor: string | null;
}

export interface ExecutionListQuery {
  limit?: number;
  cursor?: string;
  /** ISO date-time: only executions submitted since. */
  since?: string;
  team?: string;
  /** Part of the name. */
  search?: string;
}

/** The executions you can see, newest first, a page at a time. */
export function listExecutions(query: ExecutionListQuery = {}): Promise<ExecutionPage> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const queryString = params.toString();
  return request(`/executions${queryString ? `?${queryString}` : ""}`);
}

/** `payload` is deliberately `unknown`, not a typed ExecutionSubmission --
 * see ../../src/routes/executions.ts's own comment: kernel-api's Pydantic
 * models are the one authority on the full shape, and this client (like
 * that route) only needs to pass it through, not re-validate it. */
export function submitExecution(payload: unknown): Promise<{ executionId: string; state: string }> {
  return request("/executions", { method: "POST", body: JSON.stringify(payload) });
}

export interface TaskStatus {
  taskId: string;
  state: string;
  attemptCount: number;
  outputs: Record<string, unknown> | null;
  failure: { code: string; message: string; retryable: boolean } | null;
  /** The real DAG edges, from kernel's own persisted `task_dependencies`
   * table (see kernel/app/services/execution_service.py) -- not derived
   * or re-inferred client-side. */
  dependsOn: string[];
  /** The current attempt's real timing, from `task_attempts` --
   * `completedAt` is null while a task is still running or hasn't
   * started yet. */
  startedAt: string | null;
  completedAt: string | null;
}

/** One task exactly as originally submitted (see kernel/app/contracts/
 * task.py's TaskDefinition) -- this is *input*, kept for reference
 * alongside TaskStatus's live *outcome*; the two are joined client-side by
 * `id`/`taskId` since kernel-api's own detail response only carries the
 * outcome half. Every field with a server-side default (dependsOn,
 * inputs, timeoutSeconds, maxAttempts, secretRefs) is typed optional here
 * on purpose -- this is the *raw* JSON body console/ originally stored (see
 * routes/executions.ts's recordSubmittedExecution), not kernel-api's own
 * parsed/defaulted TaskDefinition, so an omitted optional field really is
 * absent, not `[]`/`{}`. Any read of these must fall back explicitly. */
export interface SubmittedTaskPayload {
  id: string;
  image: string;
  action: string;
  dependsOn?: string[];
  inputs?: Record<string, unknown>;
  timeoutSeconds?: number;
  maxAttempts?: number;
  team: string;
  serviceAccount: string;
  secretRefs?: string[];
}

/** As stored at submission. Executions submitted before the rename carry
 * the old names (externalReference, idempotencyKey) instead. */
export interface SubmittedExecutionPayload {
  name?: string;
  requestId?: string;
  externalReference?: string;
  idempotencyKey?: string;
  tasks: SubmittedTaskPayload[];
}

/** Proxied live from kernel-api (see ../../src/routes/executions.ts) --
 * state/tasks are real-time, not a cached copy of ExecutionSummary.
 * teams/submittedBy/createdAt are merged in by console/ from its own
 * submitted-executions index -- kernel-api itself has no concept of
 * either. `submittedBy` is `null` only if that user's account has since
 * been deleted. `payload` is the exact original submission body, `null`
 * only for executions submitted before console/ started storing it. */
export interface ExecutionDetail {
  executionId: string;
  name: string;
  state: string;
  tasks: TaskStatus[];
  teams: string[];
  submittedBy: string | null;
  createdAt: string;
  payload: SubmittedExecutionPayload | null;
  /** Why rerun and task retry are refused (a purged or retired team, or an
   * image the registry says is gone), or null when they aren't. */
  runBlocked: {
    error: "TEAM_PURGED" | "TEAM_RETIRED" | "IMAGE_NOT_FOUND" | "IMAGE_NOT_ALLOWED" | "IMAGE_POLICY_NOT_CONFIGURED";
    message: string;
    missingImages?: string[];
    disallowedImages?: string[];
  } | null;
}

export function getExecution(executionId: string): Promise<ExecutionDetail> {
  return request(`/executions/${encodeURIComponent(executionId)}`);
}

export function cancelExecution(executionId: string): Promise<{ executionId: string; state: string }> {
  return request(`/executions/${encodeURIComponent(executionId)}/cancel`, { method: "POST" });
}

export function retryTask(
  executionId: string,
  taskId: string,
): Promise<{ executionId: string; state: string }> {
  return request(
    `/executions/${encodeURIComponent(executionId)}/tasks/${encodeURIComponent(taskId)}/retry`,
    { method: "POST" },
  );
}

/** Resubmits the execution's original task graph as a brand-new execution
 * (a new executionId, not a reset of this one -- see
 * ../../src/routes/executions.ts's own comment on why). Fails with a 422
 * if this execution predates rerun support and has no stored submission to
 * replay. */
export function rerunExecution(executionId: string): Promise<{ executionId: string; state: string }> {
  return request(`/executions/${encodeURIComponent(executionId)}/rerun`, { method: "POST" });
}

export interface ExecutionEvent {
  id: number;
  eventType: string;
  taskId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** Cursor-paginated -- see kernel/app/contracts/execution.py's
 * ExecutionEventPage. `after` is an event id, not an offset, so polling
 * with the previous page's nextCursor never re-fetches or skips events
 * even if more were inserted in between polls. */
export function getExecutionEvents(
  executionId: string,
  after?: number,
): Promise<{ events: ExecutionEvent[]; nextCursor: number | null }> {
  const query = after !== undefined ? `?after=${String(after)}` : "";
  return request(`/executions/${encodeURIComponent(executionId)}/events${query}`);
}

/** One task's captured container stdout, as actually run -- distinct from
 * ExecutionEvent, which only records scheduler-level transitions
 * (TASK_STARTED, TASK_SUCCEEDED, ...) and never what the container itself
 * printed. `lines` is `[]` for a task that hasn't completed an attempt yet,
 * not an error -- see kernel/app/contracts/execution.py's TaskLogsResponse. */
export interface TaskLogs {
  taskId: string;
  lines: string[];
}

/** Every task's logs in one call -- see kernel/app/contracts/execution.py's
 * ExecutionLogsResponse for why this isn't split per task. */
export function getExecutionLogs(executionId: string): Promise<{ tasks: TaskLogs[] }> {
  return request(`/executions/${encodeURIComponent(executionId)}/logs`);
}

/** Admin-only -- see ../../src/routes/stats.ts. A non-admin's home view
 * derives its own numbers from data it fetches anyway (Me.teamNames,
 * its own already-scoped executions list). */
export interface PlatformStats {
  teams: number;
  users: number;
  products: number;
  executions: number;
}

export function getStats(): Promise<PlatformStats> {
  return request("/stats");
}

/** One task attempt in a team's namespace -- see ../../src/routes/pods.ts.
 * Read-only, no secret data, never another team's. */
export interface TaskPod {
  podName: string;
  executionId: string | null;
  taskKey: string | null;
  attempt: number | null;
  image: string | null;
  serviceAccount: string | null;
  state: "starting" | "running" | "cant-start" | "finished" | "failed";
  problem: { title: string; detail: string } | null;
  restarts: number;
  startedAt: string | null;
  finishedAt: string | null;
  execution: { name: string; taskNumber: number | null; taskCount: number | null } | null;
}

export function listTeamPods(teamName: string): Promise<TaskPod[]> {
  return request(`/teams/${encodeURIComponent(teamName)}/pods`);
}

/** The in-app Docs page -- see ../../src/routes/docs.ts. Any
 * authenticated user, no team scoping. */
export interface DocSummary {
  id: string;
  title: string;
}

export function listDocs(): Promise<DocSummary[]> {
  return request("/docs");
}

/** The console API's OpenAPI 3 description -- see ../../src/openapi.ts. */
export interface OpenApiSchema {
  type?: string | string[];
  description?: string;
  format?: string;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  items?: OpenApiSchema;
  anyOf?: OpenApiSchema[];
  enum?: unknown[];
  additionalProperties?: boolean | OpenApiSchema;
}

export interface OpenApiOperation {
  tags?: string[];
  summary?: string;
  description?: string;
  security?: unknown[];
  parameters?: { name: string; in: string; required?: boolean; schema?: OpenApiSchema; description?: string }[];
  requestBody?: { content?: Record<string, { schema?: OpenApiSchema }> };
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: OpenApiSchema }> }>;
}

export interface OpenApiSpec {
  info: { title: string; description?: string };
  tags?: { name: string; description?: string }[];
  paths: Record<string, Record<string, OpenApiOperation>>;
}

export function getOpenApi(): Promise<OpenApiSpec> {
  return request("/openapi.json");
}

/** Raw markdown, not JSON -- can't go through request()'s
 * response.json() the same way every other endpoint here does. */
export async function getDoc(id: string): Promise<string> {
  const token = localStorage.getItem("token");
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`/api/docs/${encodeURIComponent(id)}`, { headers });
  if (!response.ok) {
    throw new ApiError(response.status, `Request to /docs/${id} failed with status ${response.status}`);
  }
  return response.text();
}

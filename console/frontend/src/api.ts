// SPDX-License-Identifier: MIT
/**
 * The console API for the pages: plain objects over the generated Connect
 * clients (./gen, from proto/acyclix/console/v1). Pages use these
 * functions and types, never the messages, so the wire contract can change
 * without touching them.
 *
 * In dev, requests go through Vite's proxy (vite.config.ts) so they're
 * same-origin as far as the browser is concerned; in production the built
 * assets are served by the same Fastify process as the API (see
 * ../../src/index.ts), so they're genuinely same-origin. Either way this
 * client never needs to know the API's origin.
 */
import { createClient, Code, ConnectError, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import { timestampDate, timestampFromDate, type Timestamp } from "@bufbuild/protobuf/wkt";
import { AdminService } from "./gen/acyclix/console/v1/admin_pb.js";
import { AuthService } from "./gen/acyclix/console/v1/auth_pb.js";
import {
  DagSchema,
  ExecutionService,
  ExecutionState,
  TaskState,
  type Dag,
  type Execution,
} from "./gen/acyclix/console/v1/execution_pb.js";
import { GuideService } from "./gen/acyclix/console/v1/guide_pb.js";
import { ImageService, type ImagePolicy as ImagePolicyMessage } from "./gen/acyclix/console/v1/image_pb.js";
import { ProductService } from "./gen/acyclix/console/v1/product_pb.js";
import { SecretService, SecretSource } from "./gen/acyclix/console/v1/secret_pb.js";
import { TaskPodState, TeamService, type Team as TeamMessage } from "./gen/acyclix/console/v1/team_pb.js";
import { TokenService } from "./gen/acyclix/console/v1/token_pb.js";
import { UserService } from "./gen/acyclix/console/v1/user_pb.js";

/** A refusal or failure, with the HTTP status REST would have used. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Dispatched on `window` when an authenticated request comes back unauthenticated. */
export const SESSION_EXPIRED_EVENT = "auth:session-expired";

const HTTP_STATUS: Partial<Record<Code, number>> = {
  [Code.Canceled]: 499,
  [Code.InvalidArgument]: 400,
  [Code.DeadlineExceeded]: 504,
  [Code.NotFound]: 404,
  [Code.AlreadyExists]: 409,
  [Code.PermissionDenied]: 403,
  [Code.ResourceExhausted]: 429,
  [Code.FailedPrecondition]: 409,
  [Code.Aborted]: 409,
  [Code.OutOfRange]: 400,
  [Code.Unimplemented]: 501,
  [Code.Unavailable]: 503,
  [Code.Unauthenticated]: 401,
};

/**
 * Sends the session token. An unauthenticated answer to a request that
 * *carried* one means the session is over (expired, or revoked by a
 * password change): AuthContext signs the user out instead of every page
 * showing its own error. Without a token (a failed login) it's just that.
 */
const session: Interceptor = (next) => async (req) => {
  const token = localStorage.getItem("token");
  if (token) req.header.set("Authorization", `Bearer ${token}`);
  try {
    return await next(req);
  } catch (error) {
    if (token && ConnectError.from(error).code === Code.Unauthenticated) {
      localStorage.removeItem("token");
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    }
    throw error;
  }
};

// Every API route lives under /api (see ../../src/index.ts), so it can never
// collide with a same-named React Router page on a hard refresh.
const transport = createConnectTransport({ baseUrl: "/api", interceptors: [session] });
const auth = createClient(AuthService, transport);
const admin = createClient(AdminService, transport);
const executions = createClient(ExecutionService, transport);
const guides = createClient(GuideService, transport);
const images = createClient(ImageService, transport);
const productsApi = createClient(ProductService, transport);
const secrets = createClient(SecretService, transport);
const teams = createClient(TeamService, transport);
const tokens = createClient(TokenService, transport);
const users = createClient(UserService, transport);

function apiError(error: unknown): ApiError {
  const connect = ConnectError.from(error);
  return new ApiError(HTTP_STATUS[connect.code] ?? 500, connect.rawMessage);
}

/** Runs a call, turning a Connect error into an ApiError with its message alone. */
async function call<T>(rpc: () => Promise<T>): Promise<T> {
  try {
    return await rpc();
  } catch (error) {
    throw apiError(error);
  }
}

const iso = (timestamp: Timestamp | undefined): string | null =>
  timestamp ? timestampDate(timestamp).toISOString() : null;

export interface Environment {
  label: string;
  /** Whether /auth/register is open; otherwise admins create accounts. */
  selfRegistration: boolean;
}

/** Unauthenticated -- see ../../src/index.ts's /environment route. */
export function getEnvironment(): Promise<Environment> {
  return call(() => auth.getEnvironment({}));
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

export async function register(email: string, password: string): Promise<{ id: string; email: string }> {
  const created = await call(() => auth.register({ email, password }));
  return { id: created.userId, email: created.email };
}

export async function login(email: string, password: string): Promise<string> {
  return (await call(() => auth.login({ email, password }))).token;
}

export async function getMe(): Promise<Me> {
  const me = await call(() => auth.getMe({}));
  return { id: me.userId, email: me.email, teamNames: me.teamNames, isAdmin: me.isAdmin };
}

export async function createTeam(name: string): Promise<Team> {
  return team((await call(() => teams.createTeam({ name }))).team);
}

function team(message: TeamMessage | undefined): Team {
  return {
    id: message?.id ?? "",
    name: message?.name ?? "",
    createdAt: iso(message?.createdAt) ?? "",
    retiredAt: iso(message?.retiredAt),
    deletedAt: iso(message?.deletedAt),
  };
}

export async function addTeamMember(teamName: string, email: string): Promise<void> {
  await call(() => teams.addMember({ team: teamName, email }));
}

export interface TeamMember {
  id: string;
  email: string;
  isBot: boolean;
  /** An Acyclix admin (platform-wide), not just this team's member. */
  isAdmin: boolean;
  addedAt: string;
}

export async function listTeamMembers(teamName: string): Promise<TeamMember[]> {
  const { members } = await call(() => teams.listMembers({ team: teamName }));
  return members.map((m) => ({ id: m.id, email: m.email, isBot: m.isBot, isAdmin: m.isAdmin, addedAt: iso(m.addedAt) ?? "" }));
}

/** Refused (409) for a team's last person -- see ../../src/routes/teams.ts. */
export async function removeTeamMember(teamName: string, userId: string): Promise<void> {
  await call(() => teams.removeMember({ team: teamName, userId }));
}

/** Admin-only -- see ../../src/routes/teams.ts. A non-admin's own teams
 * come from Me.teamNames instead; this is for browsing every team. */
export async function listAllTeams(): Promise<Team[]> {
  return (await call(() => teams.listTeams({}))).teams.map(team);
}

export async function getTeam(teamName: string): Promise<Team> {
  return team((await call(() => teams.getTeam({ name: teamName }))).team);
}

/** Reversible: the team becomes read-only and its products are
 * unregistered. Admin (or catalog CI) only. */
export async function retireTeam(teamName: string): Promise<void> {
  await call(() => teams.retireTeam({ name: teamName }));
}

export async function unretireTeam(teamName: string): Promise<void> {
  await call(() => teams.unretireTeam({ name: teamName }));
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

export async function getImagePolicy(): Promise<ImagePolicy> {
  return imagePolicy((await call(() => images.getImagePolicy({}))).policy);
}

function imagePolicy(policy: ImagePolicyMessage | undefined): ImagePolicy {
  return {
    exists: policy?.exists ?? false,
    source: policy?.source ?? "",
    additional: policy?.additional ?? [],
    allowed: policy?.allowed ?? [],
    version: policy?.version ?? "",
  };
}

/** Admin only. `version` is the one loaded, so a concurrent change is
 * refused (409) instead of overwritten. */
export async function updateImagePolicy(source: string, additional: string[], version: string): Promise<ImagePolicy> {
  return imagePolicy((await call(() => images.setImagePolicy({ source, additional, version }))).policy);
}

/** Irreversible, console side only: a retired team with nothing still
 * running. Its namespace and images are the catalog's purge workflow's
 * job. Admin only. */
export async function purgeTeam(teamName: string): Promise<void> {
  await call(() => teams.purgeTeam({ name: teamName }));
}

/** A human account and its active teams (Admin page; admin only). */
export interface UserAccount {
  email: string;
  isAdmin: boolean;
  createdAt: string;
  teamNames: string[];
}

export async function listUsers(): Promise<UserAccount[]> {
  const { users: accounts } = await call(() => users.listUsers({}));
  return accounts.map((u) => ({ email: u.email, isAdmin: u.isAdmin, createdAt: iso(u.createdAt) ?? "", teamNames: u.teamNames }));
}

/** Admin only. The temporary password comes back exactly once; hand it
 * over out of band and have the user change it after signing in. */
export async function createAccount(
  email: string,
  teamNames: string[],
  admin: boolean,
): Promise<{ email: string; temporaryPassword: string }> {
  const created = await call(() => users.createUser({ email, teams: teamNames, admin }));
  return { email: created.email, temporaryPassword: created.temporaryPassword };
}

/** Admin only. The account's executions stay in the history. */
export async function deleteAccount(email: string): Promise<void> {
  await call(() => users.deleteUser({ email }));
}

/** Admin-only both ways -- see ../../src/routes/users.ts. */
export async function grantAdmin(email: string): Promise<void> {
  await call(() => users.setAdmin({ email, admin: true }));
}

export async function revokeAdmin(email: string): Promise<void> {
  await call(() => users.setAdmin({ email, admin: false }));
}

/** Must match NewPassword in ../../src/auth/password.ts. */
export const PASSWORD_MIN_LENGTH = 12;

/** Returns a fresh session token -- every earlier session for this account,
 * including the one that made this call, is revoked by the change. */
export async function changePassword(currentPassword: string, newPassword: string): Promise<string> {
  return (await call(() => auth.changePassword({ currentPassword, newPassword }))).token;
}

export async function resetUserPassword(email: string, newPassword: string): Promise<void> {
  await call(() => users.resetPassword({ email, newPassword }));
}

export interface SecretGrantInput {
  namespace: string;
  secretName: string;
  data: Record<string, string>;
}

export async function registerSecret(input: SecretGrantInput): Promise<void> {
  await call(() => secrets.putSecret({ team: input.namespace, secretName: input.secretName, data: input.data }));
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

export async function registerExternalSecret(input: ExternalSecretGrantInput): Promise<void> {
  await call(() =>
    secrets.syncSecret({
      team: input.namespace,
      secretName: input.secretName,
      secretStoreName: input.secretStoreName,
      keys: input.keys,
    }),
  );
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

export async function listSecretStores(teamName: string): Promise<SecretStoreSummary[]> {
  const { stores } = await call(() => secrets.listSecretStores({ team: teamName }));
  return stores.map((store) => ({
    name: store.name,
    provider: store.provider,
    providerLabel: store.providerLabel,
    location: store.location ?? null,
    identity: store.identity ?? null,
    usesStoredCredential: store.usesStoredCredential,
    ready: store.ready ?? null,
    message: store.message ?? null,
    sharedWithCount: store.sharedWithCount,
    // Only an admin is told which teams; to anyone else the list is empty.
    sharedWith: store.sharedWith.length > 0 ? store.sharedWith : null,
  }));
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

export async function listTeamSecrets(teamName: string): Promise<TeamSecret[]> {
  const { secrets: rows } = await call(() => secrets.listSecrets({ team: teamName }));
  return rows.map((secret) => ({
    id: secret.id,
    secretName: secret.secretName,
    keys: secret.keys,
    source: secret.source === SecretSource.EXTERNAL ? "external" : "literal",
    managed: secret.managed,
    updatedAt: iso(secret.updatedAt),
    external: (secret.external ?? null) as ExternalSecretDetails | null,
  }));
}

/** Removes the grant, the ServiceAccount's access, and the Secret the
 * console created. Tasks already running keep what they mounted. */
export async function revokeSecret(teamName: string, secretName: string): Promise<void> {
  await call(() => secrets.revokeSecret({ team: teamName, secretName }));
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

export async function getPlatform(): Promise<PlatformInfo> {
  const { catalogRepo, clusterIssuer, gcpWorkloadIdentityPool, gkeClusterName, gkeClusterLocation } = await call(() =>
    secrets.getSecretSources({}),
  );
  return {
    secretSources: { catalogRepo, clusterIssuer, gcpWorkloadIdentityPool, gkeClusterName, gkeClusterLocation },
  };
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
export async function listProducts(): Promise<Product[]> {
  const { products } = await call(() => productsApi.listProducts({}));
  return products.map((p) => ({
    id: p.id,
    name: p.name,
    image: p.image,
    action: p.action,
    teamId: p.teamId ?? null,
    teamName: p.teamName ?? null,
    inputSchema: p.inputSchema ?? {},
    displayName: p.displayName ?? null,
    description: p.description ?? null,
    outputSchema: p.outputSchema ?? {},
    serviceAccount: p.serviceAccount ?? null,
    requiredSecrets: p.requiredSecrets,
    createdAt: iso(p.createdAt) ?? "",
    releases: p.releases.map((r) => ({ image: r.image, registeredAt: iso(r.registeredAt) ?? "" })),
  }));
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

export async function listBots(teamName: string): Promise<Bot[]> {
  const { bots } = await call(() => tokens.listBots({ team: teamName }));
  return bots.map((bot) => ({
    id: bot.id,
    email: bot.email,
    tokens: bot.tokens.map((t) => ({
      id: t.id,
      label: t.label,
      createdAt: iso(t.createdAt) ?? "",
      lastUsedAt: iso(t.lastUsedAt),
    })),
  }));
}

/** The raw `token` in the response is shown to the caller exactly once --
 * this client never stores or logs it, same as the backend never persists
 * it in plaintext (see ../../src/db/schema.ts's apiTokens). */
export async function createBot(
  teamName: string,
  email: string,
  label: string,
): Promise<{ email: string; token: string; tokenId: string }> {
  const created = await call(() => tokens.createBotToken({ team: teamName, email, label }));
  return { email: created.email, token: created.token, tokenId: created.tokenId };
}

export async function revokeToken(tokenId: string): Promise<void> {
  await call(() => tokens.revokeToken({ tokenId }));
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

export async function listAutomationTokens(): Promise<AutomationToken[]> {
  const { tokens: rows } = await call(() => tokens.listAutomationTokens({}));
  return rows.map((t) => ({
    id: t.id,
    label: t.label,
    scopes: t.scopes,
    botEmail: t.botEmail,
    createdAt: iso(t.createdAt) ?? "",
  }));
}

/** The raw `token` is only ever returned here, once. */
export async function createAutomationToken(
  label: string,
  scopes: string[],
): Promise<{ tokenId: string; label: string; scopes: string[]; token: string }> {
  const created = await call(() => tokens.createAutomationToken({ label, scopes }));
  return { tokenId: created.tokenId, label: created.label, scopes: created.scopes, token: created.token };
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
export async function listExecutions(query: ExecutionListQuery = {}): Promise<ExecutionPage> {
  const page = await call(() =>
    executions.listExecutions({
      page: { limit: query.limit ?? 0, cursor: query.cursor ?? "" },
      team: query.team ?? "",
      search: query.search ?? "",
      ...(query.since ? { since: timestampFromDate(new Date(query.since)) } : {}),
    }),
  );
  return {
    executions: page.executions.map((row) => ({
      executionId: row.executionId,
      teams: row.teams,
      submittedBy: row.submittedBy ?? "",
      name: row.name,
      createdAt: iso(row.createdAt) ?? "",
      state: row.state === ExecutionState.UNSPECIFIED ? null : ExecutionState[row.state],
    })),
    nextCursor: page.nextCursor || null,
  };
}

/** `payload` is deliberately `unknown`, not a typed ExecutionSubmission --
 * see ../../src/routes/executions.ts's own comment: kernel-api's Pydantic
 * models are the one authority on the full shape, and this client (like
 * that route) only needs to pass it through, not re-validate it. */
export async function submitExecution(payload: unknown): Promise<{ executionId: string; state: string }> {
  let dag: Dag;
  try {
    dag = fromJson(DagSchema, payload as JsonValue);
  } catch (error) {
    throw new ApiError(400, error instanceof Error ? error.message : "This isn't a DAG the console accepts.");
  }
  const submitted = await call(() => executions.submitExecution({ dag }));
  return { executionId: submitted.executionId, state: ExecutionState[submitted.state] };
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

/** One task as submitted (images pinned) -- this is *input*, kept for
 * reference alongside TaskStatus's live *outcome*; the two are joined
 * client-side by `id`/`taskId`. timeoutSeconds, maxAttempts and
 * serviceAccount are absent when the submission left them to their
 * defaults. */
export interface SubmittedTaskPayload {
  id: string;
  image: string;
  action: string;
  dependsOn?: string[];
  inputs?: Record<string, unknown>;
  timeoutSeconds?: number;
  maxAttempts?: number;
  team: string;
  serviceAccount?: string;
  secretRefs?: string[];
}

/** As stored at submission (the console reads older rows' names,
 * externalReference and idempotencyKey, as these). */
export interface SubmittedExecutionPayload {
  name: string;
  /** Empty when the submission had none. */
  requestId: string;
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

export async function getExecution(executionId: string): Promise<ExecutionDetail> {
  const { execution } = await call(() => executions.getExecution({ executionId }));
  if (!execution) throw new ApiError(404, "Execution not found.");
  return executionDetail(execution);
}

/**
 * The execution each time it changes (and every 15s regardless), until it
 * finishes; then the iteration ends. It also ends, unfinished, when the
 * server's time limit for one stream is reached, or throws if the
 * connection drops: either way, watch again. Stops when `signal` aborts.
 */
export async function* watchExecution(executionId: string, signal: AbortSignal): AsyncGenerator<ExecutionDetail> {
  try {
    for await (const { execution } of executions.watchExecution({ executionId }, { signal })) {
      if (execution) yield executionDetail(execution);
    }
  } catch (error) {
    throw apiError(error);
  }
}

function executionDetail(execution: Execution): ExecutionDetail {
  const dag = execution.dag;
  return {
    executionId: execution.executionId,
    name: execution.name,
    state: ExecutionState[execution.state],
    tasks: execution.tasks.map((task) => ({
      taskId: task.taskId,
      state: TaskState[task.state],
      attemptCount: task.attemptCount,
      outputs: task.outputs ?? null,
      failure: task.failure
        ? { code: task.failure.code, message: task.failure.message, retryable: task.failure.retryable }
        : null,
      dependsOn: task.dependsOn,
      startedAt: iso(task.startedAt),
      completedAt: iso(task.completedAt),
    })),
    teams: execution.teams,
    submittedBy: execution.submittedBy || null,
    createdAt: iso(execution.createdAt) ?? "",
    payload: dag
      ? {
          name: dag.name,
          requestId: dag.requestId,
          tasks: dag.tasks.map((task) => ({
            id: task.id,
            image: task.image,
            action: task.action,
            dependsOn: task.dependsOn,
            inputs: task.inputs ?? {},
            timeoutSeconds: task.timeoutSeconds,
            maxAttempts: task.maxAttempts,
            team: task.team,
            serviceAccount: task.serviceAccount,
            secretRefs: task.secretRefs,
          })),
        }
      : null,
    runBlocked: execution.runBlocked
      ? {
          error: execution.runBlocked.code as NonNullable<ExecutionDetail["runBlocked"]>["error"],
          message: execution.runBlocked.message,
          missingImages: execution.runBlocked.missingImages,
          disallowedImages: execution.runBlocked.disallowedImages,
        }
      : null,
  };
}

export async function cancelExecution(executionId: string): Promise<{ executionId: string; state: string }> {
  const result = await call(() => executions.cancelExecution({ executionId }));
  return { executionId: result.executionId, state: ExecutionState[result.state] };
}

export async function retryTask(executionId: string, taskId: string): Promise<{ executionId: string; state: string }> {
  const result = await call(() => executions.retryTask({ executionId, taskId }));
  return { executionId: result.executionId, state: ExecutionState[result.state] };
}

/** Resubmits the execution's original task graph as a brand-new execution
 * (a new executionId, not a reset of this one -- see
 * ../../src/routes/executions.ts's own comment on why). Fails with a 422
 * if this execution predates rerun support and has no stored submission to
 * replay. */
export async function rerunExecution(executionId: string): Promise<{ executionId: string; state: string }> {
  const result = await call(() => executions.rerunExecution({ executionId }));
  return { executionId: result.executionId, state: ExecutionState[result.state] };
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
export async function getExecutionEvents(
  executionId: string,
  after?: number,
): Promise<{ events: ExecutionEvent[]; nextCursor: number | null }> {
  const page = await call(() => executions.listExecutionEvents({ executionId, after: BigInt(after ?? 0) }));
  return {
    events: page.events.map((event) => ({
      id: Number(event.id),
      eventType: event.eventType,
      taskId: event.taskId ?? null,
      payload: event.payload ?? {},
      createdAt: iso(event.createdAt) ?? "",
    })),
    nextCursor: page.nextCursor === 0n ? null : Number(page.nextCursor),
  };
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
export async function getExecutionLogs(executionId: string): Promise<{ tasks: TaskLogs[] }> {
  const { tasks } = await call(() => executions.getExecutionLogs({ executionId }));
  return { tasks: tasks.map((t) => ({ taskId: t.taskId, lines: t.lines })) };
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

export async function getStats(): Promise<PlatformStats> {
  const stats = await call(() => admin.getStats({}));
  return {
    teams: Number(stats.teams),
    users: Number(stats.users),
    products: Number(stats.products),
    executions: Number(stats.executions),
  };
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

const POD_STATE: Record<TaskPodState, TaskPod["state"]> = {
  [TaskPodState.UNSPECIFIED]: "starting",
  [TaskPodState.STARTING]: "starting",
  [TaskPodState.RUNNING]: "running",
  [TaskPodState.CANT_START]: "cant-start",
  [TaskPodState.FINISHED]: "finished",
  [TaskPodState.FAILED]: "failed",
};

export async function listTeamPods(teamName: string): Promise<TaskPod[]> {
  const { pods } = await call(() => teams.listPods({ team: teamName }));
  return pods.map((pod) => ({
    podName: pod.podName,
    executionId: pod.executionId ?? null,
    taskKey: pod.taskId ?? null,
    attempt: pod.attempt ?? null,
    image: pod.image ?? null,
    serviceAccount: pod.serviceAccount ?? null,
    state: POD_STATE[pod.state],
    problem: pod.problem ? { title: pod.problem.title, detail: pod.problem.detail } : null,
    restarts: pod.restarts,
    startedAt: iso(pod.startedAt),
    finishedAt: iso(pod.finishedAt),
    execution: pod.execution
      ? {
          name: pod.execution.name,
          taskNumber: pod.execution.taskNumber ?? null,
          taskCount: pod.execution.taskCount ?? null,
        }
      : null,
  }));
}

/** The in-app Docs page -- see ../../src/routes/docs.ts. Any
 * authenticated user, no team scoping. */
export interface DocSummary {
  id: string;
  title: string;
}

export async function listDocs(): Promise<DocSummary[]> {
  return (await call(() => guides.listGuides({}))).guides.map((g) => ({ id: g.id, title: g.title }));
}

/** A guide's markdown. */
export async function getDoc(id: string): Promise<string> {
  return (await call(() => guides.getGuide({ id }))).markdown;
}

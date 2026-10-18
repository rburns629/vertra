// SPDX-License-Identifier: MIT
/**
 * The console API's OpenAPI description, generated from the routes
 * themselves (@fastify/swagger) and served at GET /api/openapi.json for the
 * Docs page's API reference.
 *
 * Each route's own schema already says what it accepts. What a route
 * definition doesn't say -- who may call it, a one-line summary, what it
 * returns -- lives in ROUTE_DOCS below, one entry per route, merged into
 * the route as it's registered. An /api route without an entry is recorded
 * in `undocumentedRoutes`, and test/openapi.test.ts fails on it, so a new
 * route can't ship undocumented.
 *
 * Response schemas here are documentation only: registerOpenApi() makes
 * every response plain JSON.stringify, as it was before they existed, so a
 * field missing from a schema can never silently vanish from a response
 * (Fastify's default response serializer drops properties a schema
 * doesn't list).
 */
import swagger from "@fastify/swagger";
import { Type, type TSchema } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";

const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const DateTime = Type.String({ format: "date-time" });

const ErrorBody = Type.Object(
  {
    error: Type.String({ description: "A stable code, e.g. FORBIDDEN, NOT_FOUND, TEAM_RETIRED." }),
    message: Type.String({ description: "What went wrong, for a person to read." }),
  },
  { description: "Every error response has this shape." },
);

const Team = Type.Object({
  id: Type.String({ format: "uuid" }),
  name: Type.String({ description: "Also the team's Kubernetes namespace." }),
  createdAt: DateTime,
  retiredAt: Nullable(DateTime),
  deletedAt: Nullable(DateTime),
});

const Member = Type.Object({
  id: Type.String({ format: "uuid" }),
  email: Type.String(),
  isBot: Type.Boolean(),
  isAdmin: Type.Boolean({ description: "An Acyclix admin, not just this team's member." }),
  addedAt: DateTime,
});

const TokenMeta = Type.Object({
  id: Type.String({ format: "uuid" }),
  label: Type.String(),
  createdAt: DateTime,
  lastUsedAt: Nullable(DateTime),
});

const Bot = Type.Object({ id: Type.String({ format: "uuid" }), email: Type.String(), tokens: Type.Array(TokenMeta) });

const Submitted = Type.Object(
  {
    executionId: Type.String({ format: "uuid" }),
    state: Type.String({ description: "PENDING right after a submission." }),
  },
  { description: "The run that was started (or, for a repeated requestId, the run it already started)." },
);

const ExecutionSummary = Type.Object({
  executionId: Type.String({ format: "uuid" }),
  name: Type.String(),
  teams: Type.Array(Type.String()),
  submittedBy: Nullable(Type.String({ format: "uuid" })),
  createdAt: DateTime,
  state: Nullable(Type.String({ description: "Null if kernel-api couldn't be asked." })),
});

const TaskStatus = Type.Object({
  taskId: Type.String({ description: "The task's id from the DAG." }),
  state: Type.String({ description: "PENDING, BLOCKED, READY, RUNNING, SUCCEEDED, FAILED, CANCELLED." }),
  attemptCount: Type.Integer(),
  outputs: Nullable(Type.Record(Type.String(), Type.Unknown())),
  failure: Nullable(
    Type.Object({ code: Type.String(), message: Type.String(), retryable: Type.Boolean() }),
  ),
  dependsOn: Type.Array(Type.String()),
  startedAt: Nullable(DateTime),
  completedAt: Nullable(DateTime),
});

const ExecutionDetail = Type.Object({
  executionId: Type.String({ format: "uuid" }),
  name: Type.String(),
  state: Type.String(),
  tasks: Type.Array(TaskStatus),
  teams: Type.Array(Type.String()),
  submittedBy: Nullable(Type.String({ description: "The submitter's email." })),
  createdAt: DateTime,
  payload: Type.Unknown({ description: "The DAG as submitted." }),
});

const Dag = Type.Object(
  {
    // Optional here only because the old name (externalReference) is still
    // accepted in its place; one of the two is required.
    name: Type.Optional(Type.String({ description: "Required. A label for this run; it can repeat." })),
    requestId: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Optional. Send the same one again (e.g. after a timeout) to get back the run it started instead of starting another. Without it, every submission is a new run.",
      }),
    ),
    tasks: Type.Array(
      Type.Object(
        {
          id: Type.Optional(Type.String({ description: "Required. Unique within the DAG." })),
          image: Type.Optional(Type.String({ description: "Required. A product image, as listed by GET /api/products." })),
          action: Type.Optional(Type.String({ description: "Required." })),
          team: Type.Optional(Type.String({ description: "Required. Your team (platform); the task runs in its namespace." })),
          serviceAccount: Type.Optional(
            Type.String({ description: "Optional. Left out, the task runs as its product's ServiceAccount, or \"default\" for an image that isn't a registered product." }),
          ),
          dependsOn: Type.Optional(Type.Array(Type.String())),
          secretRefs: Type.Optional(Type.Array(Type.String(), { description: "Secrets of the task's team to mount at /platform/secrets/<name>/. Only a registered product may mount any." })),
          inputs: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), {
              description: 'An input of {"$fromTask": "<id>", "$output": "<name>"} takes another task\'s output.',
            }),
          ),
          timeoutSeconds: Type.Optional(Type.Integer()),
          maxAttempts: Type.Optional(Type.Integer()),
        },
        { additionalProperties: true },
      ),
      { description: "Required, with at least one task." },
    ),
  },
  {
    // Documentation, never a stricter check than the route's own: the
    // console checks a DAG's contents itself and kernel-api checks it again,
    // so every field is optional here, with "Required" in its description.
    additionalProperties: true,
    description: "A DAG. The old names externalReference and idempotencyKey are still accepted.",
  },
);

const SecretStore = Type.Object({
  name: Type.String(),
  provider: Type.String({ description: "ESO's provider id: gcpsm, azurekv, aws, onepasswordSDK, ..." }),
  providerLabel: Type.String(),
  location: Nullable(Type.String()),
  identity: Nullable(Type.String()),
  usesStoredCredential: Type.Boolean(),
  ready: Nullable(Type.Boolean()),
  message: Nullable(Type.String()),
  sharedWithCount: Type.Integer(),
  sharedWith: Nullable(Type.Array(Type.String())),
});

const TeamSecret = Type.Object({
  id: Type.String(),
  secretName: Type.String(),
  keys: Type.Array(Type.String()),
  source: Type.Union([Type.Literal("literal"), Type.Literal("external")]),
  managed: Type.Boolean({ description: "False for a sync created outside the console." }),
  updatedAt: Nullable(DateTime),
  external: Nullable(Type.Record(Type.String(), Type.Unknown())),
});

const Product = Type.Object({
  id: Type.String({ format: "uuid" }),
  name: Type.String({ description: "<team>-<product>-<action>, as catalog CI registers it." }),
  image: Type.String(),
  action: Type.String(),
  teamId: Nullable(Type.String({ format: "uuid" })),
  teamName: Nullable(Type.String()),
  inputSchema: Type.Record(Type.String(), Type.Unknown(), { description: "JSON Schema of the action's inputs; see the catalog's docs/product-schema.md." }),
  displayName: Nullable(Type.String()),
  description: Nullable(Type.String()),
  outputSchema: Type.Record(Type.String(), Type.Unknown(), { description: "JSON Schema of what the action outputs." }),
  serviceAccount: Nullable(Type.String({ description: "The ServiceAccount its tasks run as, in the owning team's namespace." })),
  requiredSecrets: Type.Array(Type.String(), { description: "Secrets it reads: what a task's secretRefs needs." }),
  createdAt: DateTime,
  releases: Type.Array(Type.Object({ image: Type.String(), registeredAt: DateTime })),
});

const WiringType = Type.Object({
  name: Type.String({ description: "Such as gcp.project." }),
  jsonType: Type.String({ description: "string, integer, number or boolean." }),
  description: Type.String(),
  shared: Type.Boolean({ description: "Asked once per order when no task in it provides the type." }),
  defaultProvider: Nullable(Type.String({ description: "<team>/<product>.<action> added to an order that needs the type and has no provider." })),
  updatedAt: DateTime,
});

const NoContent = Type.Null({ description: "No content." });
const Anything = Type.Unknown();

const ANYONE = "Anyone, signed in or not.";
const SIGNED_IN = "Anyone signed in (a person, or a bot's API token).";
const MEMBER = "A member of the team, or an Acyclix admin. A team's bot counts as a member.";
const ADMIN = "Acyclix admins only.";
const EXECUTION_READER = "A member of a team the execution's tasks run in, or an Acyclix admin.";

interface RouteDoc {
  tag: string;
  summary: string;
  access: string;
  description?: string;
  responses?: Record<number, TSchema>;
  /** Documents a body the route checks by hand. Accepts anything that
   * check accepts (see Dag): never stricter than the route itself. */
  body?: TSchema;
}

const errors = (...codes: number[]) => Object.fromEntries(codes.map((code) => [code, ErrorBody]));

/** Keyed by "METHOD /api/path", exactly as Fastify registers the route. */
export const ROUTE_DOCS: Record<string, RouteDoc> = {
  "GET /api/environment": { tag: "Platform", summary: "Which deployment this is", access: ANYONE, responses: { 200: Type.Object({ label: Type.String(), selfRegistration: Type.Boolean() }) } },
  "GET /api/platform": { tag: "Platform", summary: "Facts the Connect-a-source wizard needs", access: SIGNED_IN, responses: { 200: Anything } },
  "GET /api/openapi.json": { tag: "Platform", summary: "This API description (OpenAPI 3)", access: SIGNED_IN, responses: { 200: Anything } },
  "GET /api/stats": { tag: "Platform", summary: "Counts for the admin home page", access: ADMIN, responses: { 200: Anything, ...errors(403) } },
  "GET /api/docs": { tag: "Platform", summary: "List the in-console guides", access: SIGNED_IN, responses: { 200: Type.Array(Type.Object({ id: Type.String(), title: Type.String() })) } },
  "GET /api/docs/:id": { tag: "Platform", summary: "One guide, as markdown", access: SIGNED_IN, responses: { 200: Type.String(), ...errors(404) } },

  "POST /api/auth/login": {
    tag: "Accounts",
    summary: "Sign in; returns a session token",
    access: ANYONE,
    description: "Rate limited per client IP and email, and spaced out after repeated failures on one account (429 with Retry-After). Bots don't sign in: they use their API token directly.",
    responses: { 200: Type.Object({ token: Type.String({ description: "Send as Authorization: Bearer <token>." }) }), ...errors(401, 429) },
  },
  "POST /api/auth/register": { tag: "Accounts", summary: "Create your own account (when open registration is on)", access: ANYONE, description: "Off by default: admins create accounts with POST /api/users.", responses: { 201: Type.Object({ id: Type.String(), email: Type.String() }), ...errors(403, 409) } },
  "GET /api/me": { tag: "Accounts", summary: "Who you are, and your teams", access: SIGNED_IN, responses: { 200: Type.Object({ id: Type.String(), email: Type.String(), teamNames: Type.Array(Type.String()), isAdmin: Type.Boolean() }) } },
  "POST /api/me/password": { tag: "Accounts", summary: "Change your password", access: "Anyone signed in with a password (not bots).", description: "Signs out your other sessions; returns a fresh token for this one.", responses: { 200: Type.Object({ token: Type.String() }), ...errors(400, 401) } },
  "GET /api/users": { tag: "Accounts", summary: "List accounts", access: ADMIN, responses: { 200: Anything, ...errors(403) } },
  "POST /api/users": { tag: "Accounts", summary: "Create an account, with its teams", access: ADMIN, description: "Returns a temporary password, shown once.", responses: { 201: Type.Object({ email: Type.String(), temporaryPassword: Type.String(), teams: Type.Array(Type.String()), admin: Type.Boolean() }), ...errors(403, 409) } },
  "DELETE /api/users/:email": { tag: "Accounts", summary: "Delete an account", access: ADMIN, description: "Its executions stay in the history.", responses: { 204: NoContent, ...errors(403, 404) } },
  "POST /api/users/:email/admin": { tag: "Accounts", summary: "Make someone an Acyclix admin", access: ADMIN, responses: { 204: NoContent, ...errors(403, 404) } },
  "DELETE /api/users/:email/admin": { tag: "Accounts", summary: "Remove someone's admin rights", access: ADMIN, responses: { 204: NoContent, ...errors(403, 404) } },
  "POST /api/users/:email/password": { tag: "Accounts", summary: "Reset someone's password", access: ADMIN, responses: { 204: NoContent, ...errors(403, 404) } },

  "GET /api/teams": { tag: "Teams", summary: "List every team", access: ADMIN, responses: { 200: Type.Array(Team), ...errors(403) } },
  "POST /api/teams": { tag: "Teams", summary: "Create a team", access: "Acyclix admins, or an automation token with teams:create (the catalog's CI).", description: "Also creates its namespace, labelled acyclix/team=true, when the console manages team namespaces. The creator isn't made a member; an admin adds the first member.", responses: { 201: Team, ...errors(400, 403, 409, 422) } },
  "PUT /api/teams/:teamName": { tag: "Teams", summary: "Make sure a team exists and is active, with its namespace", access: "Acyclix admins, or an automation token with teams:create (and teams:retire to un-retire one).", description: "What the catalog's CI calls for every team folder, any number of times: creates the team (201), un-retires it, and puts its namespace label back. A purged team's name is refused (409 NAME_RESERVED).", responses: { 200: Team, 201: Team, ...errors(400, 403, 409, 422) } },
  "PUT /api/teams/:teamName/secret-store": { tag: "Teams", summary: "Apply a team's reviewed SecretStore file", access: "Acyclix admins, or an automation token with secret-stores:apply (the catalog's CI).", description: "Body: the file's objects as JSON (`documents`) and, for a provider that needs one, `credential` (written to the Secret eso-auth). Only SecretStores in the team's namespace, credentials only from eso-auth, and ESO's own ServiceAccounts; anything else is refused with every problem listed (422).", responses: { 204: NoContent, ...errors(403, 404, 409, 422) } },
  "GET /api/teams/:teamName": { tag: "Teams", summary: "A team's record and lifecycle", access: "Its members, Acyclix admins, or an automation token with teams:create.", description: "Anyone else gets 404, as for a team that doesn't exist. A purged team is still returned, with deletedAt: its name stays reserved.", responses: { 200: Team, ...errors(404) } },
  "DELETE /api/teams/:teamName": { tag: "Teams", summary: "Purge a retired team (irreversible)", access: "Acyclix admins, or an automation token with teams:delete.", description: "Refused while any of its executions is unfinished, or if kernel-api can't say. Then deletes its namespace when the console may purge team namespaces (teamNamespaces.purge, off by default: the namespace stays, labelled retired, for an operator to delete; `namespaceDeleted` says which). Calling it again for a purged team retries the deletion.", responses: { 204: NoContent, ...errors(403, 404, 409) } },
  "POST /api/teams/:teamName/retire": { tag: "Teams", summary: "Retire a team: read-only, products unlisted", access: "Acyclix admins, or an automation token with teams:retire.", responses: { 204: NoContent, ...errors(403, 404) } },
  "POST /api/teams/:teamName/unretire": { tag: "Teams", summary: "Undo a retirement", access: "Acyclix admins, or an automation token with teams:retire.", responses: { 204: NoContent, ...errors(403, 404) } },
  "GET /api/teams/:teamName/members": { tag: "Teams", summary: "List a team's members, bots included", access: MEMBER, responses: { 200: Type.Array(Member), ...errors(403, 404) } },
  "POST /api/teams/:teamName/members": { tag: "Teams", summary: "Add someone to a team", access: MEMBER, description: "They need an account first. Refused for a retired team (409 TEAM_RETIRED). At most 30 an hour per caller (429).", responses: { 204: NoContent, ...errors(403, 404, 409, 429) } },
  "DELETE /api/teams/:teamName/members/:userId": { tag: "Teams", summary: "Remove someone from a team", access: MEMBER, description: "Never the team's last person (409 LAST_MEMBER).", responses: { 204: NoContent, ...errors(403, 404, 409) } },
  "GET /api/teams/:teamName/pods": { tag: "Teams", summary: "What's running in the team's namespace", access: MEMBER, responses: { 200: Type.Array(Anything), ...errors(403) } },

  "GET /api/teams/:teamName/bots": { tag: "Bots and tokens", summary: "List a team's bots and their tokens", access: MEMBER, responses: { 200: Type.Array(Bot), ...errors(403, 404) } },
  "POST /api/teams/:teamName/bots": { tag: "Bots and tokens", summary: "Create a bot (or a new token for an existing one)", access: MEMBER, description: "The token is returned once and never shown again. A bot acts as a member of the team.", responses: { 201: Type.Object({ email: Type.String(), token: Type.String(), tokenId: Type.String() }), ...errors(403, 404, 409) } },
  "DELETE /api/tokens/:tokenId": { tag: "Bots and tokens", summary: "Revoke a token", access: "A member of a team the token's bot belongs to, or an Acyclix admin.", responses: { 204: NoContent, ...errors(403, 404) } },
  "GET /api/automation-tokens": { tag: "Bots and tokens", summary: "List automation tokens (platform-wide scopes)", access: ADMIN, responses: { 200: Type.Array(Anything), ...errors(403) } },
  "POST /api/automation-tokens": { tag: "Bots and tokens", summary: "Create an automation token", access: ADMIN, description: "For platform automation such as the catalog's CI; it belongs to no team.", responses: { 201: Anything, ...errors(403) } },

  "GET /api/executions": { tag: "Executions", summary: "List executions you can see, newest first", access: "Anyone signed in: executions of your teams (all of them, for an admin).", description: "A page at a time (limit, default 100, at most 1000); pass nextCursor back as cursor for the next. team, search (part of the name) and since (date-time) narrow it.", responses: { 200: Type.Object({ executions: Type.Array(ExecutionSummary), nextCursor: Type.Union([Type.String(), Type.Null()]) }), ...errors(400) } },
  "POST /api/executions": {
    tag: "Executions",
    summary: "Submit a DAG",
    access: "Anyone signed in, for tasks in their own teams.",
    description: "Before anything runs, each task is checked: its team is yours, it runs as its product's ServiceAccount (or \"default\", with no secrets, when it isn't a registered product), every secret in secretRefs is registered for its team, and its image comes from an allowed source. Each image is then pinned to its digest (IMAGE_NOT_RESOLVED if the registry can't say) and must have passed its security scan (IMAGE_SCAN_FAILED, or 409 IMAGE_SCAN_PENDING while a first scan runs).",
    body: Dag,
    responses: { 201: Submitted, ...errors(400, 403, 422) },
  },
  "GET /api/executions/:id": { tag: "Executions", summary: "An execution and its tasks, live", access: EXECUTION_READER, responses: { 200: ExecutionDetail, ...errors(403, 404) } },
  "GET /api/executions/:id/events": { tag: "Executions", summary: "The execution's event log", access: EXECUTION_READER, description: "Page through with ?after=<nextCursor>.", responses: { 200: Type.Object({ events: Type.Array(Type.Object({ id: Type.Integer(), eventType: Type.String(), taskId: Nullable(Type.String()), payload: Type.Record(Type.String(), Type.Unknown()), createdAt: DateTime })), nextCursor: Nullable(Type.Integer()) }), ...errors(403, 404) } },
  "GET /api/executions/:id/logs": { tag: "Executions", summary: "Each task's output", access: EXECUTION_READER, responses: { 200: Type.Object({ tasks: Type.Array(Type.Object({ taskId: Type.String(), lines: Type.Array(Type.String()) })) }), ...errors(403, 404) } },
  "POST /api/executions/:id/cancel": { tag: "Executions", summary: "Cancel an execution", access: EXECUTION_READER, responses: { 200: Submitted, ...errors(403, 404, 409) } },
  "POST /api/executions/:id/tasks/:taskId/retry": { tag: "Executions", summary: "Retry a failed task", access: EXECUTION_READER, responses: { 200: Submitted, ...errors(403, 404, 409) } },
  "POST /api/executions/:id/rerun": { tag: "Executions", summary: "Run the same DAG again, as a new execution", access: EXECUTION_READER, responses: { 201: Submitted, ...errors(403, 404, 409, 422) } },

  "GET /api/wiring-types": { tag: "Products", summary: "The catalog's wiring types", access: SIGNED_IN, description: "What a product's inputs can need and its outputs provide (x-acyclix-needs / x-acyclix-provides), from the catalog's schema/types.yaml.", responses: { 200: Type.Array(WiringType) } },
  "PUT /api/wiring-types": { tag: "Products", summary: "Replace the wiring types", access: "A platform admin, or an automation token with products:register (catalog CI).", description: "The body is the catalog's schema/types.yaml as JSON, one entry per type name; it replaces every stored type.", responses: { 200: Type.Array(WiringType), ...errors(400, 403) } },
  "GET /api/products": { tag: "Products", summary: "List products you can run", access: SIGNED_IN, responses: { 200: Type.Array(Product) } },
  "POST /api/products": { tag: "Products", summary: "Register or update a product", access: "A member of the product's team, an Acyclix admin, or an automation token with products:register (the catalog's CI).", description: "A product with no team is a platform product: admins only. Refused (409) when another team owns the product's name or its image repository: the first team to register a repository owns it, even after its products are deleted.", responses: { 200: Product, ...errors(403, 409) } },
  "DELETE /api/products/:name": { tag: "Products", summary: "Unregister a product", access: "A member of the product's team, an Acyclix admin, or an automation token with products:register.", responses: { 204: NoContent, ...errors(403, 404) } },
  "GET /api/image-repositories": { tag: "Products", summary: "Which team owns each image repository", access: ADMIN, responses: { 200: Anything, ...errors(403) } },
  "DELETE /api/image-repositories": { tag: "Products", summary: "Release an image repository", access: ADMIN, description: "Takes ?repository=; lets any team register it next. Refused (409) while a registered product uses it.", responses: { 204: NoContent, ...errors(403, 404, 409) } },
  "GET /api/audit": { tag: "Platform", summary: "Who changed what", access: ADMIN, description: "Every request that tried to change something, allowed or refused, newest first: the caller, the route, what it named (never a secret value, password or token) and the status. Page with ?before=<last id>; filter with ?actor=<user id>.", responses: { 200: Anything, ...errors(403) } },
  "GET /api/policy-sync": { tag: "Platform", summary: "Whether the cluster's policies are current", access: ADMIN, description: "The last outcome of rewriting the identity and scan policies from the console's database (every few minutes, and on every change).", responses: { 200: Anything, ...errors(403) } },
  "POST /api/policy-sync": { tag: "Platform", summary: "Rewrite the cluster's policies now", access: ADMIN, responses: { 200: Anything, ...errors(403) } },
  "GET /api/image-scans": { tag: "Products", summary: "Image scan verdicts", access: ADMIN, description: "One per digest: passed, failed (a HIGH or CRITICAL vulnerability with a fix, or a secret in the image), pending or error, with findings. A failed one blocks registering and running that image.", responses: { 200: Anything, ...errors(403) } },
  "POST /api/image-scans/:digest/accept": { tag: "Products", summary: "Accept a failed scan, with a reason", access: ADMIN, description: "The image may be registered and run again. A rescan that finds something new clears it.", responses: { 200: Anything, ...errors(400, 403, 404) } },
  "POST /api/image-scans/:digest/rescan": { tag: "Products", summary: "Scan an image again now", access: ADMIN, responses: { 202: Anything, ...errors(403, 404) } },
  "GET /api/image-policy": { tag: "Products", summary: "Where task images may come from", access: SIGNED_IN, responses: { 200: Anything } },
  "PUT /api/image-policy": { tag: "Products", summary: "Change where task images may come from", access: ADMIN, description: "Send back the version you read; a stale one is refused (409).", responses: { 200: Anything, ...errors(400, 403, 409) } },

  "GET /api/teams/:teamName/secrets": { tag: "Secrets", summary: "List a team's secrets (names only, never values)", access: MEMBER, responses: { 200: Type.Array(TeamSecret), ...errors(403, 404) } },
  "GET /api/teams/:teamName/secret-stores": { tag: "Secrets", summary: "Where a team's secrets come from", access: MEMBER, responses: { 200: Type.Array(SecretStore), ...errors(403) } },
  "POST /api/secrets": { tag: "Secrets", summary: "Add or replace a pasted secret", access: MEMBER, description: "The team's: any of its registered products may mount it, when a task lists it in secretRefs.", responses: { 204: NoContent, ...errors(403, 409, 422) } },
  "DELETE /api/teams/:teamName/secrets/:secretName": { tag: "Secrets", summary: "Revoke a secret", access: MEMBER, description: "Removes the registration and the Secret the console created. Tasks already running keep what they mounted.", responses: { 204: NoContent, ...errors(403, 404, 409) } },
  "POST /api/secrets/external": { tag: "Secrets", summary: "Sync a secret from a connected source", access: MEMBER, description: "Only the reference is sent; the value goes straight from your vault to your namespace.", responses: { 204: NoContent, ...errors(403, 409, 422) } },
};

/** /api routes registered without a ROUTE_DOCS entry (test/openapi.test.ts). */
export const undocumentedRoutes: string[] = [];

export async function registerOpenApi(app: FastifyInstance): Promise<void> {
  // Plain JSON for every response, as before response schemas existed: they
  // describe responses, never filter them (see the comment at the top).
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));

  app.addHook("onRoute", (route) => {
    if (!route.url.startsWith("/api")) return;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === "HEAD") {
        route.schema = { ...route.schema, hide: true };
        continue;
      }
      const key = `${method} ${route.url}`;
      const doc = ROUTE_DOCS[key];
      if (!doc) {
        undocumentedRoutes.push(key);
        continue;
      }
      route.schema = {
        ...route.schema,
        tags: [doc.tag],
        summary: doc.summary,
        description: `**Who can call it:** ${doc.access}${doc.description ? `\n\n${doc.description}` : ""}`,
        security: doc.access === ANYONE ? [] : [{ bearer: [] }],
        ...(doc.body && !route.schema?.body ? { body: doc.body } : {}),
        ...(doc.responses ? { response: doc.responses } : {}),
      };
    }
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "Acyclix console API",
        version: "1",
        description:
          "Everything the console does, over HTTP. Send `Authorization: Bearer <token>`: a session token from POST /api/auth/login, or a bot's API token (Team page, Automation).",
      },
      components: {
        securitySchemes: {
          bearer: { type: "http", scheme: "bearer", description: "A session token, or a bot's API token." },
        },
      },
      tags: [
        { name: "Executions", description: "Submit DAGs and follow them." },
        { name: "Products", description: "What can run, and where images may come from." },
        { name: "Secrets", description: "Secrets for a team's products." },
        { name: "Teams", description: "Teams (platforms) and their members." },
        { name: "Bots and tokens", description: "Identities for pipelines and automation." },
        { name: "Accounts", description: "Signing in, and accounts." },
        { name: "Platform", description: "About this deployment." },
      ],
    },
    hideUntagged: true,
  });
}

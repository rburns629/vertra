// SPDX-License-Identifier: MIT
/**
 * teams/users/teamMemberships — the portable, cloud-agnostic authorization
 * source of truth, here rather than derived from git/CODEOWNERS so a
 * membership change takes effect on the next request. SSO/SAML, when it's wired up, is purely an authentication
 * layer on top of these same tables (just-in-time provisioning writes
 * into teamMemberships, same as manual registration would) — nothing
 * about this schema changes when that's added.
 *
 * team.name doubles as the Kubernetes namespace name by convention (see
 * console/src/k8s.ts) — deliberately not a separate column, so there's exactly
 * one place "which team owns which namespace" is decided, not two that
 * could drift apart.
 */
import {
  pgTable,
  uuid,
  text,
  timestamp,
  primaryKey,
  boolean,
  jsonb,
  unique,
  index,
  bigserial,
  integer,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** A task Pod's size, as the kernel's TaskResources takes it. */
export interface ProductResources {
  cpu?: string;
  memory?: string;
  memoryLimit?: string;
}

export const teams = pgTable("teams", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Retired: the platform is being wound down (its catalog folder was
  // removed). The team becomes read-only -- no new submissions, secrets,
  // bots, or product registrations -- and its products are unregistered.
  // Reversible: clearing this brings it back.
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  // Purged: memberships, secret grants and products are gone, and the team
  // is invisible everywhere. The row itself is kept on purpose, so the name
  // stays reserved: execution history is keyed by team *name*, and a new
  // team reusing it would otherwise inherit visibility of the old one's
  // executions. Only set on a team that was retired first.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  // Made by a catalog release (catalogSync.ts): retired when a release no
  // longer names it. A team an admin made isn't touched by releases, unless
  // one names it, which makes it the catalog's.
  fromCatalog: boolean("from_catalog").notNull().default(false),
  // team.yaml's allowedTargets, from the catalog's release: where other
  // teams may aim this team's products (targets.ts). Empty: nowhere.
  allowedTargets: jsonb("allowed_targets").$type<TargetRule[]>().notNull().default([]),
});

/** One rule of a team's allowedTargets: the teams it covers ("*" for every
 * team), and per kind of target (gcp.project, ...) the values or patterns
 * they may supply. */
export interface TargetRule {
  teams: string[];
  targets: Record<string, string[]>;
}

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  // Nullable on purpose: a user provisioned entirely via SSO in the
  // future may never have a local password at all.
  passwordHash: text("password_hash"),
  // A platform-wide role, separate from team membership: team membership
  // governs one team's own Secrets/RBAC (see docs/multi-tenant-secrets-
  // design.md); isAdmin governs cross-team and platform-level actions --
  // adding a member to a team you're not in, registering a secret for a
  // team you're not in, and (once built) configuring SSO/SAML/OIDC, which
  // has no single owning team to scope it to. Deliberately a boolean, not
  // a roles table: the actual distinction needed today is exactly two-
  // valued (platform admin or not) -- a richer permissions model is real
  // future work if a real second distinction ever shows up, not something
  // to build ahead of that need.
  isAdmin: boolean("is_admin").notNull().default(false),
  // A machine identity (catalog CI, e.g.) rather than a human -- never
  // logs in via /auth/login (hence passwordHash staying null for these),
  // authenticates only via apiTokens below. Kept as an explicit flag
  // rather than inferred from "has no password" so listing "this team's
  // bots" is a direct query, not a guess.
  isBot: boolean("is_bot").notNull().default(false),
  // Set on every password change or admin reset. Any session JWT issued
  // before this instant is rejected (auth/plugin.ts), so changing a
  // password actually kicks out whoever else might be holding an old
  // session, instead of only affecting future logins. Null means never
  // changed since the account was created.
  passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Long-lived, revocable credentials for bot users (see users.isBot) --
 * catalog CI's way of authenticating to register/deregister products
 * without a human doing an interactive login. Authorization once
 * authenticated is identical to a human's: the token resolves to a user
 * id, and every existing check (team membership, isAdmin) runs the same
 * as it would for a JWT-authenticated request (see auth/plugin.ts).
 */
export const apiTokens = pgTable("api_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // Only the hash is stored -- the raw token is shown exactly once, at
  // creation, and never persisted or logged again (same principle as
  // users.passwordHash). A fast hash (SHA-256, see auth/apiToken.ts) is
  // correct here, unlike argon2 for passwords: the cost argon2 adds
  // exists to slow down guessing a low-entropy human password, and a
  // 256-bit random token has no such guessing surface for that cost to
  // defend against.
  tokenHash: text("token_hash").notNull().unique(),
  label: text("label").notNull(),
  // Platform-wide permissions for an *automation* token (auth/scopes.ts),
  // e.g. the catalog CI's one token: "teams:create", "products:register".
  // Empty for an ordinary team bot, whose access comes from team
  // membership like any human's. An automation token's bot belongs to no
  // team, so these scopes are the only things it can do.
  scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  // When the token last authenticated a request, at most a few minutes
  // stale (auth/plugin.ts only writes it when it has moved on), so the Team
  // page can show which tokens are still in use before someone revokes one.
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
});

/**
 * The product registry: what a DAG step can actually reference. One row
 * per (image, action) pair, matching what TaskDefinition itself needs --
 * a step always resolves to exactly one of these, not "a product"
 * abstractly. teamId null means a platform-provided product that no
 * single team vouches for; non-null means
 * a real team's product, and only a member of that team (or an admin) may
 * register, update, or delete it -- the same membership check /secrets
 * already applies to writing a secret, applied one layer earlier: which
 * image a team is willing to have run as their ServiceAccount, not just
 * who can read their secret once it's running.
 */
export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull().unique(),
    image: text("image").notNull(),
    action: text("action").notNull(),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
    inputSchema: jsonb("input_schema").notNull().default({}),
    // The rest of the action's description from its product.yaml, as
    // catalog CI registers it: enough to list it, build its order form,
    // and wire it into a generated DAG (see the catalog's
    // docs/product-schema.md). Empty until CI registers the product with
    // them; nothing that runs a task reads them.
    displayName: text("display_name"),
    description: text("description"),
    outputSchema: jsonb("output_schema").notNull().default({}),
    // The ServiceAccount its tasks run as, in the owning team's namespace.
    serviceAccount: text("service_account"),
    // The team secrets it uses (product.yaml's actions[].secretRefs): its
    // bindings. (The column keeps its v1 name.)
    secretRefs: text("required_secrets").array().notNull().default(sql`'{}'::text[]`),
    // Audiences its tasks get a projected ServiceAccount token for, to sign
    // in to another cloud (product.yaml's tokenAudiences; tokenAudiences.ts).
    tokenAudiences: text("token_audiences").array().notNull().default(sql`'{}'::text[]`),
    // The other teams that may run it or include it in their templates, or
    // "*" for every team; empty, only its own team (product.yaml's
    // actions[].shareWith). Recorded; enforced once consumers run templates.
    shareWith: text("share_with").array().notNull().default(sql`'{}'::text[]`),
    // product.yaml's visibility: hidden: only its own team sees it (it then
    // has no shareWith). Otherwise every team sees it, and those it isn't
    // shared with can ask for access.
    hidden: boolean("hidden").notNull().default(false),
    // Its product.yaml in the catalog repository, for "Ask for access"
    // (teams/<team>/products/<product>/product.yaml); null when registered
    // otherwise.
    sourcePath: text("source_path"),
    // Running it again with the same inputs does no harm (product.yaml's
    // idempotent); only then may a step of it get more than one attempt.
    idempotent: boolean("idempotent").notNull().default(false),
    // How many times a step of it may run in all (product.yaml's
    // maxAttempts): the attempts its steps get, never more (R3).
    maxAttempts: integer("max_attempts").notNull().default(1),
    // Why it's deprecated and what to use instead; null when it isn't.
    deprecated: text("deprecated"),
    // The Pod size its tasks get unless a task sets its own: { cpu, memory,
    // memoryLimit } as Kubernetes quantities (the kernel's TaskResources).
    // Null: the deployment's default.
    resources: jsonb("resources").$type<ProductResources>(),
    // Registered from a catalog release (catalogSync.ts): unregistered when
    // a release no longer has it. One an admin registered by hand isn't.
    fromCatalog: boolean("from_catalog").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.image, table.action)],
);

/**
 * Which team owns each image repository (an image without its tag or
 * digest, normalized: imageRef.ts's imageRepository): the first team to
 * register a product from it. Only that team's products may use it, so no
 * team can register another's code as its own product and run it with its
 * own identity. Kept when the product is deleted, so the repository can't
 * be taken over afterwards either; an admin releases it
 * (DELETE /image-repositories). A null team: the platform's (products with
 * no team).
 */
export const imageRepositories = pgTable("image_repositories", {
  repository: text("repository").primaryKey(),
  teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One image's scan, by digest (scanning.ts): the platform scans every image
 * before it's registered or run, whoever built it, and again daily while
 * it's in use. A failed one blocks new registrations and runs (never steps
 * already running) until it's rescanned clean or an admin accepts it, with
 * a reason. The kernel chart's scan policy holds the failed digests, so the
 * cluster refuses them too.
 */
export const imageScans = pgTable("image_scans", {
  digest: text("digest").primaryKey(),
  // The reference it was scanned as (the first seen with this digest).
  image: text("image").notNull(),
  // pending | passed | failed | error
  status: text("status").notNull(),
  // { fixable, unfixable, secrets, findings: [...] } from the last scan.
  findings: jsonb("findings"),
  // The scan Job running now, if any.
  jobName: text("job_name"),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  scannedAt: timestamp("scanned_at", { withTimezone: true }),
  // When it was last asked for (registered or run): rescans stop for an
  // image nobody uses any more.
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  // An admin accepted a failed verdict: who, why, when. Cleared by a rescan
  // that finds something new.
  acceptedBy: uuid("accepted_by"),
  acceptedReason: text("accepted_reason"),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
});

/**
 * Who changed what (audit.ts): one row per request that tried to change
 * something through /api, allowed or refused, with the caller, the route,
 * what it named (route parameters and identifying body fields, never a
 * secret value, password or token) and the answer's status. Admins read it
 * (GET /audit); it's also logged, for shipping to a SIEM.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actorId: uuid("actor_id"),
    method: text("method").notNull(),
    route: text("route").notNull(),
    target: jsonb("target").notNull().default({}),
    status: integer("status").notNull(),
    requestId: text("request_id"),
  },
  (table) => [index("audit_log_at_idx").on(table.at), index("audit_log_actor_idx").on(table.actorId)],
);

/**
 * The catalog's wiring vocabulary (its schema/types.yaml): the names a
 * product's input uses to say what it needs (x-vertra-needs) and an
 * output what it provides (x-vertra-provides). A DAG generator connects
 * a needing input to a providing output through these. Catalog CI
 * replaces the whole set on every push to main (PUT /wiring-types).
 */
export const wiringTypes = pgTable("wiring_types", {
  name: text("name").primaryKey(),
  // The value's JSON type: string, integer, number or boolean.
  jsonType: text("json_type").notNull(),
  description: text("description").notNull(),
  // Asked once per order when no task in it provides the type.
  shared: boolean("shared").notNull().default(false),
  // <team>/<product>.<action> added to an order automatically when a
  // required input needs the type and nothing in the order provides it.
  defaultProvider: text("default_provider"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Every image a product has been registered with, one row per distinct
 * image reference. `products.image` stays the single current one (what CI
 * most recently registered); this is the history behind it, so the
 * Products page can list a product's releases rather than only its newest.
 *
 * Unique on (productId, image): CI re-registering the same image (a
 * re-run of the same commit) is not a new release, and keeps its original
 * registeredAt. Rows go with their product (unregistering or retiring a
 * team's products removes the history too).
 */
export const productReleases = pgTable(
  "product_releases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    image: text("image").notNull(),
    registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.productId, table.image)],
);

/**
 * A team's registered secrets: what POST /secrets has provisioned into
 * Kubernetes (see core/secrets.ts and k8s.ts) -- never the secret
 * *values* themselves, only which team, which Secret name, and which keys
 * it holds. Any of the team's registered products may mount any of them,
 * when a task lists it in secretRefs; nothing else may mount them, and no
 * Secret that isn't registered here may be mounted at all (the identity
 * policy, from productPolicy.ts). Kubernetes
 * stays the actual source of truth for the Secret's contents; this exists
 * because there was otherwise no way to answer "what's already registered
 * for my team" without either a live cluster query on every page load or
 * (before this table existed) not being able to answer it at all. Same
 * "index what kernel/k8s won't tell a human directly" role
 * submittedExecutions plays for kernel-api.
 *
 * Unique on (teamId, secretName): a namespace+name pair is a Kubernetes
 * Secret's own real identity, so re-registering (rotating) the same
 * secret is an update to this row, not a second one -- matching
 * upsertSecretGrant's own idempotent create-or-replace semantics.
 *
 * `source` is display metadata only, not an authorization input: who may
 * mount a secret only ever depends on its name, never how its contents got
 * populated (docs/security-model.md).
 * "external" means an ExternalSecret object was created (k8s.ts's
 * upsertExternalSecretGrant) referencing a SecretStore that must already
 * exist in this namespace; "literal" means a value was pasted directly
 * (upsertSecretGrant).
 */
export const secretGrants = pgTable(
  "secret_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    secretName: text("secret_name").notNull(),
    keys: text("keys").array().notNull(),
    source: text("source").notNull().default("literal"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.teamId, table.secretName)],
);

/**
 * kernel-api has no concept of users or teams at all (see docs/multi-
 * tenant-secrets-design.md -- it stays deliberately blind to both), so it
 * can't answer "who's allowed to see this execution." This is that answer,
 * recorded here at submission time (see core/executions.ts): every team
 * named by any task in the submission, so a later read/cancel/retry can
 * check the caller shares at least one of them (or is admin) before this
 * service forwards the request on to kernel-api at all.
 */
export const submittedExecutions = pgTable("submitted_executions", {
  // kernel-api's own execution id -- not generated here, just recorded
  // after kernel-api's response confirms it exists.
  executionId: uuid("execution_id").primaryKey(),
  teams: text("teams").array().notNull(),
  // Null once the submitter's account is deleted: the execution's record
  // (and so its history in the console) outlives the account.
  submittedBy: uuid("submitted_by").references(() => users.id, { onDelete: "set null" }),
  name: text("external_reference").notNull(),
  // The exact body forwarded to kernel-api's `POST /v1/executions` (see
  // core/executions.ts) -- kept so a later rerun can resubmit the same
  // task graph under a fresh requestId without the caller having to
  // hold onto or re-supply it themselves. Nullable because rows recorded
  // before this column existed have nothing to backfill it with; a rerun
  // of one of those is refused rather than guessed at.
  payload: jsonb("payload"),
  // Run from a template (core/templates.ts), not submitted as a DAG: which
  // one ("<team>/<template>", or "<team>/<product>.<action>" for an action
  // run as a one-step template), with what parameters, and on behalf of
  // which of the submitter's teams (null: the person alone). A rerun runs
  // the template again with these; the submitter may see, cancel and retry
  // it without being in the teams its steps ran in.
  template: text("template"),
  templateParameters: jsonb("template_parameters"),
  onBehalfOf: text("on_behalf_of"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // The execution list's order and cursor (listSubmittedExecutionsPage).
  // Ascending, scanned backwards: the same order as ORDER BY ... DESC.
  index("submitted_executions_created_at_idx").on(table.createdAt, table.executionId),
  // Which executions a team is part of (teams && ..., teams @> ...).
  index("submitted_executions_teams_idx").using("gin", table.teams),
]);

export const teamMemberships = pgTable(
  "team_memberships",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    // A maintainer manages the team (members, secrets, bots, raw DAGs); a
    // member sees all of its work and runs its actions (auth/access.ts).
    // Memberships from before roles were maintainers, and stay so.
    role: text("role").$type<TeamRole>().notNull().default("maintainer"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.teamId] }),
    check("team_memberships_role", sql`${table.role} in ('maintainer', 'member')`),
  ],
);

export type TeamRole = "maintainer" | "member";

/**
 * Templates (catalog format v2's dags/*.yaml of kind Template): what a
 * consumer runs, filling in only the parameters, from a catalog release
 * (catalogSync.ts), which also removes them. Each step names an action as
 * "<team>/<product>.<action>"; running one (core/templates.ts) runs each
 * step's product as its ServiceAccount, with its action's own secrets, in
 * its team's namespace. A template is its team's: retired or purged with
 * it.
 */
export const templates = pgTable(
  "templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description").notNull().default(""),
    // A JSON Schema for an object: the parameters, and the run form.
    parameters: jsonb("parameters").notNull().default({}),
    // [{ id, action, dependsOn?, inputs?, timeoutSeconds?, maxAttempts? }]
    steps: jsonb("steps").$type<TemplateStep[]>().notNull(),
    // The other teams that may run it, or "*" for every team; empty, only
    // its own.
    shareWith: text("share_with").array().notNull().default(sql`'{}'::text[]`),
    // As for products: only its own team sees a hidden one.
    hidden: boolean("hidden").notNull().default(false),
    // Its file in the catalog repository (teams/<team>/dags/<name>.yaml).
    sourcePath: text("source_path"),
    deprecated: text("deprecated"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.teamId, table.name)],
);

/** One step of a template, as the catalog release carries it. */
export interface TemplateStep {
  id: string;
  /** <team>/<product>.<action> */
  action: string;
  dependsOn?: string[];
  inputs?: Record<string, unknown>;
  timeoutSeconds?: number;
  maxAttempts?: number;
}

/**
 * The catalog release this console last applied, and how its last look went
 * (catalogSync.ts): one row, id 1. The release is read from the registry
 * (config.catalog.release), verified, and applied; the same digest isn't
 * applied twice.
 */
export const catalogSync = pgTable("catalog_sync", {
  id: integer("id").primaryKey().default(1),
  // The release artifact's manifest digest, its commit and repository.
  digest: text("digest"),
  commit: text("commit"),
  repository: text("repository"),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  // What applying it couldn't do, item by item: [{ item, message }].
  problems: jsonb("problems").$type<{ item: string; message: string; adoptableTeam?: string }[]>().notNull().default([]),
  // The last look: when, and why it failed, if it did (fetching or
  // verifying; nothing was applied then).
  checkedAt: timestamp("checked_at", { withTimezone: true }),
  error: text("error"),
});

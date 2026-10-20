// SPDX-License-Identifier: MIT
/** Thin, explicit query wrappers — no logic beyond the query itself, same
 * separation as kernel/app/persistence/repositories.py. */
import { and, arrayContains, arrayOverlaps, count, desc, eq, gte, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { imageRepository } from "../imageRef.js";
import { db } from "./client.js";
import {
  imageRepositories,
  teams,
  users,
  teamMemberships,
  apiTokens,
  products,
  productReleases,
  submittedExecutions,
  secretGrants,
  wiringTypes,
  type ProductResources,
} from "./schema.js";

export interface User {
  id: string;
  email: string;
  passwordHash: string | null;
  isAdmin: boolean;
  isBot: boolean;
  passwordChangedAt: Date | null;
}

export async function findUserByEmail(email: string): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return user;
}

export async function findUserById(id: string): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return user;
}

export async function createUser(email: string, passwordHash: string): Promise<User> {
  const [user] = await db.insert(users).values({ email, passwordHash }).returning();
  if (!user) throw new Error("Insert returned no row");
  return user;
}

export async function createTeam(name: string): Promise<typeof teams.$inferSelect> {
  const [team] = await db.insert(teams).values({ name }).returning();
  if (!team) throw new Error("Insert returned no row");
  return team;
}

export interface Team {
  id: string;
  name: string;
  createdAt: Date;
  retiredAt: Date | null;
  deletedAt: Date | null;
}

/** A live team: purged (deleted) teams are invisible to every route. A
 * retired team is still returned; callers that write check `retiredAt`. */
export async function findTeamByName(name: string): Promise<Team | undefined> {
  const [team] = await db
    .select()
    .from(teams)
    .where(and(eq(teams.name, name), isNull(teams.deletedAt)))
    .limit(1);
  return team;
}

/** Including purged teams. Only for "is this name taken" questions: a
 * purged team's name stays reserved (see schema.ts's teams.deletedAt). */
export async function findTeamByNameIncludingDeleted(name: string): Promise<Team | undefined> {
  const [team] = await db.select().from(teams).where(eq(teams.name, name)).limit(1);
  return team;
}

/** Also a purged team: for naming who owns something it left reserved. */
export async function findTeamByIdIncludingDeleted(id: string): Promise<Team | undefined> {
  const [team] = await db.select().from(teams).where(eq(teams.id, id)).limit(1);
  return team;
}

export async function findTeamById(id: string): Promise<Team | undefined> {
  const [team] = await db
    .select()
    .from(teams)
    .where(and(eq(teams.id, id), isNull(teams.deletedAt)))
    .limit(1);
  return team;
}

/** Admin-only in practice (see routes/teams.ts's `GET /teams`) -- a regular
 * member only ever learns team names through their own membership. */
export function listAllTeams(): Promise<Team[]> {
  return db.select().from(teams).where(isNull(teams.deletedAt));
}

export async function setTeamRetired(teamId: string, retired: boolean): Promise<void> {
  await db
    .update(teams)
    .set({ retiredAt: retired ? new Date() : null })
    .where(eq(teams.id, teamId));
}

/** Unregisters every product a team owns. Part of retiring it: a retired
 * platform shouldn't be offered for discovery. CI re-registers them on the
 * next push if the team is ever un-retired. */
export async function deleteProductsForTeam(teamId: string): Promise<number> {
  const deleted = await db.delete(products).where(eq(products.teamId, teamId)).returning();
  return deleted.length;
}

/** Purges a retired team in one transaction: memberships, secret grants and
 * products go, bots left belonging to no live team have their tokens
 * revoked, and the row is soft-deleted so its name stays reserved.
 * Execution history (submittedExecutions) is deliberately kept. */
export async function purgeTeam(teamId: string): Promise<{ revokedBotTokens: number }> {
  return db.transaction(async (tx) => {
    const members = await tx
      .delete(teamMemberships)
      .where(eq(teamMemberships.teamId, teamId))
      .returning({ userId: teamMemberships.userId });
    await tx.delete(secretGrants).where(eq(secretGrants.teamId, teamId));
    await tx.delete(products).where(eq(products.teamId, teamId));

    let revokedBotTokens = 0;
    for (const { userId } of members) {
      const [user] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!user?.isBot) continue;
      const [stillMember] = await tx
        .select({ teamId: teamMemberships.teamId })
        .from(teamMemberships)
        .where(eq(teamMemberships.userId, userId))
        .limit(1);
      if (stillMember) continue;
      const revoked = await tx
        .update(apiTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
        .returning();
      revokedBotTokens += revoked.length;
    }

    await tx.update(teams).set({ deletedAt: new Date() }).where(eq(teams.id, teamId));
    return { revokedBotTokens };
  });
}

export async function addTeamMember(userId: string, teamId: string): Promise<void> {
  await db.insert(teamMemberships).values({ userId, teamId }).onConflictDoNothing();
}

/** False when the user wasn't a member. */
export async function removeTeamMember(userId: string, teamId: string): Promise<boolean> {
  const removed = await db
    .delete(teamMemberships)
    .where(and(eq(teamMemberships.userId, userId), eq(teamMemberships.teamId, teamId)))
    .returning({ userId: teamMemberships.userId });
  return removed.length > 0;
}

/** Also stamps passwordChangedAt, which is what revokes every session
 * issued before this call (see auth/plugin.ts). */
export async function setUserPassword(userId: string, passwordHash: string): Promise<void> {
  await db
    .update(users)
    .set({ passwordHash, passwordChangedAt: new Date() })
    .where(eq(users.id, userId));
}

export async function setUserAdmin(userId: string, isAdmin: boolean): Promise<void> {
  await db.update(users).set({ isAdmin }).where(eq(users.id, userId));
}

export interface UserSummary {
  email: string;
  isAdmin: boolean;
  createdAt: Date;
  teamNames: string[];
}

/** Every human account (bots are listed per team, see routes/bots.ts) with
 * the active teams it belongs to, for the Admin page. */
export async function listHumanUsersWithTeams(): Promise<UserSummary[]> {
  const rows = await db
    .select({
      email: users.email,
      isAdmin: users.isAdmin,
      createdAt: users.createdAt,
      teamName: teams.name,
    })
    .from(users)
    .leftJoin(teamMemberships, eq(teamMemberships.userId, users.id))
    .leftJoin(teams, and(eq(teams.id, teamMemberships.teamId), isNull(teams.deletedAt)))
    .where(eq(users.isBot, false))
    .orderBy(users.email);
  const byEmail = new Map<string, UserSummary>();
  for (const row of rows) {
    const summary = byEmail.get(row.email) ?? {
      email: row.email,
      isAdmin: row.isAdmin,
      createdAt: row.createdAt,
      teamNames: [],
    };
    if (row.teamName) summary.teamNames.push(row.teamName);
    byEmail.set(row.email, summary);
  }
  return [...byEmail.values()];
}

/** Removes the account, its memberships and its tokens (cascades). The
 * executions it submitted stay, with no submitter (see schema.ts). */
export async function deleteUser(userId: string): Promise<void> {
  await db.delete(users).where(eq(users.id, userId));
}

/** Used to refuse revoking the last admin (routes/users.ts) -- an empty
 * platform-admin set would mean nobody could ever grant it back. */
export async function countAdmins(): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(users)
    .where(eq(users.isAdmin, true));
  return row?.count ?? 0;
}

/** The names of every team a user belongs to — this, not anything baked
 * into a JWT, is the live authorization source checked on every request,
 * so a membership change takes effect immediately, not at next login. */
export async function teamNamesForUser(userId: string): Promise<string[]> {
  const rows = await db
    .select({ name: teams.name })
    .from(teamMemberships)
    .innerJoin(teams, eq(teams.id, teamMemberships.teamId))
    .where(eq(teamMemberships.userId, userId));
  return rows.map((row) => row.name);
}

/** Idempotent: reuses the bot user if one with this email already exists
 * (routes/bots.ts still checks it's actually a bot, not a human who
 * happens to share the email, before treating it as one). */
export async function createBotUser(email: string): Promise<User> {
  const [inserted] = await db
    .insert(users)
    .values({ email, isBot: true })
    .onConflictDoNothing({ target: users.email })
    .returning();
  if (inserted) return inserted;
  const existing = await findUserByEmail(email);
  if (!existing) throw new Error("Insert conflicted but no existing row was found");
  return existing;
}

export interface ApiTokenMeta {
  id: string;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export async function createApiToken(
  userId: string,
  label: string,
  tokenHash: string,
  scopes: string[] = [],
): Promise<ApiTokenMeta> {
  const [token] = await db
    .insert(apiTokens)
    .values({ userId, label, tokenHash, scopes })
    .returning();
  if (!token) throw new Error("Insert returned no row");
  return token;
}

export interface AutomationToken extends ApiTokenMeta {
  botEmail: string;
  scopes: string[];
}

/** Every live automation token: a token with platform-wide scopes. Team
 * bots' tokens (no scopes) are listed per team by listBotsForTeam. */
export function listAutomationTokens(): Promise<AutomationToken[]> {
  return db
    .select({
      id: apiTokens.id,
      label: apiTokens.label,
      createdAt: apiTokens.createdAt,
      lastUsedAt: apiTokens.lastUsedAt,
      scopes: apiTokens.scopes,
      botEmail: users.email,
    })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(and(isNull(apiTokens.revokedAt), sql`cardinality(${apiTokens.scopes}) > 0`))
    .orderBy(desc(apiTokens.createdAt));
}

/** The only place a raw bearer token is ever turned back into an identity
 * -- see auth/plugin.ts. Revoked tokens never resolve to anything. */
/** The bot behind a live (unrevoked) API token, plus that token's own
 * scopes -- scopes belong to the token, not the bot, so revoking one
 * token never widens or narrows another. */
export async function findApiTokenPrincipal(
  tokenHash: string,
): Promise<{ user: User; scopes: string[]; tokenId: string; lastUsedAt: Date | null } | undefined> {
  const [row] = await db
    .select({
      user: users,
      scopes: apiTokens.scopes,
      tokenId: apiTokens.id,
      lastUsedAt: apiTokens.lastUsedAt,
    })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(and(eq(apiTokens.tokenHash, tokenHash), isNull(apiTokens.revokedAt)))
    .limit(1);
  return row;
}

/** Records that a token was just used. Coarse on purpose: the caller skips
 * this while the stored time is recent, so a busy pipeline isn't a write
 * per request. */
export async function touchApiToken(tokenId: string): Promise<void> {
  await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, tokenId));
}

export async function revokeApiToken(tokenId: string): Promise<void> {
  await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, tokenId));
}

export async function findApiTokenById(
  tokenId: string,
): Promise<{ id: string; userId: string; revokedAt: Date | null } | undefined> {
  const [token] = await db
    .select({ id: apiTokens.id, userId: apiTokens.userId, revokedAt: apiTokens.revokedAt })
    .from(apiTokens)
    .where(eq(apiTokens.id, tokenId))
    .limit(1);
  return token;
}

export interface BotWithTokens {
  id: string;
  email: string;
  tokens: ApiTokenMeta[];
}

/** N+1 on purpose -- a team realistically has a handful of bots, and this
 * reads far more plainly than a single aggregated join would. */
export async function listBotsForTeam(teamId: string): Promise<BotWithTokens[]> {
  const bots = await db
    .select({ id: users.id, email: users.email })
    .from(teamMemberships)
    .innerJoin(users, eq(users.id, teamMemberships.userId))
    .where(and(eq(teamMemberships.teamId, teamId), eq(users.isBot, true)));

  const withTokens: BotWithTokens[] = [];
  for (const bot of bots) {
    const tokens = await db
      .select({
        id: apiTokens.id,
        label: apiTokens.label,
        createdAt: apiTokens.createdAt,
        lastUsedAt: apiTokens.lastUsedAt,
      })
      .from(apiTokens)
      .where(and(eq(apiTokens.userId, bot.id), isNull(apiTokens.revokedAt)));
    withTokens.push({ ...bot, tokens });
  }
  return withTokens;
}

export interface TeamMember {
  id: string;
  email: string;
  isBot: boolean;
  isAdmin: boolean;
  addedAt: Date;
}

/** Human *and* bot accounts -- the Members tab shows both today (there's
 * no separate "CI/Bots" filter on this specific list; BotManagementSection
 * has its own dedicated bot view already). Ordered oldest-first so "who
 * was here from the start" reads naturally. */
export async function listMembersForTeam(teamId: string): Promise<TeamMember[]> {
  return db
    .select({
      id: users.id,
      email: users.email,
      isBot: users.isBot,
      isAdmin: users.isAdmin,
      addedAt: teamMemberships.createdAt,
    })
    .from(teamMemberships)
    .innerJoin(users, eq(users.id, teamMemberships.userId))
    .where(eq(teamMemberships.teamId, teamId))
    .orderBy(teamMemberships.createdAt);
}

export interface Product {
  id: string;
  name: string;
  image: string;
  action: string;
  teamId: string | null;
  inputSchema: unknown;
  displayName: string | null;
  description: string | null;
  outputSchema: unknown;
  serviceAccount: string | null;
  secretRefs: string[];
  shareWith: string[];
  deprecated: string | null;
  resources: ProductResources | null;
  createdAt: Date;
}

export interface ProductRelease {
  image: string;
  registeredAt: Date;
}

/** A product plus its owning team's name (its platform; null for a
 * platform-provided product with no team) and its release history, newest
 * first. */
export interface ProductWithReleases extends Product {
  teamName: string | null;
  releases: ProductRelease[];
}

export interface ProductInput {
  name: string;
  image: string;
  action: string;
  teamId: string | null;
  // Each optional: left out, a new product gets the column's default and
  // an existing one keeps what it has, so a caller that doesn't send a
  // field (an older catalog CI) never wipes it.
  inputSchema?: unknown;
  displayName?: string | undefined;
  description?: string | undefined;
  outputSchema?: unknown;
  serviceAccount?: string | undefined;
  secretRefs?: string[] | undefined;
  shareWith?: string[] | undefined;
  deprecated?: string | null | undefined;
  resources?: ProductResources | undefined;
}

/** Registration and re-registration are the same call (see routes/products.ts
 * -- CI runs this on every merge, not just the product's first ever build),
 * keyed on name. */
/**
 * A registration refused because another team (or the platform, a null
 * owner) already owns the product name or the image repository. A product
 * is its team's: no other team may take over its name, or register its
 * image repository as theirs and run that code with their own identity.
 */
export class ProductOwnershipError extends Error {
  constructor(
    readonly conflict: "name" | "repository",
    readonly ownerTeamId: string | null,
  ) {
    super(`${conflict} is owned by ${ownerTeamId ?? "the platform"}`);
    this.name = "ProductOwnershipError";
  }
}

/**
 * Registers a product, or updates one its team already registered under
 * this name. Throws ProductOwnershipError when the name or the image's
 * repository belongs to someone else. The image repository is claimed for
 * the product's team by the first registration that uses it, and stays
 * claimed after the product is deleted (see schema.ts's imageRepositories).
 */
export async function upsertProduct(input: ProductInput): Promise<Product> {
  const described = Object.fromEntries(
    Object.entries({
      inputSchema: input.inputSchema,
      displayName: input.displayName,
      description: input.description,
      outputSchema: input.outputSchema,
      serviceAccount: input.serviceAccount,
      secretRefs: input.secretRefs,
      shareWith: input.shareWith,
      deprecated: input.deprecated,
      resources: input.resources,
    }).filter(([, value]) => value !== undefined),
  );
  const repository = imageRepository(input.image);
  return db.transaction(async (tx) => {
    // Claims it if nobody has; then whoever has, which a concurrent first
    // registration by another team can't change underneath this one.
    await tx.insert(imageRepositories).values({ repository, teamId: input.teamId }).onConflictDoNothing();
    const [owner] = await tx
      .select({ teamId: imageRepositories.teamId })
      .from(imageRepositories)
      .where(eq(imageRepositories.repository, repository));
    if (!owner || owner.teamId !== input.teamId) {
      throw new ProductOwnershipError("repository", owner?.teamId ?? null);
    }
    // An existing name is only updated when it's this team's product, in
    // the same statement, so two teams racing for one new name can't both
    // end up thinking it's theirs.
    const [product] = await tx
      .insert(products)
      .values({ name: input.name, image: input.image, action: input.action, teamId: input.teamId, ...described })
      .onConflictDoUpdate({
        target: products.name,
        set: { image: input.image, action: input.action, ...described },
        setWhere: sql`${products.teamId} is not distinct from ${input.teamId}`,
      })
      .returning();
    if (!product) {
      const [existing] = await tx
        .select({ teamId: products.teamId })
        .from(products)
        .where(eq(products.name, input.name));
      throw new ProductOwnershipError("name", existing?.teamId ?? null);
    }
    // Record this image as a release. Re-registering an image already
    // recorded is a no-op, so a CI re-run doesn't duplicate or re-date it.
    await tx
      .insert(productReleases)
      .values({ productId: product.id, image: product.image })
      .onConflictDoNothing({ target: [productReleases.productId, productReleases.image] });
    return product;
  });
}

/**
 * Claims, for its product's team, every image repository a registered
 * product uses and nobody owns yet: products registered before
 * repositories had owners. The oldest product of a repository decides.
 * Idempotent; run at startup.
 */
export async function claimRegisteredImageRepositories(): Promise<void> {
  const registered = await db
    .select({ image: products.image, teamId: products.teamId })
    .from(products)
    .orderBy(products.createdAt);
  for (const { image, teamId } of registered) {
    await db
      .insert(imageRepositories)
      .values({ repository: imageRepository(image), teamId })
      .onConflictDoNothing();
  }
}

export interface ImageRepositoryOwner {
  repository: string;
  teamName: string | null;
  createdAt: Date;
  /** How many registered products use it. */
  products: number;
}

export async function listImageRepositories(): Promise<ImageRepositoryOwner[]> {
  const [owners, registered] = await Promise.all([
    db
      .select({
        repository: imageRepositories.repository,
        teamName: teams.name,
        createdAt: imageRepositories.createdAt,
      })
      .from(imageRepositories)
      .leftJoin(teams, eq(teams.id, imageRepositories.teamId))
      .orderBy(imageRepositories.repository),
    db.select({ image: products.image }).from(products),
  ]);
  const uses = new Map<string, number>();
  for (const { image } of registered) {
    const repository = imageRepository(image);
    uses.set(repository, (uses.get(repository) ?? 0) + 1);
  }
  return owners.map((owner) => ({ ...owner, products: uses.get(owner.repository) ?? 0 }));
}

/**
 * Releases a repository's owner, so any team may register it next. Refused
 * ("in-use") while a registered product still uses it: delete those first.
 */
export async function releaseImageRepository(
  repository: string,
): Promise<"released" | "in-use" | "not-found"> {
  const registered = await db.select({ image: products.image }).from(products);
  if (registered.some(({ image }) => imageRepository(image) === repository)) return "in-use";
  const deleted = await db
    .delete(imageRepositories)
    .where(eq(imageRepositories.repository, repository))
    .returning({ repository: imageRepositories.repository });
  return deleted.length > 0 ? "released" : "not-found";
}

/** The products a task dispatched into this team's namespace may be: the
 * team's own and the platform's (no team). Null for a namespace with no
 * console team: only the platform's. */
export function listProductsUsableBy(teamId: string | null): Promise<Product[]> {
  const platform = isNull(products.teamId);
  return db
    .select()
    .from(products)
    .where(teamId === null ? platform : or(eq(products.teamId, teamId), platform));
}

export interface ProductIdentity {
  image: string;
  action: string;
  serviceAccount: string | null;
  /** The owning team's name (its namespace); null for a platform product. */
  teamName: string | null;
}

/** What the cluster's identity policy needs about every product that can
 * run (productPolicy.ts): a purged team's products never match a task. */
export function listProductIdentities(): Promise<ProductIdentity[]> {
  return db
    .select({
      image: products.image,
      action: products.action,
      serviceAccount: products.serviceAccount,
      teamName: teams.name,
    })
    .from(products)
    .leftJoin(teams, eq(teams.id, products.teamId))
    .where(or(isNull(products.teamId), isNull(teams.deletedAt)))
    .orderBy(products.name);
}

export async function findProductByName(name: string): Promise<Product | undefined> {
  const [product] = await db.select().from(products).where(eq(products.name, name)).limit(1);
  return product;
}

/** Two queries, not a join: every product with its releases (newest
 * first), without repeating each product's columns once per release. */
export async function listProducts(): Promise<ProductWithReleases[]> {
  const [allProducts, allReleases] = await Promise.all([
    // The team's name comes along so the Products page can group by
    // platform for every viewer: GET /teams (the only other source of
    // names) is admin-only.
    db
      .select({ product: products, teamName: teams.name })
      .from(products)
      .leftJoin(teams, eq(teams.id, products.teamId))
      .orderBy(products.name),
    db
      .select({
        productId: productReleases.productId,
        image: productReleases.image,
        registeredAt: productReleases.registeredAt,
      })
      .from(productReleases)
      .orderBy(desc(productReleases.registeredAt)),
  ]);
  const releasesByProduct = new Map<string, ProductRelease[]>();
  for (const { productId, image, registeredAt } of allReleases) {
    const list = releasesByProduct.get(productId) ?? [];
    list.push({ image, registeredAt });
    releasesByProduct.set(productId, list);
  }
  return allProducts.map(({ product, teamName }) => ({
    ...product,
    teamName,
    releases: releasesByProduct.get(product.id) ?? [],
  }));
}

export interface WiringType {
  name: string;
  jsonType: string;
  description: string;
  shared: boolean;
  defaultProvider: string | null;
  updatedAt: Date;
}

export function listWiringTypes(): Promise<WiringType[]> {
  return db.select().from(wiringTypes).orderBy(wiringTypes.name);
}

/** Replaces the whole vocabulary in one transaction: what catalog CI sends
 * is the complete schema/types.yaml, so a type removed there goes here too. */
export async function replaceWiringTypes(
  types: Omit<WiringType, "updatedAt">[],
): Promise<WiringType[]> {
  return db.transaction(async (tx) => {
    await tx.delete(wiringTypes);
    if (types.length === 0) return [];
    return tx.insert(wiringTypes).values(types).returning();
  });
}

export async function deleteProductByName(name: string): Promise<void> {
  await db.delete(products).where(eq(products.name, name));
}

export interface SubmittedExecution {
  executionId: string;
  teams: string[];
  /** Null once the submitter's account was deleted (history outlives it). */
  submittedBy: string | null;
  name: string;
  // The exact body originally forwarded to kernel-api -- `null` only for
  // rows recorded before this column existed (see schema.ts). This is
  // what a rerun resubmits, unmodified apart from a fresh requestId.
  payload: unknown;
  createdAt: Date;
}

/** Called right after kernel-api confirms the execution exists (see
 * routes/executions.ts) -- this is the only record of which teams are
 * allowed to see it, since kernel-api itself has no concept of teams.
 * `onConflictDoNothing` on purpose, not a plain insert -- kernel-api's own
 * requestId handling means this can run more than once for the same
 * executionId (a resubmission with a previously-used key returns kernel's
 * original 200, same executionId, not a new one). A plain insert crashed
 * with a real, unhandled unique-constraint violation on the second call --
 * caught live, not anticipated. The row from the first, real submission is
 * already correct; a repeat call has nothing new to record. */
export async function recordSubmittedExecution(input: {
  executionId: string;
  teams: string[];
  submittedBy: string;
  name: string;
  payload: unknown;
}): Promise<void> {
  await db.insert(submittedExecutions).values(input).onConflictDoNothing();
}

export async function findSubmittedExecution(
  executionId: string,
): Promise<SubmittedExecution | undefined> {
  const [row] = await db
    .select()
    .from(submittedExecutions)
    .where(eq(submittedExecutions.executionId, executionId))
    .limit(1);
  return row;
}

/** The executions behind a set of task pods, for labelling them on the
 * Team page: name, and each task's position in its DAG. */
export async function findSubmittedExecutions(executionIds: string[]): Promise<SubmittedExecution[]> {
  if (executionIds.length === 0) return [];
  return db
    .select()
    .from(submittedExecutions)
    .where(inArray(submittedExecutions.executionId, executionIds));
}

export type SubmittedExecutionSummary = Omit<SubmittedExecution, "payload">;

// Every list caller (routes/executions.ts's `GET /executions`) only ever
// renders summary fields -- `payload` is a full stored task graph, fetched
// only where it's actually needed (findSubmittedExecution, for the detail
// page and for /rerun), so a list of many executions doesn't ship every
// one's entire DAG definition over the wire just to render a table row.
const summaryColumns = {
  executionId: submittedExecutions.executionId,
  teams: submittedExecutions.teams,
  submittedBy: submittedExecutions.submittedBy,
  name: submittedExecutions.name,
  createdAt: submittedExecutions.createdAt,
};

export interface ExecutionPageQuery {
  /** Only executions sharing one of these teams; null for every execution (an admin). */
  visibleTo: string[] | null;
  limit: number;
  /** A previous page's `nextCursor`. */
  cursor?: string | undefined;
  since?: Date | undefined;
  /** Only executions this team is part of. */
  team?: string | undefined;
  /** Part of the name, any case. */
  search?: string | undefined;
}

export interface ExecutionPage {
  rows: SubmittedExecutionSummary[];
  /** Where the next page starts; null on the last page. */
  nextCursor: string | null;
}

/** Thrown for a cursor this function didn't produce. */
export class InvalidCursorError extends Error {}

const CURSOR_SEPARATOR = "|";

/**
 * Executions newest first, one page at a time. The cursor is the last row's
 * (created_at, execution_id), with the time as Postgres's own text: a JS Date
 * would round its microseconds and skip or repeat rows at a page boundary.
 */
export async function listSubmittedExecutionsPage(query: ExecutionPageQuery): Promise<ExecutionPage> {
  const conditions = [];
  if (query.visibleTo !== null) {
    if (query.visibleTo.length === 0) return { rows: [], nextCursor: null };
    conditions.push(arrayOverlaps(submittedExecutions.teams, query.visibleTo));
  }
  if (query.team) conditions.push(arrayContains(submittedExecutions.teams, [query.team]));
  if (query.since) conditions.push(gte(submittedExecutions.createdAt, query.since));
  if (query.search) {
    const escaped = query.search.replace(/[\\%_]/g, (c) => `\\${c}`);
    conditions.push(ilike(submittedExecutions.name, `%${escaped}%`));
  }
  if (query.cursor) {
    const [time, id] = query.cursor.split(CURSOR_SEPARATOR);
    if (!time || !id || !/^[0-9a-f-]{36}$/.test(id) || Number.isNaN(Date.parse(time))) {
      throw new InvalidCursorError("Not a cursor from this list.");
    }
    conditions.push(
      sql`(${submittedExecutions.createdAt}, ${submittedExecutions.executionId}) < (${time}::timestamptz, ${id}::uuid)`,
    );
  }
  const rows = await db
    .select({ ...summaryColumns, cursorTime: sql<string>`${submittedExecutions.createdAt}::text` })
    .from(submittedExecutions)
    .where(and(...conditions))
    .orderBy(desc(submittedExecutions.createdAt), desc(submittedExecutions.executionId))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    rows: page.map((row) => ({
      executionId: row.executionId,
      teams: row.teams,
      submittedBy: row.submittedBy,
      name: row.name,
      createdAt: row.createdAt,
    })),
    nextCursor: rows.length > query.limit && last ? `${last.cursorTime}${CURSOR_SEPARATOR}${last.executionId}` : null,
  };
}

/** Executions visible to a non-admin: any execution with at least one
 * task belonging to a team they're a member of (the `&&` array-overlap
 * operator, not equality -- a caller only needs to share one team with a
 * multi-team DAG, not own all of it). */
export function listSubmittedExecutionsForTeams(
  teamNames: string[],
): Promise<SubmittedExecutionSummary[]> {
  if (teamNames.length === 0) return Promise.resolve([]);
  return db
    .select(summaryColumns)
    .from(submittedExecutions)
    .where(arrayOverlaps(submittedExecutions.teams, teamNames))
    .orderBy(desc(submittedExecutions.createdAt));
}

/** Platform-wide counts for the admin home view (routes/stats.ts) --
 * server-side aggregates, not "fetch the full list and take .length,"
 * since a non-admin never has a reason to pull every row in these tables
 * just to render a number. */
export async function countTeams(): Promise<number> {
  const [row] = await db.select({ count: count() }).from(teams).where(isNull(teams.deletedAt));
  return row?.count ?? 0;
}

export async function countUsers(): Promise<number> {
  const [row] = await db.select({ count: count() }).from(users);
  return row?.count ?? 0;
}

export async function countProducts(): Promise<number> {
  const [row] = await db.select({ count: count() }).from(products);
  return row?.count ?? 0;
}

export async function countSubmittedExecutions(): Promise<number> {
  const [row] = await db.select({ count: count() }).from(submittedExecutions);
  return row?.count ?? 0;
}

export type SecretGrantSource = "literal" | "external";

export interface SecretGrantRecord {
  id: string;
  teamId: string;
  secretName: string;
  keys: string[];
  source: SecretGrantSource;
  createdAt: Date;
  updatedAt: Date;
}

/** Called right after k8s.ts's upsertSecretGrant/upsertExternalSecretGrant
 * actually provisions the Secret or ExternalSecret (see
 * routes/secrets.ts) -- records what was granted, never the values.
 * Upsert on (teamId, secretName): re-registering the same secret
 * (rotation, or switching source) updates this row instead of creating a
 * second one, matching upsertSecretGrant's own create-or-replace
 * semantics. */
export async function recordSecretGrant(input: {
  teamId: string;
  secretName: string;
  keys: string[];
  source: SecretGrantSource;
}): Promise<SecretGrantRecord> {
  const now = new Date();
  const [row] = await db
    .insert(secretGrants)
    .values({ ...input, updatedAt: now })
    .onConflictDoUpdate({
      target: [secretGrants.teamId, secretGrants.secretName],
      set: {
        keys: input.keys,
        source: input.source,
        updatedAt: now,
      },
    })
    .returning();
  if (!row) throw new Error("Insert returned no row");
  return row as SecretGrantRecord;
}

export async function deleteSecretGrantRecord(teamId: string, secretName: string): Promise<void> {
  await db.delete(secretGrants).where(and(eq(secretGrants.teamId, teamId), eq(secretGrants.secretName, secretName)));
}

export async function listSecretGrantsForTeam(teamId: string): Promise<SecretGrantRecord[]> {
  const rows = await db
    .select()
    .from(secretGrants)
    .where(eq(secretGrants.teamId, teamId))
    .orderBy(desc(secretGrants.updatedAt));
  return rows as SecretGrantRecord[];
}

/** Whether a team registered this secret: what a task's secretRefs may
 * name (routes/executions.ts). The kernel mounts whatever Secret name it's
 * given, with no notion of teams, so this is where that's decided. */
export async function isSecretRegistered(teamId: string, secretName: string): Promise<boolean> {
  const [row] = await db
    .select({ id: secretGrants.id })
    .from(secretGrants)
    .where(and(eq(secretGrants.teamId, teamId), eq(secretGrants.secretName, secretName)))
    .limit(1);
  return row !== undefined;
}

/** Every team's registered secret names, for the identity policy
 * (productPolicy.ts); a purged team's never match a task. */
export function listTeamSecretNames(): Promise<{ teamName: string; secretName: string }[]> {
  return db
    .select({ teamName: teams.name, secretName: secretGrants.secretName })
    .from(secretGrants)
    .innerJoin(teams, eq(teams.id, secretGrants.teamId))
    .where(isNull(teams.deletedAt))
    .orderBy(teams.name, secretGrants.secretName);
}

/** Every registered secret, for removing the per-secret Roles the console
 * used to create (k8s.ts's removeLegacySecretRoles). */
export function listAllSecretGrants(): Promise<{ teamName: string; secretName: string }[]> {
  return db
    .select({ teamName: teams.name, secretName: secretGrants.secretName })
    .from(secretGrants)
    .innerJoin(teams, eq(teams.id, secretGrants.teamId));
}

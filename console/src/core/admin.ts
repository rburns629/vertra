// SPDX-License-Identifier: MIT
/**
 * Running the platform, for admins: platform-wide counts, who changed what
 * (audit.ts), whether the cluster's copies of the console's lists are
 * current (policySync.ts), and the catalog release applied
 * (catalogSync.ts). The logic behind AdminService.
 */
import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import { Type } from "@sinclair/typebox";
import type { FastifyBaseLogger } from "fastify";
import { Code } from "@connectrpc/connect";
import { ApiError, forbiddenUnlessAdmin } from "../apiError.js";
import type { AuthUser } from "../auth/plugin.js";
import { db } from "../db/client.js";
import { countProducts, countSubmittedExecutions, countTeams, countUsers } from "../db/queries.js";
import { auditLog, users } from "../db/schema.js";
import { adoptTeam, catalogStatus, syncCatalog } from "../catalogSync.js";
import { policySyncOutcomes, syncPolicies } from "../policySync.js";

const REQUIRES_ADMIN = "Requires admin access.";

/**
 * Platform-wide counts for the admin home page. Admins only: a non-admin's
 * home page derives its own numbers from what it already fetches.
 */
export async function platformStats(caller: AuthUser | undefined) {
  forbiddenUnlessAdmin(caller);
  const [teams, accounts, products, executions] = await Promise.all([
    countTeams(),
    countUsers(),
    countProducts(),
    countSubmittedExecutions(),
  ]);
  return { teams, users: accounts, products, executions };
}

export const AuditQuery = Type.Object({
  // The id of the last entry already seen: older ones come next.
  before: Type.Optional(Type.Integer({ minimum: 1 })),
  actor: Type.Optional(Type.String({ format: "uuid" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
});

/** The audit log, newest first, a page at a time. */
export async function auditEntries(
  caller: AuthUser | undefined,
  query: { before?: number | undefined; actor?: string | undefined; limit?: number | undefined },
) {
  forbiddenUnlessAdmin(caller, REQUIRES_ADMIN);
  const { before, actor, limit = 100 } = query;
  const conditions: SQL[] = [];
  if (before !== undefined) conditions.push(lt(auditLog.id, before));
  if (actor !== undefined) conditions.push(eq(auditLog.actorId, actor));
  const rows = await db
    .select({
      id: auditLog.id,
      at: auditLog.at,
      actorId: auditLog.actorId,
      actorEmail: users.email,
      actorIsBot: users.isBot,
      method: auditLog.method,
      route: auditLog.route,
      target: auditLog.target,
      status: auditLog.status,
      requestId: auditLog.requestId,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(auditLog.id))
    .limit(limit);
  return { entries: rows, nextBefore: rows.length === limit ? (rows.at(-1)?.id ?? null) : null };
}

/** The last outcome of each policy sync. */
export function policySync(caller: AuthUser | undefined) {
  forbiddenUnlessAdmin(caller, REQUIRES_ADMIN);
  return policySyncOutcomes();
}

/** Runs every policy sync now, then returns their outcomes. */
export async function syncPoliciesNow(caller: AuthUser | undefined, log: FastifyBaseLogger) {
  forbiddenUnlessAdmin(caller, REQUIRES_ADMIN);
  await syncPolicies(log);
  return policySyncOutcomes();
}

/** The catalog release last applied, and how the last look went. */
export async function catalogState(caller: AuthUser | undefined) {
  forbiddenUnlessAdmin(caller, REQUIRES_ADMIN);
  return catalogStatus();
}

/** Reads and applies the catalog's release now, even the one applied already. */
export async function syncCatalogNow(caller: AuthUser | undefined, log: FastifyBaseLogger) {
  forbiddenUnlessAdmin(caller, REQUIRES_ADMIN);
  if (!(await syncCatalog(log, true))) {
    throw new ApiError(409, "BUSY", "Another console is applying the catalog right now; try again shortly.", Code.Aborted);
  }
  return catalogStatus();
}

/** Lets the catalog's release manage an existing team, then syncs. */
export async function adoptCatalogTeam(caller: AuthUser | undefined, name: string, log: FastifyBaseLogger) {
  forbiddenUnlessAdmin(caller, REQUIRES_ADMIN);
  if (!(await adoptTeam(name))) throw new ApiError(404, "NOT_FOUND", "No such team.", Code.NotFound);
  log.info({ event: "catalog_team_adopted", team: name, by: caller?.id }, "team adopted by the catalog");
  return syncCatalogNow(caller, log);
}

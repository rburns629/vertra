// SPDX-License-Identifier: MIT
/** AdminService (proto/acyclix/console/v1/admin.proto): core/admin.ts over Connect. */
import type { ServiceImpl } from "@connectrpc/connect";
import type { JsonObject } from "@bufbuild/protobuf";
import { AuditQuery, auditEntries, platformStats, policySync, syncPoliciesNow } from "../../core/admin.js";
import type { AdminService } from "../../gen/acyclix/console/v1/admin_pb.js";
import type { SyncOutcome } from "../../policySync.js";
import { timestamp, unsetIfEmpty } from "../convert.js";
import { callerOf, logOf } from "../context.js";
import { check } from "../validate.js";

function outcomes(byPolicy: Record<string, SyncOutcome | null>) {
  return Object.fromEntries(
    Object.entries(byPolicy)
      .filter((entry): entry is [string, SyncOutcome] => entry[1] !== null)
      .map(([name, outcome]) => [
        name,
        { applies: outcome.applies, ok: outcome.ok, at: timestamp(outcome.at), error: outcome.error },
      ]),
  );
}

export function adminService(): ServiceImpl<typeof AdminService> {
  return {
    async getStats(_req, ctx) {
      const stats = await platformStats(callerOf(ctx));
      return {
        teams: BigInt(stats.teams),
        users: BigInt(stats.users),
        products: BigInt(stats.products),
        executions: BigInt(stats.executions),
      };
    },

    async listAuditEntries(req, ctx) {
      const query = check(
        { query: AuditQuery },
        {
          query: {
            before: unsetIfEmpty(Number(req.before)),
            actor: unsetIfEmpty(req.actorId),
            limit: unsetIfEmpty(req.limit),
          },
        },
      ).query;
      const page = await auditEntries(callerOf(ctx), query);
      return {
        entries: page.entries.map((entry) => ({
          id: BigInt(entry.id),
          at: timestamp(entry.at),
          actorId: entry.actorId ?? undefined,
          actorEmail: entry.actorEmail ?? undefined,
          actorIsBot: entry.actorIsBot ?? false,
          method: entry.method,
          route: entry.route,
          target: entry.target as JsonObject,
          status: entry.status,
          requestId: entry.requestId ?? undefined,
        })),
        nextBefore: BigInt(page.nextBefore ?? 0),
      };
    },

    getPolicySync(_req, ctx) {
      return { outcomes: outcomes(policySync(callerOf(ctx))) };
    },

    async syncPolicies(_req, ctx) {
      return { outcomes: outcomes(await syncPoliciesNow(callerOf(ctx), logOf(ctx))) };
    },
  };
}

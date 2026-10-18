// SPDX-License-Identifier: MIT
import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import { db } from "../db/client.js";
import { auditLog, users } from "../db/schema.js";

/** Who changed what (audit.ts), newest first, for admins. */
const auditRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    "/audit",
    {
      schema: {
        querystring: Type.Object({
          // The id of the last entry already seen: older ones come next.
          before: Type.Optional(Type.Integer({ minimum: 1 })),
          actor: Type.Optional(Type.String({ format: "uuid" })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
        }),
      },
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      if (!request.authUser?.isAdmin) {
        reply.code(403).send({ error: "FORBIDDEN", message: "Requires admin access." });
        return;
      }
      const { before, actor, limit = 100 } = request.query;
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
      reply.send({ entries: rows, nextBefore: rows.length === limit ? (rows.at(-1)?.id ?? null) : null });
    },
  );
};

export default auditRoutes;

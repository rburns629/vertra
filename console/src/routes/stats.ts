// SPDX-License-Identifier: MIT
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { countProducts, countSubmittedExecutions, countTeams, countUsers } from "../db/queries.js";

/**
 * Platform-wide counts for the admin home view -- admin-only, since a
 * non-admin's home view instead derives its own numbers from data it
 * already has to fetch anyway (Me.teamNames.length, the length of its own
 * already-scoped GET /executions result), never a reason to know the
 * platform-wide totals.
 */
const statsRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/stats", { preHandler: app.authenticate }, async (request, reply) => {
    if (!request.authUser?.isAdmin) {
      reply.code(403).send({ error: "FORBIDDEN", message: "Admin access required." });
      return;
    }
    const [teams, users, products, executions] = await Promise.all([
      countTeams(),
      countUsers(),
      countProducts(),
      countSubmittedExecutions(),
    ]);
    reply.send({ teams, users, products, executions });
  });
};

export default statsRoutes;

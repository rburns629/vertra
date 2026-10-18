// SPDX-License-Identifier: MIT
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { policySyncOutcomes, syncPolicies } from "../policySync.js";

/**
 * Whether the cluster's copies of the console's lists are current
 * (policySync.ts): the last outcome of each sync, and a way to run them now.
 * Admins only.
 */
const policySyncRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/policy-sync", { preHandler: app.authenticate }, async (request, reply) => {
    if (!request.authUser?.isAdmin) {
      reply.code(403).send({ error: "FORBIDDEN", message: "Requires admin access." });
      return;
    }
    reply.send(policySyncOutcomes());
  });

  app.post("/policy-sync", { preHandler: app.authenticate }, async (request, reply) => {
    if (!request.authUser?.isAdmin) {
      reply.code(403).send({ error: "FORBIDDEN", message: "Requires admin access." });
      return;
    }
    await syncPolicies(request.log);
    reply.send(policySyncOutcomes());
  });
};

export default policySyncRoutes;

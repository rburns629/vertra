// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { generateApiToken, hashApiToken } from "../auth/apiToken.js";
import { ScopeSchema } from "../auth/scopes.js";
import { createApiToken, createBotUser, listAutomationTokens } from "../db/queries.js";

/**
 * Automation tokens: API tokens that carry platform-wide scopes
 * (auth/scopes.ts) instead of team membership, e.g. catalog CI's single
 * token for creating teams and registering products. Admin-only to mint
 * and list; revoked through the same DELETE /tokens/:tokenId as team bots'
 * tokens (routes/bots.ts), which already lets an admin revoke any token.
 *
 * Each token gets its own bot account that belongs to no team, so the
 * scopes are the whole of what it can do. The raw token is returned once,
 * here, and never stored or shown again.
 */
const automationRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    "/automation-tokens",
    {
      schema: {
        body: Type.Object({
          label: Type.String({ minLength: 1, maxLength: 100 }),
          scopes: Type.Array(ScopeSchema, { minItems: 1, uniqueItems: true }),
        }),
      },
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      if (!request.authUser?.isAdmin) {
        reply.code(403).send({ error: "FORBIDDEN", message: "Admin access required." });
        return;
      }
      const bot = await createBotUser(`automation-${randomUUID().slice(0, 8)}@bot.internal`);
      const rawToken = generateApiToken();
      const tokenMeta = await createApiToken(
        bot.id,
        request.body.label,
        hashApiToken(rawToken),
        request.body.scopes,
      );
      request.log.info(
        { tokenId: tokenMeta.id, scopes: request.body.scopes, createdBy: request.authUser.id },
        "automation token created",
      );
      reply.code(201).send({
        tokenId: tokenMeta.id,
        label: tokenMeta.label,
        scopes: request.body.scopes,
        token: rawToken,
      });
    },
  );

  app.get("/automation-tokens", { preHandler: app.authenticate }, async (request, reply) => {
    if (!request.authUser?.isAdmin) {
      reply.code(403).send({ error: "FORBIDDEN", message: "Admin access required." });
      return;
    }
    reply.send(await listAutomationTokens());
  });
};

export default automationRoutes;

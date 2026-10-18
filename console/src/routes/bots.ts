// SPDX-License-Identifier: MIT
import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import {
  addTeamMember,
  createApiToken,
  createBotUser,
  findApiTokenById,
  findTeamByName,
  listBotsForTeam,
  revokeApiToken,
  teamNamesForUser,
} from "../db/queries.js";
import { generateApiToken, hashApiToken } from "../auth/apiToken.js";
import { replyIfRetired } from "./retiredTeam.js";
import { canActForTeam, replyIfNotTeamMember } from "../auth/access.js";

/**
 * Bot accounts (see db/schema.ts's users.isBot) and their API tokens --
 * how catalog CI authenticates to routes/products.ts without a human
 * doing an interactive login. Gated by the same team-membership check as
 * everything else team-scoped (add a member, register a secret): only a
 * member of the team (or an admin) can create a bot for it, see its
 * tokens, or revoke one.
 */
const botsRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    "/teams/:teamName/bots",
    {
      schema: {
        params: Type.Object({ teamName: Type.String() }),
        body: Type.Object({
          email: Type.String({ format: "email" }),
          label: Type.String({ minLength: 1 }),
        }),
      },
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      const authUser = request.authUser;
      if (replyIfNotTeamMember(authUser, request.params.teamName, reply)) return;
      const team = await findTeamByName(request.params.teamName);
      if (!team) {
        reply.code(404).send({ error: "NOT_FOUND", message: "No such team." });
        return;
      }
      if (replyIfRetired(team, reply)) return;

      const bot = await createBotUser(request.body.email);
      if (!bot.isBot) {
        reply.code(409).send({
          error: "CONFLICT",
          message: `"${request.body.email}" already belongs to a non-bot account.`,
        });
        return;
      }
      await addTeamMember(bot.id, team.id);

      const rawToken = generateApiToken();
      const tokenMeta = await createApiToken(bot.id, request.body.label, hashApiToken(rawToken));

      reply.code(201).send({
        email: bot.email,
        token: rawToken,
        tokenId: tokenMeta.id,
      });
    },
  );

  app.get(
    "/teams/:teamName/bots",
    {
      schema: { params: Type.Object({ teamName: Type.String() }) },
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      const authUser = request.authUser;
      if (replyIfNotTeamMember(authUser, request.params.teamName, reply)) return;
      const team = await findTeamByName(request.params.teamName);
      if (!team) {
        reply.code(404).send({ error: "NOT_FOUND", message: "No such team." });
        return;
      }
      reply.send(await listBotsForTeam(team.id));
    },
  );

  app.delete(
    "/tokens/:tokenId",
    {
      schema: { params: Type.Object({ tokenId: Type.String({ format: "uuid" }) }) },
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      const token = await findApiTokenById(request.params.tokenId);
      if (!token) {
        reply.code(404).send({ error: "NOT_FOUND", message: "No such token." });
        return;
      }
      const authUser = request.authUser;
      const ownerTeams = await teamNamesForUser(token.userId);
      // An admin may revoke any token, a bot in no team included.
      if (!authUser?.isAdmin && !ownerTeams.some((name) => canActForTeam(authUser, name))) {
        reply.code(403).send({
          error: "FORBIDDEN",
          message: "Not a member of any team this token's bot belongs to, and not a platform admin.",
        });
        return;
      }
      await revokeApiToken(token.id);
      reply.code(204).send();
    },
  );
};

export default botsRoutes;

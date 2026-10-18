// SPDX-License-Identifier: MIT
import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { hashPassword, NewPassword, verifyPassword } from "../auth/password.js";
import { findUserById, setUserPassword } from "../db/queries.js";

/**
 * The frontend's one read endpoint: who am I, and which teams am I in.
 * Exists because the JWT payload deliberately carries only `userId` (see
 * auth/plugin.ts) -- team membership is always looked up fresh, never
 * baked into the token -- so this is the only way a client finds out its
 * own current team memberships after logging in.
 */
const meRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/me", { preHandler: app.authenticate }, async (request, reply) => {
    const userId = request.authUser?.id;
    if (!userId) {
      reply.code(401).send({ error: "UNAUTHORIZED", message: "Missing or invalid token." });
      return;
    }
    const user = await findUserById(userId);
    if (!user) {
      // The token verified against a user id that no longer exists --
      // a deleted account outliving its own still-valid tokens, not a
      // caller mistake.
      reply.code(401).send({ error: "UNAUTHORIZED", message: "Account no longer exists." });
      return;
    }
    reply.send({
      id: user.id,
      email: user.email,
      teamNames: request.authUser?.teamNames ?? [],
      isAdmin: user.isAdmin,
    });
  });

  /**
   * Self-service password change. Requires the current password, so a
   * session left open on someone else's screen can't be used to take the
   * account over for good. Rate limited per user for the same reason
   * /auth/login is: this endpoint verifies a password too.
   *
   * Changing the password revokes every other session for this account
   * (see auth/plugin.ts), and the response carries a fresh token so the
   * caller's own session carries on.
   *
   * A wrong current password is a 400, not a 401: the frontend treats any
   * 401 as "your session is gone" and signs the user out.
   */
  app.post(
    "/me/password",
    {
      schema: {
        body: Type.Object({
          currentPassword: Type.String({ minLength: 1 }),
          newPassword: NewPassword,
        }),
      },
      preHandler: app.authenticate,
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "15 minutes",
          // preHandler hooks run after the route's own preHandler
          // (app.authenticate), so authUser is populated here.
          hook: "preHandler",
          keyGenerator: (request) => `password-change:${request.authUser?.id ?? request.ip}`,
        },
      },
    },
    async (request, reply) => {
      const userId = request.authUser?.id;
      const user = userId ? await findUserById(userId) : undefined;
      if (!user) {
        reply.code(401).send({ error: "UNAUTHORIZED", message: "Missing or invalid token." });
        return;
      }
      if (!user.passwordHash) {
        // Bot accounts authenticate with API tokens and have no password.
        reply.code(400).send({ error: "BAD_REQUEST", message: "This account has no password to change." });
        return;
      }
      const { currentPassword, newPassword } = request.body;
      if (!(await verifyPassword(user.passwordHash, currentPassword))) {
        reply.code(400).send({ error: "BAD_REQUEST", message: "Current password is incorrect." });
        return;
      }
      if (newPassword === currentPassword) {
        reply.code(400).send({
          error: "BAD_REQUEST",
          message: "New password must be different from the current one.",
        });
        return;
      }
      await setUserPassword(user.id, await hashPassword(newPassword));
      request.log.info({ userId: user.id }, "password changed");
      const token = await reply.jwtSign({ userId: user.id });
      reply.send({ token });
    },
  );
};

export default meRoutes;

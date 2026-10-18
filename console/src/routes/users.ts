// SPDX-License-Identifier: MIT
import { randomBytes } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { hashPassword, NewPassword } from "../auth/password.js";
import {
  addTeamMember,
  countAdmins,
  createUser,
  deleteUser,
  findTeamByName,
  findUserByEmail,
  listHumanUsersWithTeams,
  setUserAdmin,
  setUserPassword,
} from "../db/queries.js";

/**
 * Grants/revokes platform-admin status. Admin-only both ways -- deliberately
 * no self-service path (unlike team creation/membership), since admin is a
 * platform-wide capability, not something scoped to what the granter
 * already owns.
 */
const usersRoutes: FastifyPluginAsyncTypebox = async (app) => {
  /** Every human account and its teams, for the Admin page. */
  app.get("/users", { preHandler: app.authenticate }, async (request, reply) => {
    if (!request.authUser?.isAdmin) {
      reply.code(403).send({ error: "FORBIDDEN", message: "Admin access required." });
      return;
    }
    reply.send(await listHumanUsersWithTeams());
  });

  /**
   * How accounts are made while open registration is off (see config.ts):
   * an admin creates one, already in its teams, and gets back a temporary
   * password, shown exactly once (never stored or logged in the clear,
   * same as an API token). The admin hands it over out of band and the
   * user changes it after signing in (POST /me/password).
   */
  app.post(
    "/users",
    {
      schema: {
        body: Type.Object({
          email: Type.String({ format: "email" }),
          teams: Type.Array(Type.String({ minLength: 1 }), { maxItems: 50 }),
          admin: Type.Boolean(),
        }),
      },
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      if (!request.authUser?.isAdmin) {
        reply.code(403).send({ error: "FORBIDDEN", message: "Admin access required." });
        return;
      }
      const email = request.body.email.toLowerCase();
      if (await findUserByEmail(email)) {
        reply.code(409).send({ error: "CONFLICT", message: `An account for ${email} already exists.` });
        return;
      }
      // Every team checked before anything is created, so a typo can't
      // leave a half-made account behind.
      const teamIds: string[] = [];
      for (const name of [...new Set(request.body.teams)]) {
        const team = await findTeamByName(name);
        if (!team) {
          reply.code(400).send({ error: "BAD_REQUEST", message: `No team named "${name}".` });
          return;
        }
        if (team.retiredAt) {
          reply.code(409).send({ error: "TEAM_RETIRED", message: `Team "${name}" is retired, so nobody new can join it.` });
          return;
        }
        teamIds.push(team.id);
      }

      const temporaryPassword = randomBytes(18).toString("base64url");
      const user = await createUser(email, await hashPassword(temporaryPassword));
      for (const teamId of teamIds) await addTeamMember(user.id, teamId);
      if (request.body.admin) await setUserAdmin(user.id, true);
      request.log.warn(
        { event: "account_created", userId: user.id, by: request.authUser.id, teams: request.body.teams, admin: request.body.admin },
        "account created by admin",
      );
      reply.code(201).send({ email, temporaryPassword, teams: request.body.teams, admin: request.body.admin });
    },
  );

  /**
   * Deletes an account: its memberships and tokens go with it, but the
   * executions it submitted stay (their submitter shows as a deleted
   * account). Not for bots (revoke their tokens on the team page), not
   * your own account, and never the last admin.
   */
  app.delete(
    "/users/:email",
    {
      schema: { params: Type.Object({ email: Type.String({ format: "email" }) }) },
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      if (!request.authUser?.isAdmin) {
        reply.code(403).send({ error: "FORBIDDEN", message: "Admin access required." });
        return;
      }
      const user = await findUserByEmail(request.params.email.toLowerCase());
      if (!user) {
        reply.code(404).send({ error: "NOT_FOUND", message: "No such user." });
        return;
      }
      if (user.id === request.authUser.id) {
        reply.code(409).send({ error: "CONFLICT", message: "You can't delete your own account." });
        return;
      }
      if (user.isBot) {
        reply.code(400).send({ error: "BAD_REQUEST", message: "Bot accounts are managed on their team's page." });
        return;
      }
      if (user.isAdmin && (await countAdmins()) <= 1) {
        reply.code(409).send({ error: "CONFLICT", message: "Cannot delete the last remaining admin." });
        return;
      }
      await deleteUser(user.id);
      request.log.warn({ event: "account_deleted", userId: user.id, email: user.email, by: request.authUser.id }, "account deleted by admin");
      reply.code(204).send();
    },
  );

  app.post(
    "/users/:email/admin",
    {
      schema: { params: Type.Object({ email: Type.String({ format: "email" }) }) },
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      if (!request.authUser?.isAdmin) {
        reply.code(403).send({ error: "FORBIDDEN", message: "Admin access required." });
        return;
      }
      const user = await findUserByEmail(request.params.email);
      if (!user) {
        reply.code(404).send({ error: "NOT_FOUND", message: "No such user." });
        return;
      }
      await setUserAdmin(user.id, true);
      reply.code(204).send();
    },
  );

  app.delete(
    "/users/:email/admin",
    {
      schema: { params: Type.Object({ email: Type.String({ format: "email" }) }) },
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      if (!request.authUser?.isAdmin) {
        reply.code(403).send({ error: "FORBIDDEN", message: "Admin access required." });
        return;
      }
      const user = await findUserByEmail(request.params.email);
      if (!user) {
        reply.code(404).send({ error: "NOT_FOUND", message: "No such user." });
        return;
      }
      if (user.isAdmin && (await countAdmins()) <= 1) {
        // Refuse to create a state nobody can recover from -- with zero
        // admins left, there would be no one able to grant admin back.
        reply.code(409).send({
          error: "CONFLICT",
          message: "Cannot revoke the last remaining admin.",
        });
        return;
      }
      await setUserAdmin(user.id, false);
      reply.code(204).send();
    },
  );

  /**
   * Admin reset of another user's password, for a forgotten password
   * (there's no email-based reset flow). The admin passes the new password
   * on to the user out of band, and the user should then change it
   * themselves (POST /me/password). Every existing session for that user
   * is revoked (see auth/plugin.ts). Bots have no password to reset; they
   * use revocable API tokens instead (routes/bots.ts).
   */
  app.post(
    "/users/:email/password",
    {
      schema: {
        params: Type.Object({ email: Type.String({ format: "email" }) }),
        body: Type.Object({ newPassword: NewPassword }),
      },
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      if (!request.authUser?.isAdmin) {
        reply.code(403).send({ error: "FORBIDDEN", message: "Admin access required." });
        return;
      }
      const user = await findUserByEmail(request.params.email);
      if (!user) {
        reply.code(404).send({ error: "NOT_FOUND", message: "No such user." });
        return;
      }
      if (user.isBot) {
        reply.code(400).send({
          error: "BAD_REQUEST",
          message: "Bot accounts have no password -- revoke and reissue their API token instead.",
        });
        return;
      }
      await setUserPassword(user.id, await hashPassword(request.body.newPassword));
      request.log.info(
        { targetUserId: user.id, resetBy: request.authUser.id },
        "password reset by admin",
      );
      reply.code(204).send();
    },
  );
};

export default usersRoutes;

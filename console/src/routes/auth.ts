// SPDX-License-Identifier: MIT
import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { hashPassword, NewPassword, verifyAgainstNothing, verifyPassword } from "../auth/password.js";
import { loginWaitSeconds, recordLoginFailure, recordLoginSuccess } from "../auth/loginThrottle.js";
import { config } from "../config.js";
import { createUser, findUserByEmail } from "../db/queries.js";

// No length policy at login -- NewPassword (auth/password.ts) governs what
// a password may be when it's set, not what an existing one must be.
const LoginCredentials = Type.Object({
  email: Type.String({ format: "email" }),
  password: Type.String({ minLength: 1 }),
});

const RegisterCredentials = Type.Object({
  email: Type.String({ format: "email" }),
  password: NewPassword,
});

/**
 * Local email/password auth — deliberately the whole auth story for this
 * first slice, not the end state. SSO/SAML, when it's built, is an
 * additional authentication path into the *same* users/teams tables
 * (see db/schema.ts), not a replacement for this.
 *
 * /auth/register is closed unless ALLOW_SELF_REGISTRATION is on (see
 * config.ts): admins create accounts instead (routes/users.ts), with their
 * teams attached. Open registration has no email verification (no proof
 * the address is real), so it's only for a console behind a trusted
 * network boundary, never one on the open internet.
 *
 * Both routes are rate limited (in-memory, per replica -- fine at
 * replicaCount 1; more replicas would need @fastify/rate-limit's Redis
 * store for the limit to mean anything). Login is keyed on client IP *and*
 * email: per-IP alone would, behind a LoadBalancer that SNATs every client
 * to a node IP, turn into one global limit that a single attacker could
 * use to lock everyone out; per-email alone would let anyone lock a known
 * account (the admin) out indefinitely. Keyed on both, guessing one
 * account's password is capped at 10 tries per 15 minutes per source, and
 * the worst an attacker can do to someone else is a 15-minute lockout from
 * behind the same source IP. On GKE that needs the console's Service to
 * keep client IPs (externalTrafficPolicy: Local, helm/values/gke/console.yaml).
 *
 * Across sources, auth/loginThrottle.ts spaces out attempts on an account
 * that keeps failing, so many IPs don't multiply the guesses.
 */
const authRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    "/auth/register",
    {
      schema: { body: RegisterCredentials },
      config: { rateLimit: { max: 20, timeWindow: "1 hour" } },
    },
    async (request, reply) => {
      if (!config.allowSelfRegistration) {
        reply.code(403).send({
          error: "REGISTRATION_DISABLED",
          message: "Accounts are created by an admin. Ask an Acyclix admin for one.",
        });
        return;
      }
      const existing = await findUserByEmail(request.body.email);
      if (existing) {
        reply.code(409).send({ error: "CONFLICT", message: "Email already registered." });
        return;
      }
      const passwordHash = await hashPassword(request.body.password);
      const user = await createUser(request.body.email, passwordHash);
      reply.code(201).send({ id: user.id, email: user.email });
    },
  );

  app.post(
    "/auth/login",
    {
      schema: { body: LoginCredentials },
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "15 minutes",
          // preHandler, not the default onRequest: the body (and so the
          // email) isn't parsed yet at onRequest.
          hook: "preHandler",
          keyGenerator: (request) => {
            const body = request.body as { email?: unknown } | undefined;
            const email = typeof body?.email === "string" ? body.email.toLowerCase() : "";
            return `login:${request.ip}:${email}`;
          },
        },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body;
      // Refused before the password is checked, so this says nothing about it.
      const wait = loginWaitSeconds(email);
      if (wait > 0) {
        reply
          .code(429)
          .header("Retry-After", String(wait))
          .send({
            error: "TOO_MANY_ATTEMPTS",
            message: `Too many failed sign-ins for this account. Try again in ${String(wait)} seconds.`,
          });
        return;
      }
      const user = await findUserByEmail(email);
      // Same failure, and the same time taken, whether the email has no
      // account or the password is wrong: a missing account is still
      // checked against a throwaway hash, so neither the response nor its
      // timing tells a caller which emails exist.
      const valid = user?.passwordHash
        ? await verifyPassword(user.passwordHash, password)
        : await verifyAgainstNothing(password);
      if (!user || !valid) {
        recordLoginFailure(email);
        reply.code(401).send({ error: "UNAUTHORIZED", message: "Invalid email or password." });
        return;
      }
      recordLoginSuccess(email);
      const token = await reply.jwtSign({ userId: user.id });
      reply.send({ token });
    },
  );
};

export default authRoutes;

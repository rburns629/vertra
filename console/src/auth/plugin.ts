// SPDX-License-Identifier: MIT
import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { config } from "../config.js";
import { findApiTokenPrincipal, findUserById, teamNamesForUser, touchApiToken } from "../db/queries.js";
import { API_TOKEN_PREFIX, hashApiToken } from "./apiToken.js";

/** How stale an API token's "last used" time may get before a request
 * rewrites it: precise enough for "is anything still using this?". */
const TOKEN_USE_RESOLUTION_MS = 5 * 60 * 1000;

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { userId: string };
    // iat/exp are added by the signer, not by our own jwtSign call.
    user: { userId: string; iat: number; exp: number };
  }
}

declare module "fastify" {
  interface FastifyRequest {
    /** Populated by the `authenticate` preHandler — the caller's identity,
     * their *current* team memberships, and their platform-admin status,
     * looked up fresh from the database on every request (never baked
     * into the JWT itself), so a membership or role change takes effect
     * immediately rather than only once a stale token expires. `scopes`
     * is non-empty only for an automation API token (auth/scopes.ts). */
    authUser?: { id: string; teamNames: string[]; isAdmin: boolean; scopes: string[] };
  }
}

const authPlugin: FastifyPluginAsync = async (app) => {
  // jwtVerify() rejects an expired token on its own once `exp` is set.
  await app.register(fastifyJwt, { secret: config.jwtSecret, sign: { expiresIn: config.jwtTtl } });

  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    // Two credential shapes share this one preHandler: a human's session
    // JWT from /auth/login, or a bot's long-lived API token (see
    // db/schema.ts's apiTokens and routes/bots.ts) -- distinguished by the
    // token's own prefix so this never has to "try JWT, fall back on
    // failure." Whichever it is, everything past this point is identical:
    // one user id resolves into the same authUser shape, so every
    // downstream check (team membership, isAdmin) works the same either way.
    const header = request.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;

    let user;
    let scopes: string[] = [];
    if (bearer?.startsWith(API_TOKEN_PREFIX)) {
      const principal = await findApiTokenPrincipal(hashApiToken(bearer));
      user = principal?.user;
      scopes = principal?.scopes ?? [];
      if (
        principal &&
        (!principal.lastUsedAt || Date.now() - principal.lastUsedAt.getTime() > TOKEN_USE_RESOLUTION_MS)
      ) {
        await touchApiToken(principal.tokenId);
      }
    } else {
      try {
        await request.jwtVerify();
      } catch {
        reply.code(401).send({ error: "UNAUTHORIZED", message: "Missing or invalid token." });
        return;
      }
      user = await findUserById(request.user.userId);
      // A session issued before the user's last password change/reset is
      // revoked. `iat` only has one-second resolution, so compare in
      // whole seconds: the replacement token /me/password issues in the
      // same second as the change must still be accepted.
      if (
        user?.passwordChangedAt &&
        request.user.iat < Math.floor(user.passwordChangedAt.getTime() / 1000)
      ) {
        user = undefined;
      }
    }

    if (!user) {
      // Either credential shape can point at nothing real: a JWT whose
      // account was since deleted, or an API token that's invalid,
      // unrecognized, or revoked.
      reply
        .code(401)
        .send({ error: "UNAUTHORIZED", message: "Invalid, expired, or revoked credential." });
      return;
    }

    const teamNames = await teamNamesForUser(user.id);
    request.authUser = { id: user.id, teamNames, isAdmin: user.isAdmin, scopes };
  });
};

export default fp(authPlugin);

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

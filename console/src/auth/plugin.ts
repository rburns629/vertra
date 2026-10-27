// SPDX-License-Identifier: MIT
import { currentSso } from "../sso.js";
import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { findApiTokenPrincipal, findUserById, teamRolesForUser, touchApiToken } from "../db/queries.js";
import { API_TOKEN_PREFIX, hashApiToken } from "./apiToken.js";

/** How stale an API token's "last used" time may get before a request
 * rewrites it: precise enough for "is anything still using this?". */
const TOKEN_USE_RESOLUTION_MS = 5 * 60 * 1000;

declare module "@fastify/jwt" {
  interface FastifyJWT {
    // sso: made by single sign-on (auth/oidc.ts), not a password.
    payload: { userId: string; sso?: boolean };
    // iat/exp are added by the signer, not by our own jwtSign call.
    user: { userId: string; sso?: boolean; iat: number; exp: number };
  }
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set for a Connect call (rpc/server.ts) — the caller's identity,
     * their *current* team memberships, and their platform-admin status,
     * looked up fresh from the database on every request (never baked
     * into the JWT itself), so a membership or role change takes effect
     * immediately rather than only once a stale token expires. `scopes`
     * is non-empty only for an automation API token (auth/scopes.ts). */
    // teamNames: every team the caller is in; maintainerOf: the ones it
    // maintains (auth/access.ts).
    // mustChangePassword: a password session whose password someone else
    // set; it may only change it (rpc/interceptors.ts).
    authUser?: {
      id: string;
      teamNames: string[];
      maintainerOf: string[];
      isAdmin: boolean;
      scopes: string[];
      mustChangePassword?: boolean;
      // Set for an ordering bot's own request: the only templates it may
      // run (auth/access.ts's ensureMayOrder). Never for what the console
      // does as a bot (a schedule's runs, reviewed by its team).
      orderTemplates?: string[];
    };
  }
}

/**
 * The teams that make this person sign in with single sign-on, while it's
 * on: none for an admin (a way in if the provider fails), or for anyone
 * while it's off (nobody is locked out).
 */
export function ssoRequiredBy(user: { isAdmin: boolean }, roles: { name: string; requireSso: boolean }[]): string[] {
  if (!currentSso() || user.isAdmin) return [];
  return roles.filter((r) => r.requireSso).map((r) => r.name);
}

/** Who's calling, or why nobody is: a session JWT or an API token. */
export type AuthUser = NonNullable<FastifyRequest["authUser"]>;
export type CallerResolution = { authUser: AuthUser; problem?: undefined } | { authUser?: undefined; problem: string };

/**
 * Resolves the request's bearer credential into its caller, looked up fresh
 * from the database, for the Connect services (rpc/server.ts).
 *
 * Two credential shapes: a human's session JWT from signing in, or a bot's
 * long-lived API token (see db/schema.ts's apiTokens and core/tokens.ts),
 * told apart by the token's own prefix so this never has to "try JWT, fall
 * back on failure." Whichever it is, one user id resolves into the same
 * authUser shape, so every downstream check (team membership, isAdmin)
 * works the same either way.
 */
export async function resolveCaller(request: FastifyRequest): Promise<CallerResolution> {
  const header = request.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;

  let user;
  let scopes: string[] = [];
  // A session a password made (not single sign-on, not an API token).
  let passwordSession = false;
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
      return { problem: "Missing or invalid token." };
    }
    user = await findUserById(request.user.userId);
    passwordSession = request.user.sso !== true;
    // A session issued before the user's last password change/reset is
    // revoked. `iat` only has one-second resolution, so compare in
    // whole seconds: the replacement token a password change issues in
    // the same second must still be accepted.
    if (user?.passwordChangedAt && request.user.iat < Math.floor(user.passwordChangedAt.getTime() / 1000)) {
      user = undefined;
    }
  }

  if (!user) {
    // Either credential shape can point at nothing real: a JWT whose
    // account was since deleted, or an API token that's invalid,
    // unrecognized, or revoked.
    return { problem: "Invalid, expired, or revoked credential." };
  }
  const roles = await teamRolesForUser(user.id);
  // A password's session ends once one of the person's teams requires
  // single sign-on.
  if (passwordSession && ssoRequiredBy(user, roles).length > 0) {
    return { problem: "Your team signs in with single sign-on now: sign in again." };
  }
  const teamNames = roles.map((row) => row.name);
  const maintainerOf = roles.filter((row) => row.role === "maintainer").map((row) => row.name);
  const mustChangePassword = passwordSession && user.mustChangePassword;
  return {
    authUser: {
      id: user.id,
      teamNames,
      maintainerOf,
      isAdmin: user.isAdmin,
      scopes,
      mustChangePassword,
      ...(user.orderTemplates ? { orderTemplates: user.orderTemplates } : {}),
    },
  };
}

/**
 * A user as a caller, for what the console does as them (a schedule's bot):
 * their teams and roles as they are now, and no token scopes. Undefined
 * once the account is gone.
 */
export async function callerForUser(userId: string): Promise<AuthUser | undefined> {
  const user = await findUserById(userId);
  if (!user) return undefined;
  const roles = await teamRolesForUser(user.id);
  return {
    id: user.id,
    teamNames: roles.map((row) => row.name),
    maintainerOf: roles.filter((row) => row.role === "maintainer").map((row) => row.name),
    isAdmin: user.isAdmin,
    scopes: [],
    mustChangePassword: false,
  };
}

const authPlugin: FastifyPluginAsync = async (app) => {
  // jwtVerify() rejects an expired token on its own once `exp` is set.
  await app.register(fastifyJwt, { secret: config.jwtSecret, sign: { expiresIn: config.jwtTtl } });
};

export default fp(authPlugin);

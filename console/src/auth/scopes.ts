// SPDX-License-Identifier: MIT
/**
 * Platform-wide permissions an admin can grant to an automation token
 * (core/tokens.ts), in place of team membership.
 *
 * Why this exists: catalog CI used to authenticate as bots that were
 * *members* of teams. That meant one bot joined every team it created
 * (so one leaked token could register secrets and submit tasks for every
 * platform), and a second, per-platform bot had to be minted by hand for
 * product registration. An automation token instead holds exactly the
 * platform-level actions it needs and belongs to no team, so it can't
 * read a secret, submit a task, or mint other tokens.
 */
import { Type } from "@sinclair/typebox";

export const SCOPES = {
  /** Create a team (POST /teams), without becoming its member. */
  TEAMS_CREATE: "teams:create",
  /** Register, update, or delete any team's products (core/products.ts). */
  PRODUCTS_REGISTER: "products:register",
  /** Retire or un-retire a team (reversible): catalog CI, when a
   * team's folder is removed or restored. */
  TEAMS_RETIRE: "teams:retire",
  /** Purge a retired team (irreversible). Meant for its own token, held
   * only by the catalog's reviewer-gated purge workflow, never by the
   * everyday catalog CI token. */
  TEAMS_DELETE: "teams:delete",
  /** Apply a team's reviewed SecretStore file (PUT /teams/:team/secret-store):
   * the catalog's apply-secret-stores workflow. Never the team's own: a
   * SecretStore decides which vault identity a namespace can read, so it
   * goes through catalog review. */
  SECRET_STORES_APPLY: "secret-stores:apply",
} as const;

export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

export const ScopeSchema = Type.Union(Object.values(SCOPES).map((scope) => Type.Literal(scope)));

export function hasScope(authUser: { scopes: string[] } | undefined, scope: Scope): boolean {
  return authUser?.scopes.includes(scope) ?? false;
}

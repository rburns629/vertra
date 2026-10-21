// SPDX-License-Identifier: MIT
/**
 * Bots and their API tokens: the logic behind TokenService
 * (rpc/services/token.ts).
 *
 * A team's bot (db/schema.ts's users.isBot) acts as a member of that team:
 * only a member of the team (or an admin) can create one, see its tokens,
 * or revoke one. An automation token's bot belongs to no team; its scopes
 * (auth/scopes.ts) are the whole of what it can do, and only admins mint
 * or list them. Every raw token is returned once, here, and never stored
 * or shown again.
 */
import { Code } from "@connectrpc/connect";
import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { FastifyBaseLogger } from "fastify";
import { ApiError, forbiddenUnlessAdmin } from "../apiError.js";
import { canMaintainTeam, ensureTeamMaintainer } from "../auth/access.js";
import { generateApiToken, hashApiToken } from "../auth/apiToken.js";
import type { AuthUser } from "../auth/plugin.js";
import { ScopeSchema } from "../auth/scopes.js";
import {
  addTeamMember,
  createApiToken,
  createBotUser,
  findApiTokenById,
  findTeamByName,
  listAutomationTokens,
  listBotsForTeam,
  revokeApiToken,
  teamNamesForUser,
} from "../db/queries.js";
import { ensureNotRetired } from "./retired.js";

export const BotEmail = Type.String({ format: "email" });
export const TokenLabel = Type.String({ minLength: 1 });
export const AutomationLabel = Type.String({ minLength: 1, maxLength: 100 });
export const AutomationScopes = Type.Array(ScopeSchema, { minItems: 1, uniqueItems: true });
export const TokenId = Type.String({ format: "uuid" });

async function teamForMaintainer(caller: AuthUser | undefined, teamName: string) {
  ensureTeamMaintainer(caller, teamName);
  const team = await findTeamByName(teamName);
  if (!team) throw new ApiError(404, "NOT_FOUND", "No such team.");
  return team;
}

/** Creates a team's bot, or a new token for an existing one. */
export async function createBotToken(
  caller: AuthUser | undefined,
  teamName: string,
  input: { email: string; label: string },
) {
  const team = await teamForMaintainer(caller, teamName);
  ensureNotRetired(team);
  const bot = await createBotUser(input.email);
  if (!bot.isBot) {
    throw new ApiError(409, "CONFLICT", `"${input.email}" already belongs to a non-bot account.`, Code.AlreadyExists);
  }
  // A maintainer: a team's pipeline submits its raw DAGs and retries them.
  await addTeamMember(bot.id, team.id, "maintainer");
  const rawToken = generateApiToken();
  const tokenMeta = await createApiToken(bot.id, input.label, hashApiToken(rawToken));
  return { email: bot.email, token: rawToken, tokenId: tokenMeta.id };
}

export async function listBots(caller: AuthUser | undefined, teamName: string) {
  const team = await teamForMaintainer(caller, teamName);
  return listBotsForTeam(team.id);
}

/** A maintainer of a team the token's bot belongs to may revoke it; an admin, any. */
export async function revokeToken(caller: AuthUser | undefined, tokenId: string): Promise<void> {
  const token = await findApiTokenById(tokenId);
  if (!token) throw new ApiError(404, "NOT_FOUND", "No such token.");
  const ownerTeams = await teamNamesForUser(token.userId);
  // An admin may revoke any token, a bot in no team included.
  if (!caller?.isAdmin && !ownerTeams.some((name) => canMaintainTeam(caller, name))) {
    throw new ApiError(
      403,
      "FORBIDDEN",
      "Not a maintainer of any team this token's bot belongs to, and not a platform admin.",
    );
  }
  await revokeApiToken(token.id);
}

/** For platform automation such as the catalog's CI. Admins only. */
export async function createAutomationToken(
  caller: AuthUser | undefined,
  input: { label: string; scopes: string[] },
  log: FastifyBaseLogger | undefined,
) {
  forbiddenUnlessAdmin(caller);
  const bot = await createBotUser(`automation-${randomUUID().slice(0, 8)}@bot.internal`);
  const rawToken = generateApiToken();
  const tokenMeta = await createApiToken(bot.id, input.label, hashApiToken(rawToken), input.scopes);
  log?.info({ tokenId: tokenMeta.id, scopes: input.scopes, createdBy: caller?.id }, "automation token created");
  return { tokenId: tokenMeta.id, label: tokenMeta.label, scopes: input.scopes, token: rawToken };
}

export async function listAutomationTokensFor(caller: AuthUser | undefined) {
  forbiddenUnlessAdmin(caller);
  return listAutomationTokens();
}

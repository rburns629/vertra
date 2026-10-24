// SPDX-License-Identifier: MIT
/** TokenService (proto/vertra/console/v1/token.proto): core/tokens.ts over Connect. */
import type { ServiceImpl } from "@connectrpc/connect";
import { Type } from "@sinclair/typebox";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  AutomationLabel,
  AutomationScopes,
  BotEmail,
  createAutomationToken,
  createBotToken,
  listAutomationTokensFor,
  listBots,
  revokeToken,
  TokenId,
  TokenLabel,
} from "../../core/tokens.js";
import { addBotIdentity, listBotIdentities, removeBotIdentity } from "../../core/botIdentities.js";
import type { TokenService } from "../../gen/vertra/console/v1/token_pb.js";
import { callerOf, logOf } from "../context.js";
import { check } from "../validate.js";

const TeamName = Type.String({ minLength: 1 });
const optionalTime = (date: Date | null) => (date ? timestampFromDate(date) : undefined);

type IdentityRow = Awaited<ReturnType<typeof addBotIdentity>>;
const identity = (r: IdentityRow) => ({
  id: r.id,
  botId: r.botId,
  botEmail: r.botEmail,
  issuer: r.issuer,
  claims: r.claims,
  createdAt: timestampFromDate(r.createdAt),
  lastUsedAt: optionalTime(r.lastUsedAt),
});

export function tokenService(): ServiceImpl<typeof TokenService> {
  return {
    async listBotIdentities(req, ctx) {
      const { team } = check({ team: TeamName }, req);
      const found = await listBotIdentities(callerOf(ctx), team);
      return { identities: found.identities.map(identity), issuers: found.issuers, audience: found.audience };
    },

    async addBotIdentity(req, ctx) {
      const { team, botId, issuer } = check(
        { team: TeamName, botId: Type.String({ format: "uuid" }), issuer: Type.String({ minLength: 1, maxLength: 300 }) },
        { team: req.team, botId: req.botId, issuer: req.issuer },
      );
      return { identity: identity(await addBotIdentity(callerOf(ctx), team, botId, issuer, { ...req.claims })) };
    },

    async removeBotIdentity(req, ctx) {
      const { id } = check({ id: Type.String({ format: "uuid" }) }, req);
      await removeBotIdentity(callerOf(ctx), id);
      return {};
    },

    async listBots(req, ctx) {
      const { team } = check({ team: TeamName }, req);
      const bots = await listBots(callerOf(ctx), team);
      return {
        bots: bots.map((bot) => ({
          id: bot.id,
          email: bot.email,
          tokens: bot.tokens.map((token) => ({
            id: token.id,
            label: token.label,
            createdAt: timestampFromDate(token.createdAt),
            lastUsedAt: optionalTime(token.lastUsedAt),
          })),
        })),
      };
    },

    async createBotToken(req, ctx) {
      const { team, email, label } = check({ team: TeamName, email: BotEmail, label: TokenLabel }, req);
      return createBotToken(callerOf(ctx), team, { email, label });
    },

    async revokeToken(req, ctx) {
      const { tokenId } = check({ tokenId: TokenId }, req);
      await revokeToken(callerOf(ctx), tokenId);
      return {};
    },

    async listAutomationTokens(_req, ctx) {
      const tokens = await listAutomationTokensFor(callerOf(ctx));
      return {
        tokens: tokens.map((token) => ({
          id: token.id,
          label: token.label,
          createdAt: timestampFromDate(token.createdAt),
          lastUsedAt: optionalTime(token.lastUsedAt),
          scopes: token.scopes,
          botEmail: token.botEmail,
        })),
      };
    },

    async createAutomationToken(req, ctx) {
      const input = check({ label: AutomationLabel, scopes: AutomationScopes }, req);
      return createAutomationToken(callerOf(ctx), input, logOf(ctx));
    },
  };
}

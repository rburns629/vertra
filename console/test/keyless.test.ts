// SPDX-License-Identifier: MIT
/**
 * Keyless bots (src/auth/keyless.ts, src/core/botIdentities.ts): who sets a
 * bot's identities and what's refused (an issuer the install doesn't
 * allow, nothing identifying, a pattern, another team's bot); a CI's ID
 * token for this install signs in as exactly one bot, and the session it
 * gets works; a wrong audience, an expired or forged token, other claims,
 * or an issuer not allowed (whose keys are never fetched) are refused. A
 * test issuer's discovery document and keys are served by a stubbed fetch.
 */
import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";
import { db } from "../src/db/client.js";
import { addTeamMember, createTeam } from "../src/db/queries.js";
import { botIdentities, teams, users as usersTable } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { caller, rpcClient } from "./rpc.js";

const prefix = `kls-${randomUUID().slice(0, 6)}`;
const team = `${prefix}-team`;
const other = `${prefix}-other`;
const ISSUER = `https://ci-${prefix}.example.test`;
const AUDIENCE = `vertra-${prefix}`;
const SUBJECT = "repo:acme/app:ref:refs/heads/main";

let app: FastifyInstance;
const users = rpcClient(() => app);
const call = caller(() => app);
let maintainerToken: string;
let memberToken: string;
let bot: { id: string; email: string };
let otherBot: { id: string; email: string };
let sign: (claims: Record<string, unknown>, options?: { issuer?: string; audience?: string; expires?: string; forged?: boolean }) => Promise<string>;
const fetched: string[] = [];

beforeAll(async () => {
  app = await buildApp();
  config.keyless.issuers = [...config.keyless.issuers, ISSUER];
  config.keyless.audience = AUDIENCE;
  const keys = await generateKeyPair("RS256");
  const forger = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    fetched.push(url);
    if (url === `${ISSUER}/.well-known/openid-configuration`) return Promise.resolve(Response.json({ issuer: ISSUER, jwks_uri: `${ISSUER}/keys` }));
    if (url === `${ISSUER}/keys`) return Promise.resolve(Response.json({ keys: [jwk] }));
    return realFetch(input, init);
  });
  sign = async (claims, options = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(options.issuer ?? ISSUER)
      .setAudience(options.audience ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(options.expires ?? "5m")
      .sign(options.forged ? forger.privateKey : keys.privateKey);

  const teamId = (await createTeam(team)).id;
  const otherId = (await createTeam(other)).id;
  const maintainer = await users.makeUser();
  const member = await users.makeUser();
  bot = await users.makeUser();
  otherBot = await users.makeUser();
  await db.update(usersTable).set({ isBot: true }).where(eq(usersTable.id, bot.id));
  await db.update(usersTable).set({ isBot: true }).where(eq(usersTable.id, otherBot.id));
  await addTeamMember(maintainer.id, teamId, "maintainer");
  await addTeamMember(member.id, teamId, "member");
  await addTeamMember(bot.id, teamId, "maintainer");
  await addTeamMember(otherBot.id, otherId, "maintainer");
  [maintainerToken, memberToken] = await Promise.all([maintainer, member].map((u) => users.signIn(u.email)));
});

beforeEach(() => {
  fetched.length = 0;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await users.cleanUp();
  await app.close();
});

const add = (token: string, body: object) => call<{ identity?: { id: string } }>(token, "TokenService/AddBotIdentity", { team, botId: bot.id, issuer: ISSUER, ...body });
const exchange = (idToken: string) => call<{ token?: string; email?: string }>(undefined, "AuthService/ExchangeToken", { idToken });

describe("a bot's identities", () => {
  it("are its team's maintainers' to set, exact, identifying, and from an allowed issuer", async () => {
    expect((await add(memberToken, { claims: { sub: SUBJECT } })).code).toBe("permission_denied");
    for (const [body, why] of [
      [{ issuer: "https://elsewhere.example", claims: { sub: SUBJECT } }, /only sign in through/],
      [{ claims: { ref: "refs/heads/main" } }, /Name one of sub/],
      [{ claims: { sub: "repo:acme/*" } }, /no patterns/],
      [{ claims: { sub: SUBJECT, aud: "x" } }, /aud is checked already/],
      [{ botId: otherBot.id, claims: { sub: SUBJECT } }, /isn't one of team/],
    ] as const) {
      const refused = await add(maintainerToken, body);
      expect(refused.failure).toBe("BAD_IDENTITY");
      expect(refused.message).toMatch(why);
    }
    expect((await add(maintainerToken, { claims: { sub: SUBJECT } })).code).toBe("ok");
    expect((await add(maintainerToken, { claims: { sub: SUBJECT } })).code).toBe("already_exists");
    const listed = await call<{ identities?: unknown[]; audience?: string }>(memberToken, "TokenService/ListBotIdentities", { team });
    expect(listed.body).toMatchObject({ audience: AUDIENCE, identities: [{ issuer: ISSUER, claims: { sub: SUBJECT }, botEmail: bot.email }] });
  });
});

describe("signing in with a CI's token", () => {
  it("gives an hour's session as the one bot it names, which works", async () => {
    const signedIn = await exchange(await sign({ sub: SUBJECT, repository: "acme/app" }));
    expect(signedIn.code).toBe("ok");
    expect(signedIn.body.email).toBe(bot.email);
    const me = await call<{ email?: string }>(signedIn.body.token, "AuthService/GetMe");
    expect(me.body.email).toBe(bot.email);
    const [row] = await db.select().from(botIdentities).where(eq(botIdentities.botId, bot.id));
    expect(row?.lastUsedAt).not.toBeNull();
  });

  it("is refused for another audience, an expired or forged token, or other claims", async () => {
    for (const token of [
      await sign({ sub: SUBJECT }, { audience: "someone-else" }),
      await sign({ sub: SUBJECT, iat: Math.floor(Date.now() / 1000) - 7200 }, { expires: "1h ago" }),
      await sign({ sub: SUBJECT }, { forged: true }),
      await sign({ sub: "repo:acme/app:ref:refs/heads/feature" }),
      "not a token",
    ]) {
      const refused = await exchange(token);
      expect(refused.code).toBe("unauthenticated");
      expect(refused.failure).toBe("KEYLESS_REFUSED");
    }
  });

  it("never fetches the keys of an issuer the install doesn't allow", async () => {
    const refused = await exchange(await sign({ sub: SUBJECT }, { issuer: "https://evil.example" }));
    expect(refused.failure).toBe("KEYLESS_REFUSED");
    expect(fetched.filter((url) => url.startsWith("https://evil.example"))).toEqual([]);
  });

  it("stops once the identity is removed", async () => {
    const [row] = await db.select().from(botIdentities).where(eq(botIdentities.botId, bot.id));
    expect((await call(memberToken, "TokenService/RemoveBotIdentity", { id: row?.id })).code).toBe("permission_denied");
    expect((await call(maintainerToken, "TokenService/RemoveBotIdentity", { id: row?.id })).code).toBe("ok");
    expect((await exchange(await sign({ sub: SUBJECT }))).failure).toBe("KEYLESS_REFUSED");
  });
});

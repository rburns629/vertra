// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/password.js";
import { db } from "../src/db/client.js";
import { createUser, setUserAdmin } from "../src/db/queries.js";
import { apiTokens, products, teams, users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { caller } from "./rpc.js";

let app: FastifyInstance;
let adminToken: string;
let memberToken: string;
const emails: string[] = [];
const prefix = `auto-${randomUUID().slice(0, 6)}`;

async function sessionFor(options: { admin: boolean }): Promise<string> {
  const email = `${prefix}-${randomUUID()}@example.com`;
  emails.push(email);
  const user = await createUser(email, await hashPassword("correct-horse-battery"));
  if (options.admin) await setUserAdmin(user.id, true);
  return app.jwt.sign({ userId: user.id });
}

const call = caller(() => app);

async function mint(scopes: string[]): Promise<{ token: string; tokenId: string }> {
  const minted = await call<{ token: string; tokenId: string }>(adminToken, "TokenService/CreateAutomationToken", {
    label: "test",
    scopes,
  });
  expect(minted.code).toBe("ok");
  return minted.body;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  adminToken = await sessionFor({ admin: true });
  memberToken = await sessionFor({ admin: false });
});

afterAll(async () => {
  await app.close();
  await db.delete(products).where(like(products.name, `${prefix}%`));
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await db.delete(users).where(inArray(users.email, emails));
});

describe("team creation", () => {
  it("is refused for an ordinary signed-in user", async () => {
    expect((await call(memberToken, "TeamService/CreateTeam", { name: `${prefix}-a` })).code).toBe("permission_denied");
  });

  it("is allowed for an admin, who does not become a member of the new team", async () => {
    const name = `${prefix}-b`;
    expect((await call(adminToken, "TeamService/CreateTeam", { name })).code).toBe("ok");
    const members = await call<{ members: unknown[] }>(adminToken, "TeamService/ListMembers", { team: name });
    expect(members.body.members).toEqual([]);
  });

  it("is allowed for an automation token with teams:create, which also doesn't join", async () => {
    const { token } = await mint(["teams:create"]);
    const name = `${prefix}-c`;
    expect((await call(token, "TeamService/CreateTeam", { name })).code).toBe("ok");
    // Not a member, so it can't see or act inside the team it created.
    expect((await call(token, "TokenService/ListBots", { team: name })).code).toBe("permission_denied");
    expect((await call(token, "TeamService/ListMembers", { team: name })).code).toBe("permission_denied");
  });
});

describe("automation tokens", () => {
  it("can only be minted and listed by an admin", async () => {
    const minted = await call(memberToken, "TokenService/CreateAutomationToken", { label: "x", scopes: ["teams:create"] });
    expect(minted.code).toBe("permission_denied");
    expect((await call(memberToken, "TokenService/ListAutomationTokens")).code).toBe("permission_denied");
  });

  it("rejects unknown scopes and an empty scope list", async () => {
    for (const scopes of [["secrets:read"], []]) {
      expect((await call(adminToken, "TokenService/CreateAutomationToken", { label: "x", scopes })).code).toBe("invalid_argument");
    }
  });

  it("registers any team's product with products:register, and nothing more", async () => {
    const team = `${prefix}-d`;
    await call(adminToken, "TeamService/CreateTeam", { name: team });
    const { token } = await mint(["products:register"]);

    const registered = await call(token, "ProductService/RegisterProduct", {
      name: `${prefix}-product`,
      image: `example/${prefix}:1`,
      action: "create",
      team,
    });
    expect(registered.code).toBe("ok");

    // No teams:create, no team membership: everything else stays closed.
    expect((await call(token, "TeamService/CreateTeam", { name: `${prefix}-e` })).code).toBe("permission_denied");
    const bot = await call(token, "TokenService/CreateBotToken", { team, email: "x@bot.internal", label: "x" });
    expect(bot.code).toBe("permission_denied");
    const submit = await call(token, "ExecutionService/SubmitExecution", {
      dag: {
        name: "x",
        requestId: `x-${randomUUID()}`,
        tasks: [{ id: "t", image: "i", action: "a", team, serviceAccount: "default" }],
      },
    });
    expect(submit.code).toBe("permission_denied");
  });

  it("shows up in the admin listing, and stops working once revoked", async () => {
    const { token, tokenId } = await mint(["teams:create"]);
    const listing = await call<{ tokens: { id: string }[] }>(adminToken, "TokenService/ListAutomationTokens");
    expect(listing.body.tokens.some((t) => t.id === tokenId)).toBe(true);

    expect((await call(adminToken, "TokenService/RevokeToken", { tokenId })).code).toBe("ok");
    expect((await call(token, "TeamService/CreateTeam", { name: `${prefix}-f` })).code).toBe("unauthenticated");
  });
});

describe("token expiry", () => {
  it("lasts 90 days unless asked otherwise; 0 lasts until revoked", async () => {
    const byDefault = await mint(["teams:create"]);
    const forever = await call<{ tokenId: string }>(adminToken, "TokenService/CreateAutomationToken", {
      label: "forever",
      scopes: ["teams:create"],
      expiresInDays: 0,
    });
    expect(forever.code).toBe("ok");
    const [a] = await db.select().from(apiTokens).where(eq(apiTokens.id, byDefault.tokenId));
    const [b] = await db.select().from(apiTokens).where(eq(apiTokens.id, forever.body.tokenId));
    const days = ((a?.expiresAt?.getTime() ?? 0) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThanOrEqual(90);
    expect(b?.expiresAt).toBeNull();
  });

  it("refuses a lifetime over two years", async () => {
    const minted = await call(adminToken, "TokenService/CreateAutomationToken", { label: "x", scopes: ["teams:create"], expiresInDays: 731 });
    expect(minted.code).toBe("invalid_argument");
  });

  it("authenticates nothing once expired", async () => {
    const { token, tokenId } = await mint(["teams:create"]);
    expect((await call(token, "TeamService/CreateTeam", { name: `${prefix}-e1` })).code).toBe("ok");
    await db.update(apiTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(apiTokens.id, tokenId));
    expect((await call(token, "TeamService/CreateTeam", { name: `${prefix}-e2` })).code).toBe("unauthenticated");
  });
});

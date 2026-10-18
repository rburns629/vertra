// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/password.js";
import { db } from "../src/db/client.js";
import { createUser, setUserAdmin } from "../src/db/queries.js";
import { products, teams, users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";

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

function as(token: string, method: "GET" | "POST" | "DELETE", url: string, payload?: object) {
  return app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
}

async function mint(scopes: string[]): Promise<{ token: string; tokenId: string }> {
  const response = await as(adminToken, "POST", "/api/automation-tokens", { label: "test", scopes });
  expect(response.statusCode).toBe(201);
  return response.json();
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
    const response = await as(memberToken, "POST", "/api/teams", { name: `${prefix}-a` });
    expect(response.statusCode).toBe(403);
  });

  it("is allowed for an admin, who does not become a member of the new team", async () => {
    const name = `${prefix}-b`;
    expect((await as(adminToken, "POST", "/api/teams", { name })).statusCode).toBe(201);
    const members = await as(adminToken, "GET", `/api/teams/${name}/members`);
    expect(members.json()).toEqual([]);
  });

  it("is allowed for an automation token with teams:create, which also doesn't join", async () => {
    const { token } = await mint(["teams:create"]);
    const name = `${prefix}-c`;
    expect((await as(token, "POST", "/api/teams", { name })).statusCode).toBe(201);
    // Not a member, so it can't see or act inside the team it created.
    expect((await as(token, "GET", `/api/teams/${name}/bots`)).statusCode).toBe(403);
    expect((await as(token, "GET", `/api/teams/${name}/members`)).statusCode).toBe(403);
  });
});

describe("automation tokens", () => {
  it("can only be minted and listed by an admin", async () => {
    const minted = await as(memberToken, "POST", "/api/automation-tokens", {
      label: "x",
      scopes: ["teams:create"],
    });
    expect(minted.statusCode).toBe(403);
    expect((await as(memberToken, "GET", "/api/automation-tokens")).statusCode).toBe(403);
  });

  it("rejects unknown scopes and an empty scope list", async () => {
    for (const scopes of [["secrets:read"], []]) {
      const response = await as(adminToken, "POST", "/api/automation-tokens", { label: "x", scopes });
      expect(response.statusCode).toBe(400);
    }
  });

  it("registers any team's product with products:register, and nothing more", async () => {
    const team = `${prefix}-d`;
    await as(adminToken, "POST", "/api/teams", { name: team });
    const { token } = await mint(["products:register"]);

    const registered = await as(token, "POST", "/api/products", {
      name: `${prefix}-product`,
      image: `example/${prefix}:1`,
      action: "create",
      team,
    });
    expect(registered.statusCode).toBe(200);

    // No teams:create, no team membership: everything else stays closed.
    expect((await as(token, "POST", "/api/teams", { name: `${prefix}-e` })).statusCode).toBe(403);
    expect((await as(token, "POST", `/api/teams/${team}/bots`, { email: "x@bot.internal", label: "x" })).statusCode).toBe(403);
    const submit = await as(token, "POST", "/api/executions", {
      name: "x",
      requestId: `x-${randomUUID()}`,
      tasks: [{ id: "t", image: "i", action: "a", team, serviceAccount: "default" }],
    });
    expect(submit.statusCode).toBe(403);
  });

  it("shows up in the admin listing, and stops working once revoked", async () => {
    const { token, tokenId } = await mint(["teams:create"]);
    const listing = await as(adminToken, "GET", "/api/automation-tokens");
    expect(listing.json<{ id: string }[]>().some((t) => t.id === tokenId)).toBe(true);

    expect((await as(adminToken, "DELETE", `/api/tokens/${tokenId}`)).statusCode).toBe(204);
    expect((await as(token, "POST", "/api/teams", { name: `${prefix}-f` })).statusCode).toBe(401);
  });
});

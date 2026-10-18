// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/password.js";
import { db } from "../src/db/client.js";
import { addTeamMember, createTeam, createUser, setTeamRetired, setUserAdmin } from "../src/db/queries.js";
import { teams, users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";

const prefix = `mem-${randomUUID().slice(0, 6)}`;
const emails: string[] = [];
let app: FastifyInstance;
let admin: string;

async function newUser(options: { admin?: boolean } = {}): Promise<{ id: string; token: string }> {
  const email = `${prefix}-${randomUUID()}@example.com`;
  emails.push(email);
  const user = await createUser(email, await hashPassword("correct-horse-battery"));
  if (options.admin) await setUserAdmin(user.id, true);
  return { id: user.id, token: app.jwt.sign({ userId: user.id }) };
}

function as(token: string, method: "GET" | "POST" | "DELETE", url: string, payload?: object) {
  return app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
}

/** A team with two human members. */
async function teamOfTwo() {
  const name = `${prefix}-${randomUUID().slice(0, 6)}`;
  const team = await createTeam(name);
  const first = await newUser();
  const second = await newUser();
  await addTeamMember(first.id, team.id);
  await addTeamMember(second.id, team.id);
  return { name, teamId: team.id, first, second };
}

async function memberIds(name: string): Promise<string[]> {
  const response = await as(admin, "GET", `/api/teams/${name}/members`);
  return response.json<{ id: string }[]>().map((m) => m.id);
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  admin = (await newUser({ admin: true })).token;
});

afterAll(async () => {
  await app.close();
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await db.delete(users).where(inArray(users.email, emails));
});

describe("removing a team member", () => {
  it("is refused to someone outside the team", async () => {
    const t = await teamOfTwo();
    const outsider = await newUser();
    const response = await as(outsider.token, "DELETE", `/api/teams/${t.name}/members/${t.second.id}`);
    expect(response.statusCode).toBe(403);
    expect(await memberIds(t.name)).toContain(t.second.id);
  });

  it("lets a member remove another member, who then loses access", async () => {
    const t = await teamOfTwo();
    const response = await as(t.first.token, "DELETE", `/api/teams/${t.name}/members/${t.second.id}`);
    expect(response.statusCode).toBe(204);
    expect(await memberIds(t.name)).not.toContain(t.second.id);
    expect((await as(t.second.token, "GET", `/api/teams/${t.name}/members`)).statusCode).toBe(403);
  });

  it("never removes the last person, but a bot can always go", async () => {
    const t = await teamOfTwo();
    await as(t.first.token, "DELETE", `/api/teams/${t.name}/members/${t.second.id}`);
    const bot = await as(t.first.token, "POST", `/api/teams/${t.name}/bots`, {
      email: `${t.name}-bot@bot.internal`,
      label: "ci",
    });
    emails.push(`${t.name}-bot@bot.internal`);
    expect(bot.statusCode).toBe(201);

    const last = await as(admin, "DELETE", `/api/teams/${t.name}/members/${t.first.id}`);
    expect(last.statusCode).toBe(409);
    expect(last.json<{ error: string }>().error).toBe("LAST_MEMBER");

    const botId = (await as(admin, "GET", `/api/teams/${t.name}/members`))
      .json<{ id: string; isBot: boolean }[]>()
      .find((m) => m.isBot)?.id;
    expect((await as(t.first.token, "DELETE", `/api/teams/${t.name}/members/${botId ?? ""}`)).statusCode).toBe(204);
  });

  it("is refused on a retired team", async () => {
    const t = await teamOfTwo();
    await setTeamRetired(t.teamId, true);
    const response = await as(admin, "DELETE", `/api/teams/${t.name}/members/${t.second.id}`);
    expect(response.statusCode).toBe(409);
    expect(await memberIds(t.name)).toContain(t.second.id);
  });
});

describe("a bot token's last use", () => {
  it("is empty until the token is used, then recorded", async () => {
    const t = await teamOfTwo();
    const created = await as(t.first.token, "POST", `/api/teams/${t.name}/bots`, {
      email: `${t.name}-ci@bot.internal`,
      label: "ci",
    });
    emails.push(`${t.name}-ci@bot.internal`);
    const botToken = created.json<{ token: string }>().token;

    const lastUsed = async () =>
      (await as(t.first.token, "GET", `/api/teams/${t.name}/bots`)).json<
        { tokens: { lastUsedAt: string | null }[] }[]
      >()[0]?.tokens[0]?.lastUsedAt;

    expect(await lastUsed()).toBeNull();
    expect((await as(botToken, "GET", `/api/teams/${t.name}/members`)).statusCode).toBe(200);
    expect(await lastUsed()).not.toBeNull();
  });
});

describe("what a team's outsiders learn", () => {
  it("can't read a team's record, whether or not it exists", async () => {
    const t = await teamOfTwo();
    const outsider = await newUser();
    const existing = await as(outsider.token, "GET", `/api/teams/${t.name}`);
    const missing = await as(outsider.token, "GET", `/api/teams/${prefix}-no-such-team`);
    expect(existing.statusCode).toBe(404);
    expect(existing.json()).toEqual(missing.json());
    expect((await as(t.first.token, "GET", `/api/teams/${t.name}`)).statusCode).toBe(200);
    expect((await as(admin, "GET", `/api/teams/${t.name}`)).statusCode).toBe(200);
  });
});

describe("adding a team member", () => {
  it("is refused for a retired team", async () => {
    const t = await teamOfTwo();
    await setTeamRetired(t.teamId, true);
    const newcomer = await newUser();
    const email = emails[emails.length - 1];
    const response = await as(admin, "POST", `/api/teams/${t.name}/members`, { email });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toBe("TEAM_RETIRED");
    expect(await memberIds(t.name)).not.toContain(newcomer.id);
  });

  it("is limited per caller, so emails can't be swept", async () => {
    const t = await teamOfTwo();
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      const response = await as(t.first.token, "POST", `/api/teams/${t.name}/members`, { email: `${prefix}-nobody-${i}@example.com` });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 30).every((s) => s === 404)).toBe(true);
    expect(statuses[30]).toBe(429);
    // Someone else's limit is their own.
    const other = await as(t.second.token, "POST", `/api/teams/${t.name}/members`, { email: `${prefix}-nobody@example.com` });
    expect(other.statusCode).toBe(404);
  });
});

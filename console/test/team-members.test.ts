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
import { caller } from "./rpc.js";

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

const call = caller(() => app);
const remove = (token: string, team: string, userId: string) => call(token, "TeamService/RemoveMember", { team, userId });
const listMembers = (token: string, team: string) =>
  call<{ members: { id: string; isBot: boolean }[] }>(token, "TeamService/ListMembers", { team });

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
  return (await listMembers(admin, name)).body.members.map((m) => m.id);
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
    expect((await remove(outsider.token, t.name, t.second.id)).code).toBe("permission_denied");
    expect(await memberIds(t.name)).toContain(t.second.id);
  });

  it("lets a member remove another member, who then loses access", async () => {
    const t = await teamOfTwo();
    expect((await remove(t.first.token, t.name, t.second.id)).code).toBe("ok");
    expect(await memberIds(t.name)).not.toContain(t.second.id);
    expect((await listMembers(t.second.token, t.name)).code).toBe("permission_denied");
  });

  it("never removes the last person, but a bot can always go", async () => {
    const t = await teamOfTwo();
    await remove(t.first.token, t.name, t.second.id);
    const bot = await call(t.first.token, "TokenService/CreateBotToken", {
      team: t.name,
      email: `${t.name}-bot@bot.internal`,
      label: "ci",
    });
    emails.push(`${t.name}-bot@bot.internal`);
    expect(bot.code).toBe("ok");

    const last = await remove(admin, t.name, t.first.id);
    expect(last.code).toBe("failed_precondition");
    expect(last.failure).toBe("LAST_MEMBER");

    const botId = (await listMembers(admin, t.name)).body.members.find((m) => m.isBot)?.id;
    expect((await remove(t.first.token, t.name, botId ?? "")).code).toBe("ok");
  });

  it("is refused on a retired team", async () => {
    const t = await teamOfTwo();
    await setTeamRetired(t.teamId, true);
    expect((await remove(admin, t.name, t.second.id)).code).toBe("failed_precondition");
    expect(await memberIds(t.name)).toContain(t.second.id);
  });
});

describe("a bot token's last use", () => {
  it("is empty until the token is used, then recorded", async () => {
    const t = await teamOfTwo();
    const created = await call<{ token: string }>(t.first.token, "TokenService/CreateBotToken", {
      team: t.name,
      email: `${t.name}-ci@bot.internal`,
      label: "ci",
    });
    emails.push(`${t.name}-ci@bot.internal`);
    const botToken = created.body.token;

    const lastUsed = async () =>
      (await call<{ bots: { tokens: { lastUsedAt?: string }[] }[] }>(t.first.token, "TokenService/ListBots", { team: t.name }))
        .body.bots[0]?.tokens[0]?.lastUsedAt;

    expect(await lastUsed()).toBeUndefined();
    expect((await listMembers(botToken, t.name)).code).toBe("ok");
    expect(await lastUsed()).toBeDefined();
  });
});

describe("what a team's outsiders learn", () => {
  it("can't read a team's record, whether or not it exists", async () => {
    const t = await teamOfTwo();
    const outsider = await newUser();
    const existing = await call(outsider.token, "TeamService/GetTeam", { name: t.name });
    const missing = await call(outsider.token, "TeamService/GetTeam", { name: `${prefix}-no-such-team` });
    expect(existing.code).toBe("not_found");
    expect(existing.body).toEqual(missing.body);
    expect((await call(t.first.token, "TeamService/GetTeam", { name: t.name })).code).toBe("ok");
    expect((await call(admin, "TeamService/GetTeam", { name: t.name })).code).toBe("ok");
  });
});

describe("adding a team member", () => {
  it("is refused for a retired team", async () => {
    const t = await teamOfTwo();
    await setTeamRetired(t.teamId, true);
    const newcomer = await newUser();
    const email = emails[emails.length - 1];
    const added = await call(admin, "TeamService/AddMember", { team: t.name, email });
    expect(added.code).toBe("failed_precondition");
    expect(added.failure).toBe("TEAM_RETIRED");
    expect(await memberIds(t.name)).not.toContain(newcomer.id);
  });

  it("is limited per caller, so emails can't be swept", async () => {
    const t = await teamOfTwo();
    const codes: string[] = [];
    for (let i = 0; i < 31; i++) {
      const added = await call(t.first.token, "TeamService/AddMember", { team: t.name, email: `${prefix}-nobody-${i}@example.com` });
      codes.push(added.code);
    }
    expect(codes.slice(0, 30).every((c) => c === "not_found")).toBe(true);
    expect(codes[30]).toBe("resource_exhausted");
    // Someone else's limit is their own.
    const other = await call(t.second.token, "TeamService/AddMember", { team: t.name, email: `${prefix}-nobody@example.com` });
    expect(other.code).toBe("not_found");
  });
});

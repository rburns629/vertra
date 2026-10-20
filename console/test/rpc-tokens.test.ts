// SPDX-License-Identifier: MIT
/**
 * TokenService: the rules for bots and automation tokens
 * (shared through core/tokens.ts), through Connect: team membership gates a
 * team's bots, admins alone handle automation tokens, a retired team gets
 * no new token, and a raw token is shown once and never audited.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { addTeamMember, createTeam, setTeamRetired } from "../src/db/queries.js";
import { auditLog, teams, users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { failureCode, rpcClient, type RpcError } from "./rpc.js";

let app: FastifyInstance;
const { rpc, makeUser, signIn, cleanUp } = rpcClient(() => app);
const prefix = `rpc-tok-${randomUUID().slice(0, 8)}`;
const botEmails: string[] = [];

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  if (botEmails.length > 0) await db.delete(users).where(inArray(users.email, botEmails));
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await cleanUp();
});

async function memberOfNewTeam() {
  const team = await createTeam(`${prefix}-${randomUUID().slice(0, 6)}`);
  const member = await makeUser();
  await addTeamMember(member.id, team.id);
  return { team, member, token: await signIn(member.email) };
}

describe("a team's bots", () => {
  it("are made and listed by its members, the token shown once and never audited", async () => {
    const { team, member, token } = await memberOfNewTeam();
    const email = `bot-${randomUUID()}@example.com`;
    botEmails.push(email);

    const created = await rpc("TokenService", "CreateBotToken", { team: team.name, email, label: "ci" }, { token });
    expect(created.statusCode).toBe(200);
    const { token: raw, tokenId } = created.json<{ token: string; tokenId: string }>();
    expect(raw.length).toBeGreaterThan(20);

    const listed = await rpc("TokenService", "ListBots", { team: team.name }, { token });
    const bots = listed.json<{ bots: { email: string; tokens: { id: string }[] }[] }>().bots;
    expect(bots.find((bot) => bot.email === email)?.tokens.map((t) => t.id)).toEqual([tokenId]);
    expect(listed.body).not.toContain(raw);

    const [entry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actorId, member.id), eq(auditLog.route, "vertra.console.v1.TokenService/CreateBotToken")))
      .orderBy(desc(auditLog.id))
      .limit(1);
    expect(entry?.target).toMatchObject({ team: team.name, email, label: "ci" });
    expect(JSON.stringify(entry)).not.toContain(raw);

    // The bot's token works, as a member of the team.
    const asBot = await rpc("TokenService", "ListBots", { team: team.name }, { token: raw });
    expect(asBot.statusCode).toBe(200);
  });

  it("are out of reach of anyone else", async () => {
    const { team } = await memberOfNewTeam();
    const outsider = await makeUser();
    const token = await signIn(outsider.email);
    for (const [method, body] of [
      ["ListBots", { team: team.name }],
      ["CreateBotToken", { team: team.name, email: `x-${randomUUID()}@example.com`, label: "x" }],
    ] as const) {
      const response = await rpc("TokenService", method, body, { token });
      expect(response.statusCode).toBe(403);
      expect(failureCode(response.json<RpcError>())).toBe("FORBIDDEN");
    }
  });

  it("can't get a new token in a retired team", async () => {
    const { team, token } = await memberOfNewTeam();
    await setTeamRetired(team.id, true);
    const response = await rpc(
      "TokenService",
      "CreateBotToken",
      { team: team.name, email: `late-${randomUUID()}@example.com`, label: "x" },
      { token },
    );
    expect(response.json<RpcError>().code).toBe("failed_precondition");
    expect(failureCode(response.json<RpcError>())).toBe("TEAM_RETIRED");
  });

  it("can only be revoked by a member of one of the bot's teams, or an admin", async () => {
    const { team, token } = await memberOfNewTeam();
    const email = `bot-${randomUUID()}@example.com`;
    botEmails.push(email);
    const created = await rpc("TokenService", "CreateBotToken", { team: team.name, email, label: "ci" }, { token });
    const { tokenId, token: raw } = created.json<{ tokenId: string; token: string }>();

    const outsider = await signIn((await makeUser()).email);
    expect((await rpc("TokenService", "RevokeToken", { tokenId }, { token: outsider })).statusCode).toBe(403);

    expect((await rpc("TokenService", "RevokeToken", { tokenId }, { token })).statusCode).toBe(200);
    expect((await rpc("TokenService", "ListBots", { team: team.name }, { token: raw })).statusCode).toBe(401);
  });
});

describe("automation tokens", () => {
  it("are for admins only", async () => {
    const { token } = await memberOfNewTeam();
    const response = await rpc("TokenService", "CreateAutomationToken", { label: "ci", scopes: ["teams:create"] }, { token });
    expect(response.statusCode).toBe(403);
  });

  it("refuse unknown scopes, every problem at once", async () => {
    const admin = await makeUser({ admin: true });
    const token = await signIn(admin.email);
    const response = await rpc("TokenService", "CreateAutomationToken", { label: "", scopes: ["root"] }, { token });
    expect(response.json<RpcError>().code).toBe("invalid_argument");
  });
});

describe("input formats", () => {
  it("knows every format the schemas declare", async () => {
    const { readFile, readdir } = await import("node:fs/promises");
    const { FORMATS } = await import("../src/rpc/validate.js");
    const files = ["core", "auth", "rpc/services"].map((dir) => `src/${dir}`);
    const used = new Set<string>();
    for (const dir of files) {
      for (const name of await readdir(dir)) {
        if (!name.endsWith(".ts")) continue;
        for (const match of (await readFile(`${dir}/${name}`, "utf-8")).matchAll(/format: "([a-z-]+)"/g)) {
          if (match[1]) used.add(match[1]);
        }
      }
    }
    expect([...used].filter((format) => !(format in FORMATS))).toEqual([]);
  });
});

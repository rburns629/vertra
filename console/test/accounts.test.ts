// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/password.js";
import { db } from "../src/db/client.js";
import { createTeam, createUser, recordSubmittedExecution, setTeamRetired, setUserAdmin } from "../src/db/queries.js";
import { submittedExecutions, teams, users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";

const prefix = `acct-${randomUUID().slice(0, 6)}`;
let app: FastifyInstance;
let adminId: string;
let memberId: string;
let teamName: string;

async function newUser(isAdmin: boolean): Promise<string> {
  const user = await createUser(`${prefix}-${randomUUID()}@example.com`, await hashPassword("correct-horse-battery"));
  if (isAdmin) await setUserAdmin(user.id, true);
  return user.id;
}

function as(userId: string, method: "GET" | "POST" | "DELETE", url: string, payload?: object) {
  return app.inject({ method, url, headers: { authorization: `Bearer ${app.jwt.sign({ userId })}` }, payload });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  adminId = await newUser(true);
  memberId = await newUser(false);
  teamName = `${prefix}-team`;
  await createTeam(teamName);
});

afterAll(async () => {
  await app.close();
  await db.delete(submittedExecutions).where(eq(submittedExecutions.name, prefix));
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await db.delete(users).where(like(users.email, `${prefix}%`));
});

describe("open registration", () => {
  it("is off unless ALLOW_SELF_REGISTRATION is set, and says who to ask", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: `${prefix}-self@example.com`, password: "correct-horse-battery" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: string; message: string }>()).toMatchObject({
      error: "REGISTRATION_DISABLED",
      message: expect.stringContaining("admin") as string,
    });
    const environment = await app.inject({ method: "GET", url: "/api/environment" });
    expect(environment.json<{ selfRegistration: boolean }>().selfRegistration).toBe(false);
  });
});

describe("admins create accounts", () => {
  it("creates an account already in its teams, with a one-time password that signs in", async () => {
    const email = `${prefix}-new@example.com`;
    const created = await as(adminId, "POST", "/api/users", { email, teams: [teamName], admin: false });
    expect(created.statusCode).toBe(201);
    const { temporaryPassword } = created.json<{ temporaryPassword: string }>();
    expect(temporaryPassword.length).toBeGreaterThanOrEqual(20);

    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: temporaryPassword } });
    expect(login.statusCode).toBe(200);
    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${login.json<{ token: string }>().token}` },
    });
    expect(me.json<{ teamNames: string[] }>().teamNames).toEqual([teamName]);
  });

  it("is admin-only", async () => {
    const response = await as(memberId, "POST", "/api/users", { email: `${prefix}-x@example.com`, teams: [], admin: true });
    expect(response.statusCode).toBe(403);
    expect(await db.select().from(users).where(eq(users.email, `${prefix}-x@example.com`))).toEqual([]);
  });

  it("checks every team first, so a typo creates nothing", async () => {
    const email = `${prefix}-typo@example.com`;
    const response = await as(adminId, "POST", "/api/users", { email, teams: [teamName, "no-such-team"], admin: false });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ message: string }>().message).toContain("no-such-team");
    expect(await db.select().from(users).where(eq(users.email, email))).toEqual([]);
  });

  it("refuses a retired team and an existing email", async () => {
    const retired = `${prefix}-retired`;
    const team = await createTeam(retired);
    await setTeamRetired(team.id, true);
    expect((await as(adminId, "POST", "/api/users", { email: `${prefix}-r@example.com`, teams: [retired], admin: false })).statusCode).toBe(409);

    const dup = await as(adminId, "POST", "/api/users", { email: `${prefix}-new@example.com`, teams: [], admin: false });
    expect(dup.statusCode).toBe(409);
  });

  it("lists accounts with their teams, for admins only", async () => {
    expect((await as(memberId, "GET", "/api/users")).statusCode).toBe(403);
    const list = (await as(adminId, "GET", "/api/users")).json<{ email: string; teamNames: string[] }[]>();
    expect(list.find((u) => u.email === `${prefix}-new@example.com`)?.teamNames).toEqual([teamName]);
  });
});

describe("deleting an account", () => {
  it("removes the account but keeps the executions it submitted", async () => {
    const email = `${prefix}-leaver@example.com`;
    const leaver = await createUser(email, await hashPassword("correct-horse-battery"));
    const executionId = randomUUID();
    await recordSubmittedExecution({ executionId, teams: [teamName], submittedBy: leaver.id, name: prefix, payload: {} });

    expect((await as(adminId, "DELETE", `/api/users/${email}`)).statusCode).toBe(204);
    expect(await db.select().from(users).where(eq(users.email, email))).toEqual([]);
    const [kept] = await db.select().from(submittedExecutions).where(eq(submittedExecutions.executionId, executionId));
    expect(kept?.submittedBy).toBeNull();
  });

  it("won't delete your own account, and is admin-only", async () => {
    const [self] = await db.select().from(users).where(eq(users.id, adminId));
    expect((await as(adminId, "DELETE", `/api/users/${self?.email ?? ""}`)).statusCode).toBe(409);

    const [member] = await db.select().from(users).where(eq(users.id, memberId));
    expect((await as(memberId, "DELETE", `/api/users/${member?.email ?? ""}`)).statusCode).toBe(403);
    // (The last-admin rule can't be reached here: the shared test database
    // always holds other tests' admins. It's the same countAdmins() check
    // that DELETE /users/:email/admin already relies on.)
  });
});


// SPDX-License-Identifier: MIT
/** Who changed what (audit.ts): what's recorded, and what never is. */
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/password.js";
import { db } from "../src/db/client.js";
import { addTeamMember, createTeam, createUser, setUserAdmin } from "../src/db/queries.js";
import { auditLog, teams, users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";

vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  upsertSecretGrant: vi.fn(() => Promise.resolve()),
}));

const prefix = `aud-${randomUUID().slice(0, 6)}`;
const emails: string[] = [];
let app: FastifyInstance;
let admin: { id: string; token: string };
let member: { id: string; token: string };

async function newUser(isAdmin: boolean) {
  const email = `${prefix}-${randomUUID().slice(0, 6)}@example.com`;
  emails.push(email);
  const user = await createUser(email, await hashPassword("correct-horse-battery"));
  if (isAdmin) await setUserAdmin(user.id, true);
  return { id: user.id, token: app.jwt.sign({ userId: user.id }) };
}

const as = (token: string, method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });

/** The entries recorded for `actorId` once `route` shows up among them: the
 * hook writes after the response has gone out, so a moment after. */
async function entriesBy(actorId: string, route?: string) {
  for (let i = 0; ; i++) {
    const rows = await db.select().from(auditLog).where(eq(auditLog.actorId, actorId));
    if (!route || rows.some((r) => r.route === route) || i >= 20) return rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  admin = await newUser(true);
  member = await newUser(false);
  const team = await createTeam(prefix);
  await addTeamMember(member.id, team.id);
});

afterAll(async () => {
  await db.delete(auditLog).where(inArray(auditLog.actorId, [admin.id, member.id]));
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await db.delete(users).where(inArray(users.email, emails));
  await app.close();
});

describe("the audit log", () => {
  it("records a change with who made it and what it named, never the secret's value", async () => {
    const response = await as(member.token, "POST", "/api/secrets", {
      namespace: prefix,
      secretName: "db-key",
      data: { value: "not-a-real-but-still-secret-value" },
    });
    expect(response.statusCode).toBe(204);
    const [entry] = (await entriesBy(member.id, "/api/secrets")).filter((e) => e.route === "/api/secrets");
    expect(entry).toMatchObject({ method: "POST", status: 204, target: { namespace: prefix, secretName: "db-key" } });
    expect(JSON.stringify(entry)).not.toContain("not-a-real-but-still-secret-value");
  });

  it("records a refused attempt too", async () => {
    await as(member.token, "POST", "/api/teams", { name: `${prefix}-nope` });
    const refused = (await entriesBy(member.id, "/api/teams")).find((e) => e.route === "/api/teams");
    expect(refused).toMatchObject({ status: 403, target: { name: `${prefix}-nope` } });
  });

  it("doesn't record reads, or sign-in and password changes", async () => {
    await as(member.token, "GET", "/api/me");
    await as(member.token, "POST", "/api/me/password", { currentPassword: "correct-horse-battery", newPassword: "another-horse-battery" });
    const routes = (await entriesBy(member.id)).map((e) => e.route);
    expect(routes).not.toContain("/api/me");
    expect(routes).not.toContain("/api/me/password");
  });

  it("is readable by admins only, newest first", async () => {
    // (A fresh user: the test above changed member's password, ending its sessions.)
    expect((await as((await newUser(false)).token, "GET", "/api/audit")).statusCode).toBe(403);
    const page = (await as(admin.token, "GET", `/api/audit?actor=${member.id}`)).json<{ entries: { id: number; route: string; actorEmail: string }[] }>();
    expect(page.entries.length).toBeGreaterThanOrEqual(2);
    expect(page.entries[0]?.id).toBeGreaterThan(page.entries[1]?.id ?? 0);
    expect(page.entries[0]?.actorEmail).toContain(prefix);
  });
});

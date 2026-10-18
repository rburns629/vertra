// SPDX-License-Identifier: MIT
/** Rewriting the cluster's policies periodically, and showing admins how it went (policySync.ts). */
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/password.js";
import { config } from "../src/config.js";
import { db } from "../src/db/client.js";
import { createUser, setUserAdmin } from "../src/db/queries.js";
import { users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { updateIdentityPolicy } from "../src/k8s.js";

vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  updateIdentityPolicy: vi.fn(() => Promise.resolve(true)),
}));

const emails: string[] = [];
let app: FastifyInstance;
let admin: string;
let member: string;
const originalName = config.identityPolicyName;

beforeAll(async () => {
  config.identityPolicyName = "kernel-execution-kernel-identity";
  app = await buildApp();
  await app.ready();
  for (const isAdmin of [true, false]) {
    const email = `sync-${randomUUID().slice(0, 8)}@example.com`;
    emails.push(email);
    const user = await createUser(email, await hashPassword("correct-horse-battery"));
    if (isAdmin) await setUserAdmin(user.id, true);
    if (isAdmin) admin = app.jwt.sign({ userId: user.id });
    else member = app.jwt.sign({ userId: user.id });
  }
});

afterAll(async () => {
  config.identityPolicyName = originalName;
  await db.delete(users).where(inArray(users.email, emails));
  await app.close();
});

const call = (token: string, method: "GET" | "POST") =>
  app.inject({ method, url: "/api/policy-sync", headers: { authorization: `Bearer ${token}` } });

describe("policy sync", () => {
  it("rewrites the policies on request and says how it went, for admins only", async () => {
    expect((await call(member, "GET")).statusCode).toBe(403);
    const synced = (await call(admin, "POST")).json<Record<string, { ok: boolean; applies: boolean } | null>>();
    expect(synced["identityPolicy"]).toMatchObject({ ok: true, applies: true });
    expect(synced["scanPolicy"]).toMatchObject({ ok: true, applies: false }); // scanning off here
  });

  it("shows a failure instead of hiding it", async () => {
    vi.mocked(updateIdentityPolicy).mockRejectedValueOnce(new Error("conflict, five times"));
    const outcome = (await call(admin, "POST")).json<Record<string, { ok: boolean; error?: string }>>();
    expect(outcome["identityPolicy"]).toMatchObject({ ok: false, error: "conflict, five times" });
    expect((await call(admin, "GET")).json<Record<string, { ok: boolean }>>()["identityPolicy"]?.ok).toBe(false);
  });
});

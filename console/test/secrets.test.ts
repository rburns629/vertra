// SPDX-License-Identifier: MIT
/**
 * Registering and revoking secrets (routes/secrets.ts): who may, which names,
 * and what reaches the cluster. Kubernetes is faked; what k8s.ts then does
 * to the cluster (labels, pruning old bindings) is proven on kind.
 */
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/password.js";
import { db } from "../src/db/client.js";
import {
  addTeamMember,
  createTeam,
  createUser,
  isSecretRegistered,
  recordSecretGrant,
  setTeamRetired,
} from "../src/db/queries.js";
import { teams, users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { SecretNotManagedError, deleteSecretGrant, upsertSecretGrant } from "../src/k8s.js";
import { syncIdentityPolicy } from "../src/productPolicy.js";

// The cluster's copy of every team's secret names; here, recorded.
vi.mock("../src/productPolicy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/productPolicy.js")>()),
  syncIdentityPolicy: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  upsertSecretGrant: vi.fn(() => Promise.resolve()),
  upsertExternalSecretGrant: vi.fn(() => Promise.resolve()),
  deleteSecretGrant: vi.fn(() => Promise.resolve()),
}));

const prefix = `sec-${randomUUID().slice(0, 6)}`;
const emails: string[] = [];
let app: FastifyInstance;
let ours: { id: string; name: string };
let theirs: { id: string; name: string };
let member: string;

const as = (method: "POST" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${member}` }, payload: payload as object });

const literal = (fields: Record<string, unknown> = {}) => ({
  namespace: ours.name,
  secretName: "db-key",
  data: { value: "x" },
  ...fields,
});

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  ours = await createTeam(`${prefix}-ours`);
  theirs = await createTeam(`${prefix}-theirs`);
  const email = `${prefix}@example.com`;
  emails.push(email);
  const user = await createUser(email, await hashPassword("correct-horse-battery"));
  await addTeamMember(user.id, ours.id);
  member = app.jwt.sign({ userId: user.id });
});

afterAll(async () => {
  await db.delete(teams).where(inArray(teams.name, [ours.name, theirs.name]));
  await db.delete(users).where(inArray(users.email, emails));
  await app.close();
});

beforeEach(() => {
  vi.mocked(upsertSecretGrant).mockClear();
  vi.mocked(deleteSecretGrant).mockClear();
  vi.mocked(syncIdentityPolicy).mockClear();
});

describe("registering", () => {
  it("refuses another team's namespace", async () => {
    const response = await as("POST", "/api/secrets", literal({ namespace: theirs.name }));
    expect(response.statusCode).toBe(403);
    expect(upsertSecretGrant).not.toHaveBeenCalled();
  });

  it.each(["DB_KEY", "db key", "-db", "a".repeat(121)])("refuses a secret named %j", async (secretName) => {
    expect((await as("POST", "/api/secrets", literal({ secretName }))).statusCode).toBe(400);
    expect(upsertSecretGrant).not.toHaveBeenCalled();
  });

  it("registers a secret for the whole team, and tells the cluster", async () => {
    const response = await as("POST", "/api/secrets", literal({ secretName: "team-key" }));
    expect(response.statusCode).toBe(204);
    expect(await isSecretRegistered(ours.id, "team-key")).toBe(true);
    expect(syncIdentityPolicy).toHaveBeenCalledOnce();
  });

  it("ignores the ServiceAccount an older client still sends", async () => {
    const response = await as("POST", "/api/secrets", literal({ secretName: "old-client", serviceAccountName: "db-product" }));
    expect(response.statusCode).toBe(204);
    expect(await isSecretRegistered(ours.id, "old-client")).toBe(true);
  });

  it("says when the name belongs to a Secret the console didn't create", async () => {
    vi.mocked(upsertSecretGrant).mockRejectedValueOnce(new SecretNotManagedError("taken"));
    const response = await as("POST", "/api/secrets", literal({ secretName: "store-credentials" }));
    expect(response.statusCode).toBe(409);
    expect(await isSecretRegistered(ours.id, "store-credentials")).toBe(false);
  });

  it("leaves no record behind when the cluster write fails", async () => {
    vi.mocked(upsertSecretGrant).mockRejectedValueOnce(new Error("API server unreachable"));
    const response = await as("POST", "/api/secrets", literal({ secretName: "unwritten" }));
    expect(response.statusCode).toBe(500);
    expect(await isSecretRegistered(ours.id, "unwritten")).toBe(false);
  });

  it("tells the cluster when the team already has the grant, so its Secret may be replaced", async () => {
    await as("POST", "/api/secrets", literal({ secretName: "new-key" }));
    expect(vi.mocked(upsertSecretGrant).mock.calls[0]?.[0]).toMatchObject({ alreadyGranted: false });

    await recordSecretGrant({ teamId: ours.id, secretName: "old-key", keys: ["value"], source: "literal" });
    await as("POST", "/api/secrets", literal({ secretName: "old-key" }));
    expect(vi.mocked(upsertSecretGrant).mock.calls[1]?.[0]).toMatchObject({ alreadyGranted: true });
  });
});

describe("revoking", () => {
  it("removes the grant, from the cluster first", async () => {
    await recordSecretGrant({ teamId: ours.id, secretName: "to-revoke", keys: ["value"], source: "literal" });
    const response = await as("DELETE", `/api/teams/${ours.name}/secrets/to-revoke`);
    expect(response.statusCode).toBe(204);
    expect(deleteSecretGrant).toHaveBeenCalledWith(ours.name, "to-revoke", "literal");
    expect(await isSecretRegistered(ours.id, "to-revoke")).toBe(false);
    expect(syncIdentityPolicy).toHaveBeenCalledOnce();
  });

  it("keeps the grant on record if the cluster couldn't be updated", async () => {
    await recordSecretGrant({ teamId: ours.id, secretName: "sticky", keys: ["value"], source: "literal" });
    vi.mocked(deleteSecretGrant).mockRejectedValueOnce(new Error("API server unreachable"));
    expect((await as("DELETE", `/api/teams/${ours.name}/secrets/sticky`)).statusCode).toBe(500);
    expect(await isSecretRegistered(ours.id, "sticky")).toBe(true);
  });

  it("refuses another team's secret", async () => {
    await recordSecretGrant({ teamId: theirs.id, secretName: "theirs", keys: ["value"], source: "literal" });
    expect((await as("DELETE", `/api/teams/${theirs.name}/secrets/theirs`)).statusCode).toBe(403);
    expect(deleteSecretGrant).not.toHaveBeenCalled();
  });

  it("says when there's no such secret", async () => {
    expect((await as("DELETE", `/api/teams/${ours.name}/secrets/never-registered`)).statusCode).toBe(404);
  });

  it("leaves a retired team's secrets alone", async () => {
    const retired = await createTeam(`${prefix}-retired`);
    const email = `${prefix}-r@example.com`;
    emails.push(email);
    const user = await createUser(email, await hashPassword("correct-horse-battery"));
    await addTeamMember(user.id, retired.id);
    await recordSecretGrant({ teamId: retired.id, secretName: "kept", keys: ["value"], source: "literal" });
    await setTeamRetired(retired.id, true);
    const response = await app.inject({
      method: "DELETE",
      url: `/api/teams/${retired.name}/secrets/kept`,
      headers: { authorization: `Bearer ${app.jwt.sign({ userId: user.id })}` },
    });
    expect(response.statusCode).toBe(409);
    await db.delete(teams).where(inArray(teams.name, [retired.name]));
  });
});

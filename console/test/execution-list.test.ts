// SPDX-License-Identifier: MIT
/**
 * GET /api/executions, a page at a time: every row exactly once across
 * pages (including two submitted in the same instant), only what the caller
 * may see, and the server-side filters.
 */
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/password.js";
import { db } from "../src/db/client.js";
import { addTeamMember, createTeam, createUser } from "../src/db/queries.js";
import { submittedExecutions, teams, users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";

vi.mock("../src/kernel/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/kernel/client.js")>()),
  getExecutionStates: vi.fn((ids: string[]) =>
    Promise.resolve(ids.map((executionId) => ({ executionId, state: "SUCCEEDED" }))),
  ),
}));

const prefix = `list-${randomUUID().slice(0, 6)}`;
const ours = `${prefix}-ours`;
const theirs = `${prefix}-theirs`;
const email = `${prefix}@example.com`;
let app: FastifyInstance;
let token: string;
const ids: string[] = [];

interface Page {
  executions: { executionId: string; name: string; state: string | null }[];
  nextCursor: string | null;
}

async function page(query: string): Promise<Page> {
  const response = await app.inject({ method: "GET", url: `/api/executions?${query}`, headers: { authorization: `Bearer ${token}` } });
  expect(response.statusCode).toBe(200);
  return response.json<Page>();
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  const team = await createTeam(ours);
  await createTeam(theirs);
  const user = await createUser(email, await hashPassword("correct-horse-battery"));
  await addTeamMember(user.id, team.id);
  token = app.jwt.sign({ userId: user.id });
  // Five of ours, newest last; the 3rd and 4th share a timestamp. One of theirs.
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  const times = [0, 1000, 2000, 2000, 3000];
  for (const [i, offset] of times.entries()) {
    const executionId = randomUUID();
    ids.push(executionId);
    await db.insert(submittedExecutions).values({
      executionId,
      teams: [ours],
      submittedBy: null,
      name: i === 1 ? "Nightly 50%_backup" : `${prefix}-run-${String(i)}`,
      payload: {},
      createdAt: new Date(base + offset),
    });
  }
  await db.insert(submittedExecutions).values({
    executionId: randomUUID(),
    teams: [theirs],
    submittedBy: null,
    name: `${prefix}-theirs`,
    payload: {},
    createdAt: new Date(base + 5000),
  });
});

afterAll(async () => {
  await db.delete(submittedExecutions).where(inArray(submittedExecutions.name, [...ids.map((_, i) => `${prefix}-run-${String(i)}`), "Nightly 50%_backup", `${prefix}-theirs`]));
  await db.delete(teams).where(inArray(teams.name, [ours, theirs]));
  await db.delete(users).where(inArray(users.email, [email]));
  await app.close();
});

describe("GET /api/executions", () => {
  it("pages through every visible execution exactly once, newest first", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const result: Page = await page(`limit=2&team=${ours}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      seen.push(...result.executions.map((e) => e.executionId));
      cursor = result.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen[0]).toBe(ids[4]);
    expect(seen[4]).toBe(ids[0]);
  });

  it("shows only executions of the caller's teams, with their states", async () => {
    const result = await page("limit=1000");
    const names = result.executions.map((e) => e.name);
    expect(names).not.toContain(`${prefix}-theirs`);
    expect(result.executions.filter((e) => ids.includes(e.executionId))).toHaveLength(5);
    expect(result.executions.every((e) => e.state === "SUCCEEDED")).toBe(true);
  });

  it("searches names on the server, treating % and _ as plain characters", async () => {
    expect((await page(`search=${encodeURIComponent("50%_b")}`)).executions.map((e) => e.name)).toEqual(["Nightly 50%_backup"]);
    expect((await page(`search=${encodeURIComponent("5_%")}`)).executions).toEqual([]);
  });

  it("narrows to a time window", async () => {
    const result = await page(`team=${ours}&since=${encodeURIComponent("2026-01-01T00:00:02.000Z")}`);
    expect(result.executions.map((e) => e.executionId).sort()).toEqual([ids[2], ids[3], ids[4]].sort());
  });

  it("refuses a cursor it didn't make", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/executions?cursor=not-a-cursor",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(400);
  });
});

// SPDX-License-Identifier: MIT
/**
 * ListExecutions, a page at a time: every row exactly once across
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
import { getExecutionStates } from "../src/kernel/client.js";
import { caller } from "./rpc.js";

vi.mock("../src/kernel/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/kernel/client.js")>()),
  getExecutionStates: vi.fn((ids: string[]) =>
    Promise.resolve(
      ids.map((executionId) => ({
        executionId,
        state: "SUCCEEDED",
        steps: { SUCCEEDED: 3, SKIPPED: 1 },
        createdAt: "2026-10-21T10:00:00.000Z",
        updatedAt: "2026-10-21T10:06:02.000Z",
        running: [{ taskId: "app-hosting", action: "create", attempt: 2, maxAttempts: 3 }],
      })),
    ),
  ),
}));

const prefix = `list-${randomUUID().slice(0, 6)}`;
const ours = `${prefix}-ours`;
const theirs = `${prefix}-theirs`;
const email = `${prefix}@example.com`;
let app: FastifyInstance;
let token: string;
const ids: string[] = [];
/** When the first fixture execution was made. */
let base = 0;

interface Page {
  executions: {
    executionId: string;
    name: string;
    state: string;
    template: string;
    steps: Record<string, number>;
    finishedAt?: string;
    submittedBy?: string;
    submittedByEmail?: string;
    running?: { taskId: string; action: string; attempt: number; maxAttempts: number }[];
  }[];
  nextCursor: string;
  runRetentionDays?: number;
}

interface Query {
  limit?: number;
  cursor?: string;
  team?: string;
  search?: string;
  since?: string;
  mine?: boolean;
}

const call = caller(() => app);

function list({ limit, cursor, ...rest }: Query) {
  return call<Page>(token, "ExecutionService/ListExecutions", { page: { limit, cursor }, ...rest });
}

async function page(query: Query): Promise<Page> {
  const listed = await list(query);
  expect(listed.code).toBe("ok");
  return listed.body;
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
  // Yesterday, to the second: inside retention (retention.test.ts, running
  // alongside, deletes executions past it).
  base = Math.floor((Date.now() - 86_400_000) / 1000) * 1000;
  const times = [0, 1000, 2000, 2000, 3000];
  for (const [i, offset] of times.entries()) {
    const executionId = randomUUID();
    ids.push(executionId);
    await db.insert(submittedExecutions).values({
      executionId,
      teams: [ours],
      // The newest is the caller's own, run from a template.
      submittedBy: i === 4 ? user.id : null,
      template: i === 4 ? "gcp-platform/app-on-cloud-run" : null,
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

describe("ListExecutions", () => {
  it("pages through every visible execution exactly once, newest first", async () => {
    const seen: string[] = [];
    let cursor = "";
    let pages = 0;
    do {
      const result: Page = await page({ limit: 2, team: ours, cursor });
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
    const result = await page({ limit: 1000 });
    const names = result.executions.map((e) => e.name);
    expect(names).not.toContain(`${prefix}-theirs`);
    expect(result.executions.filter((e) => ids.includes(e.executionId))).toHaveLength(5);
    expect(result.executions.every((e) => e.state === "EXECUTION_STATE_SUCCEEDED")).toBe(true);
  });

  it("says what each run was, how its steps went, and when it finished", async () => {
    const newest = (await page({ team: ours, limit: 1 })).executions[0];
    expect(newest).toMatchObject({
      executionId: ids[4],
      template: "gcp-platform/app-on-cloud-run",
      steps: { SUCCEEDED: 3, SKIPPED: 1 },
      finishedAt: "2026-10-21T10:06:02Z",
    });
    const older = (await page({ team: ours })).executions.find((e) => e.executionId === ids[0]);
    expect(older?.template).toBe("");
  });

  it("says who started each run by email, unless that account is gone", async () => {
    const result = await page({ team: ours });
    const own = result.executions.find((e) => e.executionId === ids[4]);
    expect(own?.submittedByEmail).toBe(email);
    expect(own?.submittedBy).toBeTruthy();
    const deleted = result.executions.find((e) => e.executionId === ids[0]);
    expect(deleted?.submittedBy).toBeUndefined();
    expect(deleted?.submittedByEmail).toBeUndefined();
  });

  it("says which step runs now, and its attempt", async () => {
    const newest = (await page({ team: ours, limit: 1 })).executions[0];
    expect(newest?.running).toEqual([{ taskId: "app-hosting", action: "create", attempt: 2, maxAttempts: 3 }]);
    expect(vi.mocked(getExecutionStates)).toHaveBeenLastCalledWith([newest?.executionId], { running: true });
  });

  it("says how long runs are kept, to anyone who may list them", async () => {
    expect((await page({ limit: 1 })).runRetentionDays).toBeGreaterThan(0);
  });

  it("narrows to the caller's own runs", async () => {
    expect((await page({ mine: true })).executions.map((e) => e.executionId)).toEqual([ids[4]]);
  });

  it("searches names on the server, treating % and _ as plain characters", async () => {
    expect((await page({ search: "50%_b" })).executions.map((e) => e.name)).toEqual(["Nightly 50%_backup"]);
    expect((await page({ search: "5_%" })).executions).toEqual([]);
  });

  it("narrows to a time window", async () => {
    const result = await page({ team: ours, since: new Date(base + 2000).toISOString() });
    expect(result.executions.map((e) => e.executionId).sort()).toEqual([ids[2], ids[3], ids[4]].sort());
  });

  it("refuses a cursor it didn't make", async () => {
    expect((await list({ cursor: "not-a-cursor" })).code).toBe("invalid_argument");
  });
});

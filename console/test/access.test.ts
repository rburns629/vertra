// SPDX-License-Identifier: MIT
/** The console's authorization rules (auth/access.ts). */
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { canActForTeam, loadExecution } from "../src/auth/access.js";
import { db } from "../src/db/client.js";
import { submittedExecutions } from "../src/db/schema.js";

const member = { teamNames: ["a"], isAdmin: false };
const admin = { teamNames: [], isAdmin: true };
const recorded: string[] = [];

/** The status a refusal carries (ApiError), or 0 for none. */
async function refusal(check: Promise<unknown>): Promise<number> {
  try {
    await check;
    return 0;
  } catch (error) {
    return (error as { statusCode?: number }).statusCode ?? -1;
  }
}

async function execution(teams: string[]): Promise<string> {
  const executionId = randomUUID();
  recorded.push(executionId);
  await db.insert(submittedExecutions).values({ executionId, teams, submittedBy: null, name: "x", payload: {} });
  return executionId;
}

afterAll(async () => {
  await db.delete(submittedExecutions).where(inArray(submittedExecutions.executionId, recorded));
});

describe("canActForTeam", () => {
  it("a member or an admin, nobody else", () => {
    expect(canActForTeam(member, "a")).toBe(true);
    expect(canActForTeam(member, "b")).toBe(false);
    expect(canActForTeam(admin, "b")).toBe(true);
    expect(canActForTeam(undefined, "a")).toBe(false);
  });
});

describe("loadExecution", () => {
  it("lets a member of one team see a two-team execution, but not manage it", async () => {
    const id = await execution(["a", "b"]);
    expect(await loadExecution(id, member, "any")).toBeDefined();
    expect(await refusal(loadExecution(id, member, "every"))).toBe(403);
  });

  it("never lets 'every' pass vacuously for an execution with no teams", async () => {
    const id = await execution([]);
    expect(await refusal(loadExecution(id, member, "every"))).toBe(403);
  });

  it("404s an execution it has no record of", async () => {
    expect(await refusal(loadExecution(randomUUID(), admin, "any"))).toBe(404);
  });
});

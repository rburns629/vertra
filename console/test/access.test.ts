// SPDX-License-Identifier: MIT
/** The console's authorization rules (auth/access.ts). */
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import type { FastifyReply } from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { canActForTeam, loadExecutionOrReply } from "../src/auth/access.js";
import { db } from "../src/db/client.js";
import { submittedExecutions } from "../src/db/schema.js";

const member = { teamNames: ["a"], isAdmin: false };
const admin = { teamNames: [], isAdmin: true };
const recorded: string[] = [];

function fakeReply(): FastifyReply & { sent?: number } {
  const reply = {
    sent: undefined as number | undefined,
    code(status: number) {
      reply.sent = status;
      return reply;
    },
    send() {
      return reply;
    },
  };
  return reply as unknown as FastifyReply & { sent?: number };
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

describe("loadExecutionOrReply", () => {
  it("lets a member of one team see a two-team execution, but not manage it", async () => {
    const id = await execution(["a", "b"]);
    expect(await loadExecutionOrReply(id, member, fakeReply(), "any")).toBeDefined();
    const reply = fakeReply();
    expect(await loadExecutionOrReply(id, member, reply, "every")).toBeUndefined();
    expect(reply.sent).toBe(403);
  });

  it("never lets 'every' pass vacuously for an execution with no teams", async () => {
    const id = await execution([]);
    const reply = fakeReply();
    expect(await loadExecutionOrReply(id, member, reply, "every")).toBeUndefined();
    expect(reply.sent).toBe(403);
  });

  it("404s an execution it has no record of", async () => {
    const reply = fakeReply();
    expect(await loadExecutionOrReply(randomUUID(), admin, reply, "any")).toBeUndefined();
    expect(reply.sent).toBe(404);
  });
});

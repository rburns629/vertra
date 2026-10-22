// SPDX-License-Identifier: MIT
/**
 * Who sees a step's log lines: INFO lines to everyone who can see the run,
 * the rest (DEBUG, WARN, ERROR, plain) to the step's team and admins.
 */
import { randomUUID } from "node:crypto";
import { inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../src/db/client.js";
import { addTeamMember, createTeam, recordSubmittedExecution } from "../src/db/queries.js";
import { submittedExecutions, teams } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { isInfo, visibleLines } from "../src/logLevels.js";
import { caller, rpcClient } from "./rpc.js";

const lines = [
  '{"level":"info","msg":"Creating the project"}',
  '{"level":"debug","msg":"GET https://cloudresourcemanager.googleapis.com/..."}',
  '{"level":"warn","msg":"quota at 80%"}',
  "a plain line",
  '2026-10-22T10:00:00Z {"level":"INFO","msg":"done"}',
];

vi.mock("../src/kernel/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/kernel/client.js")>()),
  getExecutionLogs: vi.fn(() => Promise.resolve({ tasks: [{ taskId: "theirs", lines }, { taskId: "ours", lines }] })),
}));

const prefix = `logs-${randomUUID().slice(0, 6)}`;
const owner = `${prefix}-owner`;
const consumer = `${prefix}-web`;
let app: FastifyInstance;
const users = rpcClient(() => app);
const call = caller(() => app);
let token = "";
let executionId = "";

beforeAll(async () => {
  app = await buildApp();
  const [, consumerTeam] = [await createTeam(owner), await createTeam(consumer)];
  const person = await users.makeUser();
  await addTeamMember(person.id, consumerTeam.id, "member");
  token = await users.signIn(person.email);
  executionId = randomUUID();
  await recordSubmittedExecution({
    executionId,
    teams: [owner, consumer],
    submittedBy: person.id,
    name: "x",
    payload: {
      name: "x",
      tasks: [
        { id: "theirs", image: "i", action: "a", team: owner },
        { id: "ours", image: "i", action: "a", team: consumer },
      ],
    },
  });
});

afterAll(async () => {
  await db.delete(submittedExecutions).where(inArray(submittedExecutions.executionId, [executionId]));
  const ours = await db.select({ id: teams.id }).from(teams).where(like(teams.name, `${prefix}%`));
  if (ours.length > 0) await db.delete(teams).where(inArray(teams.id, ours.map((t) => t.id)));
  await users.cleanUp();
  await app.close();
});

describe("log levels", () => {
  it("counts only a JSON line with level info (or pino's 30) as INFO", () => {
    expect(lines.map(isInfo)).toEqual([true, false, false, false, true]);
    expect(isInfo('{"level":30,"msg":"x"}')).toBe(true);
    expect(isInfo('{"severity":"INFO"}')).toBe(true);
    expect(isInfo('{"msg":"no level"}')).toBe(false);
    expect(visibleLines(lines, false)).toEqual({ lines: [lines[0], lines[4]], hidden: 3 });
    expect(visibleLines(lines, true).hidden).toBe(0);
  });

  it("shows another team's step its INFO lines only, and your own team's step everything", async () => {
    type Logs = { tasks: { taskId: string; lines: string[]; hidden: number; visibleTo: string }[] };
    const got = await call<Logs>(token, "ExecutionService/GetExecutionLogs", { executionId });
    expect(got.code).toBe("ok");
    const byTask = new Map(got.body.tasks.map((t) => [t.taskId, t]));
    expect(byTask.get("theirs")).toMatchObject({ lines: [lines[0], lines[4]], hidden: 3, visibleTo: owner });
    expect(byTask.get("ours")).toMatchObject({ lines, hidden: 0, visibleTo: consumer });
  });
});

// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/password.js";
import { db } from "../src/db/client.js";
import {
  addTeamMember,
  createTeam,
  createUser,
  recordSecretGrant,
  recordSubmittedExecution,
  setUserAdmin,
} from "../src/db/queries.js";
import { secretGrants, submittedExecutions, teams, users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { getExecutionStates, retryTask, submitExecution } from "../src/kernel/client.js";

// Only kernel-api is stubbed. `kernelStates` is what it reports for each
// execution id; submitExecution and retryTask just accept.
const kernelStates = new Map<string, string>();
vi.mock("../src/kernel/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/kernel/client.js")>();
  const { randomUUID: uuid } = await import("node:crypto");
  return {
    ...actual,
    submitExecution: vi.fn(() => Promise.resolve({ executionId: uuid(), state: "PENDING", created: true })),
    retryTask: vi.fn((executionId: string) => Promise.resolve({ executionId, state: "RUNNING" })),
    getExecution: vi.fn((executionId: string) =>
      Promise.resolve({ executionId, name: "history", state: "FAILED", tasks: [] }),
    ),
    getExecutionStates: vi.fn((ids: string[]) =>
      Promise.resolve(
        ids.filter((id) => kernelStates.has(id)).map((id) => ({ executionId: id, state: kernelStates.get(id) })),
      ),
    ),
  };
});

// The image policy lives in a ConfigMap on a real cluster; here it allows
// everything these tests submit (their images are Docker Hub shorthands).
vi.mock("../src/imagePolicy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/imagePolicy.js")>()),
  readImagePolicy: vi.fn(() =>
    Promise.resolve({ exists: true, source: "docker.io/", additional: [], version: "1" }),
  ),
  readImagePolicyForDisplay: vi.fn(() =>
    Promise.resolve({ exists: true, source: "docker.io/", additional: [], version: "1" }),
  ),
}));

const prefix = `life-${randomUUID().slice(0, 6)}`;
const emails: string[] = [];
let app: FastifyInstance;
let admin: string;

async function newUser(options: { admin?: boolean } = {}): Promise<{ id: string; token: string }> {
  const email = `${prefix}-${randomUUID()}@example.com`;
  emails.push(email);
  const user = await createUser(email, await hashPassword("correct-horse-battery"));
  if (options.admin) await setUserAdmin(user.id, true);
  return { id: user.id, token: app.jwt.sign({ userId: user.id }) };
}

function as(token: string, method: "GET" | "POST" | "DELETE", url: string, payload?: object) {
  return app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
}

async function mint(scopes: string[]): Promise<string> {
  const response = await as(admin, "POST", "/api/automation-tokens", { label: prefix, scopes });
  return response.json<{ token: string }>().token;
}

/** A team with one human member, one team bot, a registered product, a
 * secret grant and one finished execution in its history. */
async function populatedTeam() {
  const name = `${prefix}-${randomUUID().slice(0, 6)}`;
  const team = await createTeam(name);
  const member = await newUser();
  await addTeamMember(member.id, team.id);
  const bot = await as(member.token, "POST", `/api/teams/${name}/bots`, {
    email: `${name}-bot@bot.internal`,
    label: "team ci",
  });
  emails.push(`${name}-bot@bot.internal`);
  await as(admin, "POST", "/api/products", { name: `${name}-p`, image: `example/${name}:1`, action: "create", team: name });
  await recordSecretGrant({ teamId: team.id, secretName: "s", keys: ["value"], source: "literal" });
  const executionId = randomUUID();
  await recordSubmittedExecution({
    executionId,
    teams: [name],
    submittedBy: member.id,
    name: "history",
    payload: {},
  });
  kernelStates.set(executionId, "SUCCEEDED");
  return { name, teamId: team.id, member, botToken: bot.json<{ token: string }>().token, executionId };
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  admin = (await newUser({ admin: true })).token;
});

beforeEach(() => {
  vi.mocked(getExecutionStates).mockClear();
  vi.mocked(submitExecution).mockClear();
  vi.mocked(retryTask).mockClear();
});

afterAll(async () => {
  await app.close();
  await db.delete(submittedExecutions).where(eq(submittedExecutions.name, "history"));
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await db.delete(users).where(inArray(users.email, emails));
});

describe("retire", () => {
  it("needs admin or teams:retire, and unregisters the team's products", async () => {
    const t = await populatedTeam();
    expect((await as(t.member.token, "POST", `/api/teams/${t.name}/retire`)).statusCode).toBe(403);

    const response = await as(await mint(["teams:retire"]), "POST", `/api/teams/${t.name}/retire`);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ unregisteredProducts: number }>().unregisteredProducts).toBe(1);
    // Idempotent.
    expect((await as(admin, "POST", `/api/teams/${t.name}/retire`)).statusCode).toBe(200);
  });

  it("makes the team read-only until it's un-retired", async () => {
    const t = await populatedTeam();
    await as(admin, "POST", `/api/teams/${t.name}/retire`);

    const writes = [
      as(admin, "POST", "/api/products", { name: `${t.name}-p2`, image: "example/x:2", action: "create", team: t.name }),
      as(t.member.token, "POST", `/api/teams/${t.name}/bots`, { email: `${t.name}-b2@bot.internal`, label: "x" }),
      as(t.member.token, "POST", "/api/secrets", {
        namespace: t.name, secretName: "s2", data: { value: "v" },
      }),
      as(t.member.token, "POST", "/api/executions", {
        name: "x", requestId: `x-${randomUUID()}`,
        tasks: [{ id: "t", image: "i", action: "a", team: t.name, serviceAccount: "default" }],
      }),
    ];
    for (const response of await Promise.all(writes)) {
      expect(response.statusCode).toBe(409);
      expect(response.json<{ error: string }>().error).toBe("TEAM_RETIRED");
    }
    // History stays readable for members.
    expect((await as(t.member.token, "GET", `/api/teams/${t.name}/members`)).statusCode).toBe(200);

    expect((await as(admin, "POST", `/api/teams/${t.name}/unretire`)).statusCode).toBe(200);
    const product = await as(admin, "POST", "/api/products", {
      name: `${t.name}-p3`, image: "example/x:3", action: "create", team: t.name,
    });
    expect(product.statusCode).toBe(200);
  });
});

describe("purge", () => {
  it("refuses a team that isn't retired", async () => {
    const t = await populatedTeam();
    const response = await as(admin, "DELETE", `/api/teams/${t.name}`);
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toBe("NOT_RETIRED");
  });

  it("refuses while an execution is unfinished, and fails closed if kernel-api can't say", async () => {
    const t = await populatedTeam();
    await as(admin, "POST", `/api/teams/${t.name}/retire`);

    kernelStates.set(t.executionId, "RUNNING");
    const running = await as(admin, "DELETE", `/api/teams/${t.name}`);
    expect(running.statusCode).toBe(409);
    expect(running.json<{ error: string }>().error).toBe("EXECUTIONS_RUNNING");

    vi.mocked(getExecutionStates).mockRejectedValueOnce(new Error("kernel-api unreachable"));
    expect((await as(admin, "DELETE", `/api/teams/${t.name}`)).statusCode).toBe(500);
    expect((await as(admin, "GET", `/api/teams/${t.name}`)).json<{ deletedAt: string | null }>().deletedAt).toBeNull();
  });

  it("needs teams:delete: the everyday catalog token can't purge", async () => {
    const t = await populatedTeam();
    await as(admin, "POST", `/api/teams/${t.name}/retire`);
    const catalogToken = await mint(["teams:create", "products:register", "teams:retire"]);
    expect((await as(catalogToken, "DELETE", `/api/teams/${t.name}`)).statusCode).toBe(403);
    expect((await as(await mint(["teams:delete"]), "DELETE", `/api/teams/${t.name}`)).statusCode).toBe(200);
  });

  it("removes access, grants and bots, keeps history, and reserves the name forever", async () => {
    const t = await populatedTeam();
    await as(admin, "POST", `/api/teams/${t.name}/retire`);
    const response = await as(admin, "DELETE", `/api/teams/${t.name}`);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ revokedBotTokens: number }>().revokedBotTokens).toBe(1);

    // Gone from membership, admin listing, and the team's own routes.
    expect((await as(t.member.token, "GET", "/api/me")).json<{ teamNames: string[] }>().teamNames).toEqual([]);
    const listing = (await as(admin, "GET", "/api/teams")).json<{ name: string }[]>();
    expect(listing.some((team) => team.name === t.name)).toBe(false);
    expect((await as(admin, "GET", `/api/teams/${t.name}/members`)).statusCode).toBe(404);

    // Secret grants deleted; the team's bot can no longer authenticate.
    expect(await db.select().from(secretGrants).where(eq(secretGrants.teamId, t.teamId))).toEqual([]);
    expect((await as(t.botToken, "GET", "/api/me")).statusCode).toBe(401);

    // Execution history kept.
    const history = await db.select().from(submittedExecutions).where(eq(submittedExecutions.executionId, t.executionId));
    expect(history).toHaveLength(1);

    // The name stays taken: visible to the existence check, and not reusable.
    const existence = await as(admin, "GET", `/api/teams/${t.name}`);
    expect(existence.statusCode).toBe(200);
    expect(existence.json<{ deletedAt: string | null }>().deletedAt).not.toBeNull();
    const reuse = await as(admin, "POST", "/api/teams", { name: t.name });
    expect(reuse.statusCode).toBe(409);
    expect(reuse.json<{ error: string }>().error).toBe("NAME_RESERVED");
  });
});

describe("running an execution again after its team is retired or purged", () => {
  /** A replayable execution for `team` (populatedTeam's own has no tasks). */
  async function replayableExecution(team: string, submittedBy: string): Promise<string> {
    const executionId = randomUUID();
    await recordSubmittedExecution({
      executionId,
      teams: [team],
      submittedBy,
      name: "history",
      payload: {
        name: "history",
        requestId: randomUUID(),
        tasks: [{ id: "t", image: `example/${team}:1`, action: "create", team }],
      },
    });
    return executionId;
  }

  function runBlocked(executionId: string) {
    return as(admin, "GET", `/api/executions/${executionId}`).then(
      (r) => r.json<{ runBlocked: { error: string } | null }>().runBlocked,
    );
  }

  it("refuses a purged team's rerun, retry and new work, even for an admin, and says why up front", async () => {
    const t = await populatedTeam();
    const executionId = await replayableExecution(t.name, t.member.id);
    await as(admin, "POST", `/api/teams/${t.name}/retire`);
    expect((await as(admin, "DELETE", `/api/teams/${t.name}`)).statusCode).toBe(200);

    expect((await runBlocked(executionId))?.error).toBe("TEAM_PURGED");
    const refused = [
      await as(admin, "POST", `/api/executions/${executionId}/rerun`),
      await as(admin, "POST", `/api/executions/${executionId}/tasks/t/retry`),
      await as(admin, "POST", "/api/executions", {
        name: "x", requestId: `x-${randomUUID()}`,
        tasks: [{ id: "t", image: "i", action: "a", team: t.name }],
      }),
    ];
    for (const response of refused) {
      expect(response.statusCode).toBe(409);
      expect(response.json<{ error: string }>().error).toBe("TEAM_PURGED");
    }
    expect(submitExecution).not.toHaveBeenCalled();
    expect(retryTask).not.toHaveBeenCalled();
  });

  it("refuses a retired team's until it's un-retired", async () => {
    const t = await populatedTeam();
    const executionId = await replayableExecution(t.name, t.member.id);
    await as(admin, "POST", `/api/teams/${t.name}/retire`);

    expect((await runBlocked(executionId))?.error).toBe("TEAM_RETIRED");
    const rerun = await as(admin, "POST", `/api/executions/${executionId}/rerun`);
    expect(rerun.statusCode).toBe(409);
    expect((await as(t.member.token, "POST", `/api/executions/${executionId}/tasks/t/retry`)).statusCode).toBe(409);
    expect(submitExecution).not.toHaveBeenCalled();
    expect(retryTask).not.toHaveBeenCalled();

    await as(admin, "POST", `/api/teams/${t.name}/unretire`);
    expect(await runBlocked(executionId)).toBeNull();
    expect((await as(admin, "POST", `/api/executions/${executionId}/rerun`)).statusCode).toBe(201);
    expect((await as(t.member.token, "POST", `/api/executions/${executionId}/tasks/t/retry`)).statusCode).toBe(200);
  });
});

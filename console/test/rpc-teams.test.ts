// SPDX-License-Identifier: MIT
/**
 * TeamService through Connect: who may create, see, grow and shrink a team,
 * its lifecycle (retire, purge, a purged name reserved), and a refused
 * SecretStore file's problems as Problem details. The rules are tested in
 * depth in team-*.test.ts, through the same core/teams.ts.
 */
import { randomUUID } from "node:crypto";
import { fromBinary } from "@bufbuild/protobuf";
import { like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../src/db/client.js";
import { addTeamMember, createTeam } from "../src/db/queries.js";
import { teams } from "../src/db/schema.js";
import { ProblemSchema } from "../src/gen/acyclix/console/v1/common_pb.js";
import { buildApp } from "../src/index.js";
import { failureCode, rpcClient, type RpcError } from "./rpc.js";

vi.mock("../src/productPolicy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/productPolicy.js")>()),
  syncIdentityPolicy: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("../src/kernel/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/kernel/client.js")>()),
  getExecutionStates: vi.fn(() => Promise.resolve([])),
}));

let app: FastifyInstance;
const { rpc, makeUser, signIn, cleanUp } = rpcClient(() => app);
const prefix = `rpc-team-${randomUUID().slice(0, 6)}`;
let admin: string;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  admin = await signIn((await makeUser({ admin: true })).email);
});

afterAll(async () => {
  await app.close();
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await cleanUp();
});

describe("creating teams", () => {
  it("is for admins (or teams:create), and a second create says it already exists", async () => {
    const name = `${prefix}-made`;
    const member = await signIn((await makeUser()).email);
    expect((await rpc("TeamService", "CreateTeam", { name }, { token: member })).statusCode).toBe(403);

    const created = await rpc("TeamService", "CreateTeam", { name }, { token: admin });
    expect(created.json<{ team: { name: string } }>().team.name).toBe(name);

    const again = await rpc("TeamService", "CreateTeam", { name }, { token: admin });
    expect(again.json<RpcError>().code).toBe("already_exists");
  });

  it("ensures a team any number of times, saying when it created one", async () => {
    const name = `${prefix}-ensured`;
    const first = await rpc("TeamService", "EnsureTeam", { name }, { token: admin });
    expect(first.json<{ created: boolean }>().created).toBe(true);
    const second = await rpc("TeamService", "EnsureTeam", { name }, { token: admin });
    expect(second.json<{ created: boolean }>().created).toBe(false);
  });

  it("checks a team's name", async () => {
    const response = await rpc("TeamService", "CreateTeam", { name: "Not A Namespace" }, { token: admin });
    expect(response.json<RpcError>().code).toBe("invalid_argument");
  });
});

describe("a team's members", () => {
  it("see it and its members; anyone else is told it doesn't exist", async () => {
    const team = await createTeam(`${prefix}-seen`);
    const member = await makeUser();
    await addTeamMember(member.id, team.id);
    const token = await signIn(member.email);

    expect((await rpc("TeamService", "GetTeam", { name: team.name }, { token })).statusCode).toBe(200);
    const listed = await rpc("TeamService", "ListMembers", { team: team.name }, { token });
    expect(listed.json<{ members: { email: string }[] }>().members.map((m) => m.email)).toEqual([member.email]);

    const outsider = await signIn((await makeUser()).email);
    expect((await rpc("TeamService", "GetTeam", { name: team.name }, { token: outsider })).statusCode).toBe(404);
  });

  it("add people, and never remove the last one", async () => {
    const team = await createTeam(`${prefix}-grow`);
    const member = await makeUser();
    await addTeamMember(member.id, team.id);
    const token = await signIn(member.email);
    const newcomer = await makeUser();

    expect((await rpc("TeamService", "AddMember", { team: team.name, email: newcomer.email }, { token })).statusCode).toBe(200);
    expect((await rpc("TeamService", "RemoveMember", { team: team.name, userId: newcomer.id }, { token })).statusCode).toBe(200);

    const last = await rpc("TeamService", "RemoveMember", { team: team.name, userId: member.id }, { token });
    expect(last.json<RpcError>().code).toBe("failed_precondition");
    expect(failureCode(last.json<RpcError>())).toBe("LAST_MEMBER");
  });
});

describe("the lifecycle", () => {
  it("retires a team (read-only), purges it, and keeps its name reserved", async () => {
    const team = await createTeam(`${prefix}-gone`);
    const member = await makeUser();
    await addTeamMember(member.id, team.id);
    const token = await signIn(member.email);

    const early = await rpc("TeamService", "PurgeTeam", { name: team.name }, { token: admin });
    expect(failureCode(early.json<RpcError>())).toBe("NOT_RETIRED");

    expect((await rpc("TeamService", "RetireTeam", { name: team.name }, { token: admin })).statusCode).toBe(200);
    const readOnly = await rpc("TeamService", "AddMember", { team: team.name, email: member.email }, { token });
    expect(failureCode(readOnly.json<RpcError>())).toBe("TEAM_RETIRED");

    const purged = await rpc("TeamService", "PurgeTeam", { name: team.name }, { token: admin });
    expect(purged.json<{ alreadyPurged: boolean }>().alreadyPurged).toBe(false);
    const again = await rpc("TeamService", "PurgeTeam", { name: team.name }, { token: admin });
    expect(again.json<{ alreadyPurged: boolean }>().alreadyPurged).toBe(true);

    const reused = await rpc("TeamService", "EnsureTeam", { name: team.name }, { token: admin });
    expect(failureCode(reused.json<RpcError>())).toBe("NAME_RESERVED");
  });
});

describe("SecretStore files", () => {
  it("are refused with every problem listed", async () => {
    const team = await createTeam(`${prefix}-stores`);
    const response = await rpc(
      "TeamService",
      "ApplySecretStore",
      { team: team.name, documents: [{ kind: "Secret", metadata: { name: "x", namespace: "kube-system" } }] },
      { token: admin },
    );
    const error = response.json<RpcError>();
    expect(error.code).toBe("invalid_argument");
    const problems = (error.details ?? [])
      .filter((d) => d.type === "acyclix.console.v1.Problem")
      .map((d) => fromBinary(ProblemSchema, Buffer.from(d.value, "base64")).message);
    expect(problems.length).toBeGreaterThan(0);
  });
});

// SPDX-License-Identifier: MIT
/**
 * What runs made, and deleting it (src/resourceRecorder.ts,
 * src/core/resources.ts): a finished run's reported resources are kept with
 * their step's inputs and outputs, checked as they come from a container;
 * who sees and who deletes them; deleting runs the product's cleanup
 * action, newest first, with its inputs as product.yaml maps them; and a
 * resource is deleted once that step succeeds, or free to delete again.
 * kernel-api and the registry are stubbed; the rest is the real console on
 * the real test database.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupInputs } from "../src/core/resources.js";
import { db } from "../src/db/client.js";
import { addTeamMember, createTeam, upsertProduct } from "../src/db/queries.js";
import { products, resources, submittedExecutions, teams } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { submitExecution, type KernelExecution } from "../src/kernel/client.js";
import { recordFinishedRuns, reportedResources, resolvedInputs } from "../src/resourceRecorder.js";
import { caller, rpcClient } from "./rpc.js";

/** The runs kernel-api knows: what each answers. */
const kernelRuns = new Map<string, KernelExecution>();

vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  ensureServiceAccount: vi.fn(() => Promise.resolve()),
  updateIdentityPolicy: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("../src/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/registry.js")>()),
  missingImages: vi.fn(() => Promise.resolve([])),
  pinImages: vi.fn((images: string[]) =>
    Promise.resolve({ pinned: new Map(images.map((i) => [i, `${i}@sha256:${"c".repeat(64)}`])), unresolved: [] }),
  ),
}));
vi.mock("../src/kernel/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/kernel/client.js")>();
  const { randomUUID: uuid } = await import("node:crypto");
  return {
    ...actual,
    submitExecution: vi.fn(() => Promise.resolve({ executionId: uuid(), state: "PENDING", created: true })),
    getExecutionStates: vi.fn((ids: string[]) =>
      Promise.resolve(
        ids.flatMap((id) => {
          const run = kernelRuns.get(id);
          return run ? [{ executionId: id, state: run.state, steps: {}, createdAt: null, updatedAt: null }] : [];
        }),
      ),
    ),
    getExecution: vi.fn((id: string) => Promise.resolve(kernelRuns.get(id) ?? { executionId: id, name: "x", state: "RUNNING", tasks: [] })),
  };
});
vi.mock("../src/imagePolicy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/imagePolicy.js")>()),
  readImagePolicy: vi.fn(() => Promise.resolve({ exists: true, source: "registry.example/", additional: [], version: "1" })),
}));

const prefix = `res-${randomUUID().slice(0, 6)}`;
const prov = `${prefix}-prov`;
const cons = `${prefix}-cons`;

let app: FastifyInstance;
const users = rpcClient(() => app);
const call = caller(() => app);
let consumerToken: string;
let providerToken: string;
let outsiderToken: string;

const anyObject = { type: "object" };

/** A step's status as kernel-api gives it. */
function step(taskId: string, state: string, outputs: Record<string, unknown> | null = null) {
  return {
    taskId,
    state,
    attemptCount: 1,
    outputs,
    failure: null,
    dependsOn: [],
    startedAt: null,
    completedAt: null,
    attempts: [],
    approvalRequired: false,
    approvedBy: "",
    approvedAt: null,
    awaitingSince: null,
    waitingFor: null,
  };
}

/** The run kernel-api last got. */
const lastSubmitted = () => {
  const result = vi.mocked(submitExecution).mock.results.at(-1)?.value as Promise<{ executionId: string }>;
  const dag = vi.mocked(submitExecution).mock.calls.at(-1)?.[0] as { tasks: Record<string, unknown>[] };
  return { result, dag };
};

/** Records finished runs until this one is. */
async function recorded(executionId: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const [row] = await db.select({ at: submittedExecutions.resourcesRecordedAt }).from(submittedExecutions).where(eq(submittedExecutions.executionId, executionId));
    if (row?.at) return;
    await recordFinishedRuns();
  }
  throw new Error(`${executionId} was never recorded`);
}

/** Runs an action for the consumer's team and finishes it with these outputs. */
async function ranAndFinished(product: string, inputs: Record<string, unknown>, outputs: Record<string, unknown>): Promise<string> {
  const run = await call<{ executionId: string }>(consumerToken, "TemplateService/RunAction", { product, inputs, onBehalfOf: cons });
  expect(run.code).toBe("ok");
  const executionId = run.body.executionId;
  const action = product.split("-").at(-1) ?? "";
  kernelRuns.set(executionId, { executionId, name: "x", state: "SUCCEEDED", tasks: [step(action, "SUCCEEDED", outputs)] });
  await recorded(executionId);
  return executionId;
}

type Listed = { resources?: { id: string; externalId: string; link: string; state: string; canDelete: boolean; ownerTeam: string }[] };
const list = async (token: string, body: object) => (await call<Listed>(token, "ResourceService/ListResources", body)).body.resources ?? [];

beforeAll(async () => {
  app = await buildApp();
  const provTeam = await createTeam(prov);
  await createTeam(cons);
  const register = (name: string, action: string, extra: Partial<Parameters<typeof upsertProduct>[0]> = {}) =>
    upsertProduct({
      name: `${prov}-${name}-${action}`,
      image: `registry.example/${prov}/${name}:1`,
      action,
      teamId: provTeam.id,
      shareWith: ["*"],
      inputSchema: anyObject,
      ...extra,
    });
  await register("thing", "create", { cleanup: { action: "delete", inputs: null } });
  await register("thing", "delete", { inputSchema: { type: "object", required: ["resource"], properties: { resource: { type: "object" } } } });
  await register("project", "create", { cleanup: { action: "remove", inputs: { project: { $input: "project" }, id: { $resource: "id" }, zone: { $output: "zone" }, force: true } } });
  await register("project", "remove");
  await register("note", "create");

  const consumer = await users.makeUser();
  const provider = await users.makeUser();
  const outsider = await users.makeUser();
  const [consTeam] = await db.select().from(teams).where(eq(teams.name, cons));
  await addTeamMember(consumer.id, consTeam?.id ?? "", "member");
  await addTeamMember(provider.id, provTeam.id, "member");
  [consumerToken, providerToken, outsiderToken] = await Promise.all([consumer, provider, outsider].map((u) => users.signIn(u.email)));
});

beforeEach(() => {
  vi.mocked(submitExecution).mockClear();
});

afterAll(async () => {
  await db.delete(resources).where(like(resources.productTeam, `${prefix}%`));
  await db.delete(submittedExecutions).where(inArray(submittedExecutions.onBehalfOf, [cons]));
  await db.delete(products).where(like(products.name, `${prefix}%`));
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await users.cleanUp();
  await app.close();
});

describe("what a step reports", () => {
  it("keeps a type and an id, a name, and only an http(s) link", () => {
    expect(
      reportedResources({
        resources: [
          { type: "demo/thing", id: "t-1", name: "Thing", link: "https://example.com/t-1" },
          { type: "demo/thing" },
          { type: "demo/thing", id: "t-2", link: "javascript:alert(1)" },
          "t-3",
        ],
      }),
    ).toEqual([
      { type: "demo/thing", id: "t-1", name: "Thing", link: "https://example.com/t-1" },
      { type: "demo/thing", id: "t-2", name: null, link: null },
    ]);
    expect(reportedResources({ resources: "t-1" })).toEqual([]);
    expect(reportedResources(null)).toEqual([]);
  });

  it("is kept with its step's inputs as the kernel resolved them", () => {
    expect(resolvedInputs({ project: { $fromTask: "a", $output: "id" }, size: 2 }, new Map([["a", { id: "p-1" }]]))).toEqual({ project: "p-1", size: 2 });
  });

  it("is given to cleanup as the resource, or as product.yaml maps it", () => {
    const recorded = { inputs: { project: "p-1" }, outputs: { zone: "eu" }, type: "gcp/project", externalId: "p-1", name: null, link: "https://x" };
    expect(cleanupInputs(null, recorded)).toEqual({ resource: { type: "gcp/project", id: "p-1", link: "https://x" } });
    expect(cleanupInputs({ project: { $input: "project" }, zone: { $output: "zone" }, id: { $resource: "id" }, gone: { $input: "nope" }, force: true }, recorded)).toEqual({
      project: "p-1",
      zone: "eu",
      id: "p-1",
      force: true,
    });
  });
});

describe("what runs made", () => {
  it("is recorded once its run finishes, for its team, its product's team and whoever ran it", async () => {
    const executionId = await ranAndFinished(`${prov}-thing-create`, {}, {
      resources: [
        { type: "demo/thing", id: `${prefix}-t1`, link: "https://example.com/t1" },
        { type: "demo/thing", id: `${prefix}-t2` },
      ],
    });
    const mine = await list(consumerToken, { executionId });
    expect(mine.map((r) => r.externalId).sort()).toEqual([`${prefix}-t1`, `${prefix}-t2`]);
    expect(mine.every((r) => r.state === "exists" && r.canDelete && r.ownerTeam === cons)).toBe(true);
    // The product's team sees what its product made; it isn't theirs to delete.
    expect((await list(providerToken, { executionId })).map((r) => r.canDelete)).toEqual([false, false]);
    expect(await list(outsiderToken, { executionId })).toEqual([]);
    // Found by a search, too.
    expect((await list(consumerToken, { query: `${prefix}-t1` })).map((r) => r.externalId)).toEqual([`${prefix}-t1`]);
  });

  it("is deleted by its product's cleanup, newest first, and marked once each step succeeds", async () => {
    const executionId = await ranAndFinished(`${prov}-thing-create`, {}, {
      resources: [{ type: "demo/thing", id: `${prefix}-a` }, { type: "demo/thing", id: `${prefix}-b` }],
    });
    expect((await call(outsiderToken, "ResourceService/DeleteRunResources", { executionId })).code).toBe("not_found");
    const asked = await call<{ executionId: string }>(consumerToken, "ResourceService/DeleteRunResources", { executionId });
    expect(asked.code).toBe("ok");
    const { dag } = lastSubmitted();
    expect(dag.tasks.map((t) => [t["id"], t["action"], t["dependsOn"]])).toEqual([
      ["delete-1", "delete", undefined],
      ["delete-2", "delete", ["delete-1"]],
    ]);
    const deleted = dag.tasks.map((t) => (t["inputs"] as { resource: { id: string } }).resource.id).sort();
    expect(deleted).toEqual([`${prefix}-a`, `${prefix}-b`]);
    // The consumer's own cleanup run, for their team.
    const [cleanup] = await db.select().from(submittedExecutions).where(eq(submittedExecutions.executionId, asked.body.executionId));
    expect(cleanup).toMatchObject({ template: "cleanup", onBehalfOf: cons });

    expect((await list(consumerToken, { executionId })).map((r) => r.state)).toEqual(["deleting", "deleting"]);
    expect((await call(consumerToken, "ResourceService/DeleteRunResources", { executionId })).code).toBe("not_found");

    // The first delete worked, the second didn't.
    kernelRuns.set(asked.body.executionId, { executionId: asked.body.executionId, name: "x", state: "FAILED", tasks: [step("delete-1", "SUCCEEDED"), step("delete-2", "FAILED")] });
    await recorded(asked.body.executionId);
    const after = await list(consumerToken, { executionId, includeDeleted: true });
    expect(after.map((r) => r.state).sort()).toEqual(["delete_failed", "deleted"]);
    expect(after.find((r) => r.state === "delete_failed")?.canDelete).toBe(true);
    expect(await list(consumerToken, { executionId })).toHaveLength(1);
  });

  it("gives a cleanup the inputs its product.yaml maps, from what the step was given and gave", async () => {
    const executionId = await ranAndFinished(`${prov}-project-create`, { project: "acme-web" }, { zone: "eu-west", resources: [{ type: "demo/project", id: `${prefix}-p` }] });
    const [made] = await list(consumerToken, { executionId });
    expect((await call(consumerToken, "ResourceService/DeleteResources", { resourceIds: [made?.id] })).code).toBe("ok");
    expect(lastSubmitted().dag.tasks[0]).toMatchObject({ action: "remove", inputs: { project: "acme-web", id: `${prefix}-p`, zone: "eu-west", force: true } });
  });

  it("is only its person's when the run was for no team", async () => {
    const run = await call<{ executionId: string }>(consumerToken, "TemplateService/RunAction", { product: `${prov}-thing-create`, inputs: {} });
    const executionId = run.body.executionId;
    kernelRuns.set(executionId, { executionId, name: "x", state: "SUCCEEDED", tasks: [step("create", "SUCCEEDED", { resources: [{ type: "demo/thing", id: `${prefix}-solo` }] })] });
    await recorded(executionId);
    const [mine] = await list(consumerToken, { executionId });
    expect(mine).toMatchObject({ ownerTeam: "", canDelete: true });
    // Not the product's team's to delete, though they see it.
    expect((await list(providerToken, { executionId })).map((r) => r.canDelete)).toEqual([false]);
  });

  it("stays its first owner's when someone else's run reports it too", async () => {
    const id = `${prefix}-shared`;
    const first = await ranAndFinished(`${prov}-thing-create`, {}, { resources: [{ type: "demo/thing", id }] });
    // The product's own team runs it for itself: the same thing, found existing.
    const run = await call<{ executionId: string }>(providerToken, "TemplateService/RunAction", { product: `${prov}-thing-create`, inputs: {} });
    kernelRuns.set(run.body.executionId, { executionId: run.body.executionId, name: "x", state: "SUCCEEDED", tasks: [step("create", "SUCCEEDED", { resources: [{ type: "demo/thing", id }] })] });
    await recorded(run.body.executionId);
    const [kept] = await db.select().from(resources).where(eq(resources.externalId, id));
    expect(kept).toMatchObject({ ownerTeam: cons, executionId: first });
    expect((await list(providerToken, { query: id })).map((r) => r.canDelete)).toEqual([false]);
  });

  it("can't be deleted when its product says nothing about how", async () => {
    const executionId = await ranAndFinished(`${prov}-note-create`, {}, { resources: [{ type: "demo/note", id: `${prefix}-n` }] });
    const [note] = await list(consumerToken, { executionId });
    expect(note?.canDelete).toBe(false);
    const refused = await call(consumerToken, "ResourceService/DeleteResources", { resourceIds: [note?.id] });
    expect(refused.failure).toBe("NO_CLEANUP");
    expect(vi.mocked(submitExecution)).toHaveBeenCalledTimes(1); // only the run that made it
  });
});

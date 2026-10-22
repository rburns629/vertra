// SPDX-License-Identifier: MIT
/**
 * Observe's security checks: what's enforced, what was refused (a run
 * linked only for those who may see it), and every image allowed to run
 * with its scan (a hidden product's only for its team).
 */
import { randomUUID } from "node:crypto";
import { inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../src/db/client.js";
import { addTeamMember, createTeam, recordSubmittedExecution, upsertProduct } from "../src/db/queries.js";
import { imageScans, products, submittedExecutions, teams } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { caller, rpcClient } from "./rpc.js";

const digest = `sha256:${"e".repeat(64)}`;
const prefix = `obs-${randomUUID().slice(0, 6)}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const executionId = randomUUID();

vi.mock("../src/kernel/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/kernel/client.js")>()),
  getStats: vi.fn(() =>
    Promise.resolve({
      hours: [{ hour: new Date().toISOString(), started: 12, waitP95Seconds: 3.5 }],
      failures: [{ code: "TASK_TIMEOUT", count: 2, retried: true }],
      steps: [
        { repository: `registry.example/${owner}/${owner}-shown-run`, action: "run", team: owner, attempts: 10, succeeded: 9, p50Seconds: 4, p95Seconds: 9 },
        { repository: `registry.example/${owner}/${owner}-secret-run`, action: "run", team: owner, attempts: 3, succeeded: 3, p50Seconds: 1, p95Seconds: 2 },
      ],
      ready: 1,
      running: 2,
    }),
  ),
  listRefusals: vi.fn(() =>
    Promise.resolve([{ executionId, taskId: "make", team: owner, image: `registry.example/x@${digest}`, code: "IMAGE_NOT_ALLOWED", message: "m", at: new Date().toISOString() }]),
  ),
}));
vi.mock("../src/imagePolicy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/imagePolicy.js")>()),
  readImagePolicy: vi.fn(() => Promise.resolve({ exists: true, source: "registry.example/", additional: [], version: "1" })),
}));
vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  ensureServiceAccount: vi.fn(() => Promise.resolve()),
  updateIdentityPolicy: vi.fn(() => Promise.resolve(true)),
}));

let app: FastifyInstance;
const users = rpcClient(() => app);
const call = caller(() => app);
const tokens = { owner: "", other: "" };

beforeAll(async () => {
  app = await buildApp();
  const [ownerTeam, otherTeam] = [await createTeam(owner), await createTeam(other)];
  for (const [name, hidden] of [[`${owner}-shown-run`, false], [`${owner}-secret-run`, true]] as const) {
    await upsertProduct({ name, image: `registry.example/${owner}/${name}@${digest}`, action: "run", teamId: ownerTeam.id, hidden });
  }
  await db.insert(imageScans).values({ digest, image: `registry.example/x@${digest}`, status: "failed", findings: { fixable: 2, unfixable: 1, secrets: 0 }, scannedAt: new Date() }).onConflictDoNothing();
  const [a, b] = [await users.makeUser(), await users.makeUser()];
  await addTeamMember(a.id, ownerTeam.id, "member");
  await addTeamMember(b.id, otherTeam.id, "member");
  tokens.owner = await users.signIn(a.email);
  tokens.other = await users.signIn(b.email);
  await recordSubmittedExecution({ executionId, teams: [owner], submittedBy: a.id, name: "x", payload: { name: "x", tasks: [] } });
});

afterAll(async () => {
  await db.delete(submittedExecutions).where(inArray(submittedExecutions.executionId, [executionId]));
  await db.delete(products).where(like(products.name, `${prefix}%`));
  await db.delete(imageScans).where(inArray(imageScans.digest, [digest]));
  const ours = await db.select({ id: teams.id }).from(teams).where(like(teams.name, `${prefix}%`));
  if (ours.length > 0) await db.delete(teams).where(inArray(teams.id, ours.map((t) => t.id)));
  await users.cleanUp();
  await app.close();
});

type Security = {
  checks: { name: string; state: string }[];
  refusals: { code: string; why: string; executionId: string; team: string }[];
  images: { product: string; scan: string; fixable: number }[];
};
const security = async (who: keyof typeof tokens) => (await call<Security>(tokens[who], "ObserveService/GetSecurity")).body;

describe("security checks", () => {
  it("say what's enforced and what isn't yet", async () => {
    const s = await security("other");
    expect(s.checks.find((c) => c.name === "Images only from allowed sources")?.state).toBe("enforced");
    expect(s.checks.some((c) => c.state === "not_yet")).toBe(true);
  });

  it("show everyone what was refused, linking the run only for those who may see it", async () => {
    const mine = (await security("owner")).refusals.find((r) => r.team === owner);
    expect(mine).toMatchObject({ code: "IMAGE_NOT_ALLOWED", executionId });
    expect(mine?.why).toContain("allows");
    const theirs = (await security("other")).refusals.find((r) => r.team === owner);
    expect(theirs?.code).toBe("IMAGE_NOT_ALLOWED");
    expect(theirs?.executionId ?? "").toBe("");
  });

  it("list every image allowed to run with its scan, a hidden product's for its team only", async () => {
    const names = async (who: keyof typeof tokens) => (await security(who)).images.filter((i) => i.product.startsWith(prefix));
    expect((await names("owner")).map((i) => i.product).sort()).toEqual([`${owner}-secret-run`, `${owner}-shown-run`]);
    const theirs = await names("other");
    expect(theirs.map((i) => i.product)).toEqual([`${owner}-shown-run`]);
    expect(theirs[0]).toMatchObject({ scan: "failed", fixable: 2 });
  });
});

describe("metrics", () => {
  type Metrics = { hours: { started: number }[]; failures: { code: string; means: string; retried: boolean }[]; products: { product: string; steps: number }[]; running: number };
  const metrics = async (who: keyof typeof tokens) => (await call<Metrics>(tokens[who], "ObserveService/GetMetrics")).body;

  it("name each product's steps, a hidden one only for its team, and explain the failures", async () => {
    const mine = await metrics("owner");
    expect(mine.products.map((p) => p.product).sort()).toEqual([`${owner}-secret-run`, `${owner}-shown-run`]);
    expect(mine.failures[0]).toMatchObject({ code: "TASK_TIMEOUT", retried: true });
    expect(mine.failures[0]?.means).toContain("timeout");
    expect(mine.running).toBe(2);
    expect((await metrics("other")).products.map((p) => p.product)).toEqual([`${owner}-shown-run`]);
  });
});

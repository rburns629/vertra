// SPDX-License-Identifier: MIT
/**
 * Observe's usage (ObserveService.GetUsage): runs counted for the team they
 * were run for, by people, bots or schedules, readiness checks left out;
 * the products they used; and what each caller may see of it.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { addTeamMember, createTeam, upsertProduct } from "../src/db/queries.js";
import { products, submittedExecutions, teams, users as userTable } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { caller, rpcClient } from "./rpc.js";

const prefix = `use-${randomUUID().slice(0, 6)}`;
const [provider, consumer, third] = [`${prefix}-a`, `${prefix}-b`, `${prefix}-c`];
const digest = `sha256:${"a".repeat(64)}`;
const prov = `registry.example/${provider}/prov`;
const sec = `registry.example/${provider}/sec`;
const own = `registry.example/${consumer}/own`;
const runIds: string[] = [];

let app: FastifyInstance;
const users = rpcClient(() => app);
const call = caller(() => app);
const tokens = { admin: "", provider: "", consumer: "", third: "" };

const step = (image: string, team: string, id = randomUUID().slice(0, 8)) => ({ id, image, action: "run", team });

async function run(values: {
  teams: string[];
  submittedBy: string | null;
  tasks: ReturnType<typeof step>[];
  template?: string;
  onBehalfOf?: string;
  scheduleId?: string;
  daysAgo?: number;
}) {
  const executionId = randomUUID();
  runIds.push(executionId);
  const { tasks, daysAgo = 0, ...rest } = values;
  await db.insert(submittedExecutions).values({
    executionId,
    name: "x",
    payload: { name: "x", tasks },
    createdAt: new Date(Date.now() - daysAgo * 24 * 3_600_000),
    ...rest,
  });
}

beforeAll(async () => {
  app = await buildApp();
  const [a, b, c] = [await createTeam(provider), await createTeam(consumer), await createTeam(third)];
  await upsertProduct({ name: `${prefix}-prov`, image: `${prov}@${digest}`, action: "run", teamId: a.id });
  await upsertProduct({ name: `${prefix}-sec`, image: `${sec}@${digest}`, action: "run", teamId: a.id, hidden: true });
  const admin = await users.makeUser({ admin: true });
  const [pa, pb, pc, bot] = [await users.makeUser(), await users.makeUser(), await users.makeUser(), await users.makeUser()];
  await addTeamMember(pa.id, a.id, "member");
  await addTeamMember(pb.id, b.id, "member");
  await addTeamMember(pc.id, c.id, "member");
  await db.update(userTable).set({ isBot: true }).where(eq(userTable.id, bot.id));
  tokens.admin = await users.signIn(admin.email);
  tokens.provider = await users.signIn(pa.email);
  tokens.consumer = await users.signIn(pb.email);
  tokens.third = await users.signIn(pc.email);

  const template = `${provider}/prov`;
  // For the consumer: a person, a schedule (as a bot) and a bot, and one the week before.
  await run({ teams: [provider, consumer], submittedBy: pb.id, template, onBehalfOf: consumer, tasks: [step(`${prov}:1@${digest}`, provider), step(`${own}:2`, consumer)] });
  await run({ teams: [provider], submittedBy: bot.id, template, onBehalfOf: consumer, scheduleId: randomUUID(), tasks: [step(`${prov}@${digest}`, provider)] });
  await run({ teams: [provider], submittedBy: bot.id, template, onBehalfOf: consumer, tasks: [step(`${prov}@${digest}`, provider)] });
  await run({ teams: [provider], submittedBy: pb.id, template, onBehalfOf: consumer, tasks: [step(`${prov}@${digest}`, provider)], daysAgo: 10 });
  // A raw DAG in the provider's own namespace, with its hidden product.
  await run({ teams: [provider], submittedBy: pa.id, tasks: [step(`${prov}@${digest}`, provider), step(`${sec}@${digest}`, provider)] });
  // For no team; and a readiness check, which doesn't count.
  await run({ teams: [provider], submittedBy: pc.id, template, tasks: [step(`${prov}@${digest}`, provider)] });
  await run({ teams: [provider], submittedBy: null, template: "check", tasks: [step(`${prov}@${digest}`, provider)] });
  // The third team uses the hidden product.
  await run({ teams: [provider], submittedBy: pc.id, template: `${provider}/sec`, onBehalfOf: third, tasks: [step(`${sec}@${digest}`, provider)] });
});

afterAll(async () => {
  await db.delete(submittedExecutions).where(inArray(submittedExecutions.executionId, runIds));
  await db.delete(products).where(like(products.name, `${prefix}%`));
  const ours = await db.select({ id: teams.id }).from(teams).where(like(teams.name, `${prefix}%`));
  if (ours.length > 0) await db.delete(teams).where(inArray(teams.id, ours.map((t) => t.id)));
  await users.cleanUp();
  await app.close();
});

type Count = { name: string; count: number };
type Usage = {
  teams: { team?: string; runs?: number; previousRuns?: number; byPeople?: number; byBots?: number; bySchedules?: number; steps?: number; used?: Count[]; ranFor?: Count[] }[];
  products: { product: string; team: string; registered?: boolean; steps?: number; runs?: number; usedBy?: Count[] }[];
};
const usage = async (who: keyof typeof tokens) => {
  const res = await call<Usage>(tokens[who], "ObserveService/GetUsage", { days: 7 });
  expect(res.code).toBe("ok");
  return res.body;
};
const ours = (u: Usage) => u.teams.filter((t) => (t.team ?? "").startsWith(prefix));
const counts = (list: Count[] | undefined) => Object.fromEntries((list ?? []).map((c) => [c.name, c.count]));
const product = (u: Usage, name: string) => u.products.find((p) => p.product === name);

describe("usage", () => {
  it("counts runs for the team they were run for, by who started them, without readiness checks", async () => {
    const u = await usage("admin");
    const b = u.teams.find((t) => t.team === consumer);
    expect(b).toMatchObject({ runs: 3, previousRuns: 1, byPeople: 1, byBots: 1, bySchedules: 1, steps: 4 });
    expect(counts(b?.used)).toEqual({ [`${prefix}-prov`]: 3, [own]: 1 });
    const a = u.teams.find((t) => t.team === provider);
    expect(a).toMatchObject({ runs: 1, steps: 2 });
    // Its products ran for: the consumer, itself, no team (not the check) and the third team.
    expect(counts(a?.ranFor)).toEqual({ [consumer]: 3, [provider]: 2, "": 1, [third]: 1 });
    expect(counts(product(u, `${prefix}-prov`)?.usedBy)).toEqual({ [consumer]: 3, [provider]: 1, "": 1 });
  });

  it("shows anyone else only their teams, their products' users and their own use of others'", async () => {
    const b = await usage("consumer");
    expect(ours(b).map((t) => t.team)).toEqual([consumer]);
    expect(counts(product(b, `${prefix}-prov`)?.usedBy)).toEqual({ [consumer]: 3 });
    expect(product(b, `${prefix}-sec`)).toBeUndefined();

    const a = await usage("provider");
    expect(ours(a).map((t) => t.team)).toEqual([provider]);
    expect(counts(product(a, `${prefix}-prov`)?.usedBy)).toEqual({ [consumer]: 3, [provider]: 1, "": 1 });
    expect(counts(product(a, `${prefix}-sec`)?.usedBy)).toEqual({ [provider]: 1, [third]: 1 });
    expect(a.teams.some((t) => !t.team)).toBe(false);
  });

  it("names a hidden product only for its team", async () => {
    const c = await usage("third");
    expect(ours(c).map((t) => t.team)).toEqual([third]);
    expect(counts(ours(c)[0]?.used)).toEqual({ [sec]: 1 });
    expect(product(c, `${prefix}-sec`)).toBeUndefined();
    expect(product(c, sec)).toMatchObject({ team: provider, usedBy: [{ name: third, count: 1 }] });
  });

  it("takes a day, a week or a month, signed in", async () => {
    expect((await call(tokens.consumer, "ObserveService/GetUsage", { days: 3 })).code).toBe("invalid_argument");
    expect((await call("", "ObserveService/GetUsage", { days: 7 })).code).toBe("unauthenticated");
  });
});

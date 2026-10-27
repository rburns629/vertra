// SPDX-License-Identifier: MIT
/**
 * The order builder (src/core/orders.ts, decision 23): a cart wired by
 * wiring type, a default provider added, a shared type asked once, a choice
 * left to the person, a cycle reported; and PreviewOrder's own checks (its
 * team's members, no ordering bot, only actions shared with the caller) on
 * the real test database.
 */
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { planOrder } from "../src/core/orders.js";
import type { TeamProduct } from "../src/core/templates.js";
import { db } from "../src/db/client.js";
import { addTeamMember, createTeam, findTeamByName, upsertProduct } from "../src/db/queries.js";
import { wiringTypes } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { caller, rpcClient } from "./rpc.js";
import { lockWiringTypes } from "./wiringTypesLock.js";

/** A product, as planOrder needs it: what it needs and provides, by wiring type ("": none). */
function product(name: string, needs: Record<string, string | [string, "optional"]>, provides: Record<string, string> = {}): TeamProduct {
  const required = Object.entries(needs).filter(([, t]) => typeof t === "string").map(([n]) => n);
  return {
    name: `platform-${name}-create`,
    teamName: "platform",
    action: "create",
    shareWith: ["*"],
    inputSchema: {
      type: "object",
      required,
      properties: Object.fromEntries(
        Object.entries(needs).map(([n, t]) => {
          const wiring = typeof t === "string" ? t : t[0];
          return [n, { type: "string", ...(wiring ? { "x-vertra-needs": wiring } : {}) }];
        }),
      ),
    },
    outputSchema: { type: "object", properties: Object.fromEntries(Object.entries(provides).map(([n, t]) => [n, { type: "string", "x-vertra-provides": t }])) },
  } as unknown as TeamProduct;
}

const project = product("project", { name: "" }, { projectId: "gcp.project" });
const network = product("network", { project: "gcp.project", region: "gcp.region" }, { network: "gcp.network" });
const vm = product("vm", { project: "gcp.project", network: "gcp.network", region: "gcp.region" }, { ip: "ip" });
const types = [
  { name: "gcp.project", shared: false, defaultProvider: "platform/project.create" },
  { name: "gcp.network", shared: false, defaultProvider: null },
  { name: "gcp.region", shared: true, defaultProvider: null },
];
const defaults = new Map([["platform/project.create", project]]);

describe("planning an order", () => {
  it("wires each input to the one output of its type, each step after what it takes from", () => {
    const { steps, problems } = planOrder([vm, network, project], types, defaults, []);
    expect(problems).toEqual([]);
    expect(steps.map((s) => s.id)).toEqual(["project", "network", "vm"]);
    expect(steps.find((s) => s.id === "vm")?.inputs).toEqual({
      project: { kind: "step", step: "project", output: "projectId" },
      network: { kind: "step", step: "network", output: "network" },
      // A shared type: one parameter, named for it, for every input of it.
      region: { kind: "parameter", parameter: "gcp.region" },
    });
    expect(steps.find((s) => s.id === "network")?.inputs["region"]).toEqual({ kind: "parameter", parameter: "gcp.region" });
    // An input with no wiring type is the person's to fill.
    expect(steps.find((s) => s.id === "project")?.inputs["name"]).toEqual({ kind: "unset" });
  });

  it("adds a type's default provider when nothing in the cart provides it, once", () => {
    const { steps, problems } = planOrder([vm, network], types, defaults, []);
    expect(problems).toEqual([]);
    expect(steps.map((s) => [s.id, s.added])).toEqual([["project", true], ["network", false], ["vm", false]]);
    // Not available to the caller: said, not added.
    const without = planOrder([network], types, new Map([["platform/project.create", null]]), []);
    expect(without.steps.map((s) => s.id)).toEqual(["network"]);
    expect(without.problems).toMatchObject([{ code: "NO_PROVIDER", step: "network", input: "project" }]);
  });

  it("leaves an input two outputs could fill to the person, until they choose", () => {
    const other = product("other-project", {}, { projectId: "gcp.project" });
    const open = planOrder([project, other, network], types, defaults, []);
    expect(open.steps.find((s) => s.id === "network")?.inputs["project"]).toEqual({ kind: "unset" });
    expect(open.problems).toMatchObject([
      {
        code: "AMBIGUOUS",
        step: "network",
        input: "project",
        options: [
          { fromStep: "project", fromOutput: "projectId" },
          { fromStep: "other-project", fromOutput: "projectId" },
        ],
      },
    ]);
    const chosen = planOrder([project, other, network], types, defaults, [{ step: "network", input: "project", fromStep: "other-project", fromOutput: "projectId" }]);
    expect(chosen.problems).toEqual([]);
    expect(chosen.steps.find((s) => s.id === "network")?.inputs["project"]).toEqual({ kind: "step", step: "other-project", output: "projectId" });
  });

  it("reports steps that feed each other round in a circle", () => {
    const a = product("a", { b: "type.b" }, { a: "type.a" });
    const b = product("b", { a: "type.a" }, { b: "type.b" });
    const { steps, problems } = planOrder([a, b], [], new Map(), []);
    expect(steps.map((s) => s.id)).toEqual(["a", "b"]);
    expect(problems).toMatchObject([{ code: "CYCLE", step: "a, b" }]);
  });

  it("gives the same action twice two steps", () => {
    const { steps } = planOrder([project, project], types, defaults, []);
    expect(steps.map((s) => s.id)).toEqual(["project", "project-2"]);
  });
});

const prefix = `ord-${randomUUID().slice(0, 6)}`;
const team = `${prefix}-shop`;
const other = `${prefix}-other`;
let app: FastifyInstance;
let unlock: () => Promise<void>;
const users = rpcClient(() => app);
const call = caller(() => app);

beforeAll(async () => {
  unlock = await lockWiringTypes();
  app = await buildApp();
  const shop = await createTeam(team);
  const otherTeam = await createTeam(other);
  // Wiring types of this test's own, beside whatever the catalog has.
  await db.insert(wiringTypes).values([
    { name: `${prefix}.project`, jsonType: "string", description: "", shared: false, defaultProvider: `${team}/project.create` },
  ]);
  await upsertProduct({
    name: `${team}-project-create`,
    image: `registry.example/${team}/project:1`,
    action: "create",
    teamId: shop.id,
    outputSchema: { type: "object", properties: { projectId: { type: "string", "x-vertra-provides": `${prefix}.project` } } },
  });
  await upsertProduct({
    name: `${team}-bucket-create`,
    image: `registry.example/${team}/bucket:1`,
    action: "create",
    teamId: shop.id,
    inputSchema: { type: "object", required: ["project"], properties: { project: { type: "string", "x-vertra-needs": `${prefix}.project` } } },
  });
  await upsertProduct({ name: `${other}-secret-get`, image: `registry.example/${other}/secret:1`, action: "get", teamId: otherTeam.id });
});

afterAll(async () => {
  await db.delete(wiringTypes).where(inArray(wiringTypes.name, [`${prefix}.project`]));
  await app.close();
  await unlock();
});

describe("PreviewOrder", () => {
  it("wires a cart for a member of its team, adding the default provider", async () => {
    const member = await users.makeUser();
    await join(member.id, team);
    const token = await users.signIn(member.email);
    const preview = await call<{ steps: { id: string; product: string; added?: boolean; inputs: Record<string, unknown> }[]; problems?: unknown[] }>(
      token,
      "OrderService/PreviewOrder",
      { team, actions: [`${team}-bucket-create`] },
    );
    expect(preview.code).toBe("ok");
    expect(preview.body.steps.map((s) => [s.id, s.added ?? false])).toEqual([["project", true], ["bucket", false]]);
    expect(preview.body.steps[1]?.inputs["project"]).toMatchObject({ kind: "step", step: "project", output: "projectId" });
    expect(preview.body.problems ?? []).toEqual([]);

    // Not for a team they aren't in; not an action that isn't shared with them.
    expect((await call(token, "OrderService/PreviewOrder", { team: other, actions: [`${team}-bucket-create`] })).code).toBe("permission_denied");
    expect((await call(token, "OrderService/PreviewOrder", { team, actions: [`${other}-secret-get`] })).code).toBe("not_found");
  });

  it("isn't for an ordering bot: carts become templates first", async () => {
    const maintainer = await users.makeUser();
    await join(maintainer.id, team, "maintainer");
    const made = await call<{ token: string }>(await users.signIn(maintainer.email), "TokenService/CreateBotToken", {
      team, email: `${prefix}-orders@bot.example.com`, label: "storefront", ordering: true, orderTemplates: [],
    });
    expect((await call(made.body.token, "OrderService/PreviewOrder", { team, actions: [`${team}-bucket-create`] })).failure).toBe("ORDERS_ONLY");
  });
});

async function join(userId: string, name: string, role: "member" | "maintainer" = "member") {
  const found = await findTeamByName(name);
  await addTeamMember(userId, found?.id ?? "", role);
}

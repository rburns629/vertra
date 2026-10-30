// SPDX-License-Identifier: MIT
/**
 * Observe's alerts (src/core/alerts.ts): read from a Prometheus's own rules
 * API (stubbed here), only the charts' groups, firing first; an instance
 * about another team's hidden API counted, not described, except to an
 * admin; a Prometheus not answering said so; none configured, nothing.
 */
import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { applyApis } from "../src/catalogSync.js";
import { config } from "../src/config.js";
import { db } from "../src/db/client.js";
import { addTeamMember, createTeam, findTeamByName } from "../src/db/queries.js";
import { teams } from "../src/db/schema.js";
import { ApiSchema } from "../src/gen/vertra/catalog/v1/release_pb.js";
import { buildApp } from "../src/index.js";
import { caller, rpcClient } from "./rpc.js";

vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  ensureServiceAccount: vi.fn(() => Promise.resolve()),
}));

const prefix = `alr-${randomUUID().slice(0, 6)}`;
const owner = `${prefix}-pay`;
const other = `${prefix}-web`;
const PROMETHEUS = `http://prometheus-${prefix}.test:9090`;

let app: FastifyInstance;
const users = rpcClient(() => app);
const call = caller(() => app);
const tokens = { owner: "", other: "", admin: "" };
let answer: () => Promise<Response>;

const rule = (name: string, state: string, summary: string, alerts: { labels: Record<string, string>; summary: string; state?: string }[] = []) => ({
  type: "alerting",
  name,
  state,
  labels: { severity: "warning" },
  annotations: { summary },
  alerts: alerts.map((a) => ({
    labels: { alertname: name, severity: "warning", ...a.labels },
    annotations: { summary: a.summary, description: "More than 10% of its requests failed." },
    state: a.state ?? "firing",
    activeAt: "2026-10-30T13:58:00Z",
  })),
});

beforeAll(async () => {
  app = await buildApp();
  await Promise.all([createTeam(owner), createTeam(other)]);
  const spec = JSON.stringify({ openapi: "3.1.0", info: { title: "x", version: "1" }, paths: {} });
  await applyApis(
    ["orders", "ledger"].map((name) =>
      create(ApiSchema, { name, team: owner, displayName: name, openapi: spec, backendUrl: "https://x.example.run.app", serviceAccount: `${name}-api`, hidden: name === "ledger" }),
    ),
    new Set([owner, other]),
    new Set(),
    async (_item, work) => { await work(); },
  );
  const [made, them] = [await users.makeUser(), await users.makeUser()];
  await addTeamMember(made.id, (await findTeamByName(owner))?.id ?? "", "member");
  await addTeamMember(them.id, (await findTeamByName(other))?.id ?? "", "member");
  tokens.owner = await users.signIn(made.email);
  tokens.other = await users.signIn(them.email);
  tokens.admin = await users.signIn((await users.makeUser({ admin: true })).email);

  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) =>
    String(input) === `${PROMETHEUS}/api/v1/rules?type=alert` ? answer() : realFetch(input, init),
  );
  answer = () =>
    Promise.resolve(
      Response.json({
        status: "success",
        data: {
          groups: [
            { name: "vertra-kernel", rules: [rule("VertraSchedulerDown", "inactive", "No scheduler has finished a pass in 10 minutes.")] },
            {
              name: "vertra-console",
              rules: [
                rule("VertraGatewayBackendUnreachable", "firing", "The gateway can't reach {{ $labels.api }}'s backend.", [
                  { labels: { api: `${owner}/orders` }, summary: `The gateway can't reach ${owner}/orders's backend.` },
                  { labels: { api: `${owner}/ledger` }, summary: `The gateway can't reach ${owner}/ledger's backend.` },
                ]),
                { type: "recording", name: "vertra:requests:rate5m" },
              ],
            },
            { name: "someone-elses", rules: [rule("DiskFull", "firing", "A disk is full.", [{ labels: {}, summary: "A disk is full." }])] },
          ],
        },
      }),
    );
});

afterAll(async () => {
  vi.unstubAllGlobals();
  config.monitoring.prometheusUrl = "";
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await users.cleanUp();
  await app.close();
});

type Listed = {
  configured?: boolean;
  problem?: string;
  rules?: { name: string; state: string; summary: string; hidden?: number; instances?: { summary: string; labels: Record<string, string>; activeAt?: string }[] }[];
};
const list = async (token: string) => (await call<Listed>(token, "ObserveService/ListAlerts", {})).body;

describe("alerts", () => {
  it("are none when the console reads no Prometheus", async () => {
    config.monitoring.prometheusUrl = "";
    expect(await list(tokens.owner)).toMatchObject({ configured: false, rules: [] });
  });

  it("are the charts' rules, firing first, with what each fires for", async () => {
    config.monitoring.prometheusUrl = PROMETHEUS;
    const found = await list(tokens.owner);
    expect(found.configured).toBe(true);
    expect(found.rules?.map((r) => [r.name, r.state])).toEqual([
      ["VertraGatewayBackendUnreachable", "firing"],
      ["VertraSchedulerDown", "inactive"],
    ]);
    expect(found.rules?.[0]).toMatchObject({
      summary: "The gateway can't reach …'s backend.",
      instances: [
        { summary: `The gateway can't reach ${owner}/orders's backend.`, labels: { api: `${owner}/orders` }, activeAt: "2026-10-30T13:58:00Z" },
        { summary: `The gateway can't reach ${owner}/ledger's backend.` },
      ],
    });
  });

  it("count, not describe, what fires for an API the caller can't see; an admin sees it all", async () => {
    config.monitoring.prometheusUrl = PROMETHEUS;
    const theirs = (await list(tokens.other)).rules?.[0];
    expect(theirs?.instances?.map((i) => i.labels["api"])).toEqual([`${owner}/orders`]);
    expect(theirs?.hidden).toBe(1);
    expect((await list(tokens.admin)).rules?.[0]?.instances).toHaveLength(2);
  });

  it("say when Prometheus isn't answering", async () => {
    config.monitoring.prometheusUrl = PROMETHEUS;
    const was = answer;
    answer = () => Promise.reject(new Error("connect ECONNREFUSED"));
    try {
      expect(await list(tokens.owner)).toMatchObject({ configured: true, problem: "Prometheus isn't answering." });
    } finally {
      answer = was;
    }
  });
});

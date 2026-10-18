// SPDX-License-Identifier: MIT
/**
 * The cluster's copy of the registered products and each team's secrets
 * (productPolicy.ts): what each holds, and that every change rewrites them.
 * Kubernetes is faked: updateIdentityPolicy just runs the build the console
 * hands it and keeps what it would have written.
 */
import { randomUUID } from "node:crypto";
import { inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/password.js";
import { config } from "../src/config.js";
import { db } from "../src/db/client.js";
import { createTeam, createUser, recordSecretGrant, setUserAdmin } from "../src/db/queries.js";
import { products, teams, users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { ensureServiceAccount, updateIdentityPolicy } from "../src/k8s.js";
import { policyProducts, policyTeamSecrets, syncIdentityPolicy, type PolicyProduct } from "../src/productPolicy.js";

let written: { products: string; teamSecrets: string } | undefined;

vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  updateIdentityPolicy: vi.fn(async (_name: string, build: () => Promise<{ products: string; teamSecrets: string }>) => {
    written = await build();
    return true;
  }),
  ensureServiceAccount: vi.fn(() => Promise.resolve()),
}));

const prefix = `pol-${randomUUID().slice(0, 6)}`;
const email = `${prefix}@example.com`;
let app: FastifyInstance;
let admin: string;
const originalPolicyName = config.identityPolicyName;

const as = (method: "POST" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${admin}` }, payload: payload as object });

/** This file's products in the last list written, by repository. */
function ours(): PolicyProduct[] {
  const all = JSON.parse(written?.products ?? "[]") as PolicyProduct[];
  return all.filter((entry) => entry.repository.includes(prefix));
}

beforeAll(async () => {
  config.identityPolicyName = "kernel-execution-kernel-identity";
  app = await buildApp();
  await app.ready();
  await createTeam(prefix);
  const user = await createUser(email, await hashPassword("correct-horse-battery"));
  await setUserAdmin(user.id, true);
  admin = app.jwt.sign({ userId: user.id });
});

afterAll(async () => {
  config.identityPolicyName = originalPolicyName;
  await db.delete(products).where(like(products.name, `${prefix}%`));
  await db.delete(teams).where(inArray(teams.name, [prefix]));
  await db.delete(users).where(inArray(users.email, [email]));
  await app.close();
});

beforeEach(() => {
  written = undefined;
  vi.mocked(updateIdentityPolicy).mockClear();
  vi.mocked(ensureServiceAccount).mockClear();
});

describe("policy entries", () => {
  it("match a task the way the console does", () => {
    expect(
      policyProducts([
        {
          image: "registry.example/platform/db@sha256:abc",
          action: "create",
          serviceAccount: "db-product",
          teamName: "team-a",
        },
        { image: "node:20", action: "run", serviceAccount: null, teamName: null },
      ]),
    ).toEqual([
      { team: "team-a", repository: "registry.example/platform/db", action: "create", serviceAccount: "db-product" },
      { team: "", repository: "docker.io/library/node", action: "run", serviceAccount: "default" },
    ]);
  });

  it("list each team's secrets, comma-separated", () => {
    expect(
      policyTeamSecrets([
        { teamName: "team-b", secretName: "z" },
        { teamName: "team-a", secretName: "db-key" },
        { teamName: "team-a", secretName: "api-token" },
      ]),
    ).toEqual({ "team-a": "api-token,db-key", "team-b": "z" });
  });
});

describe("syncing", () => {
  it("writes nothing when no policy is configured", async () => {
    config.identityPolicyName = "";
    try {
      expect(await syncIdentityPolicy()).toBe(false);
      expect(updateIdentityPolicy).not.toHaveBeenCalled();
    } finally {
      config.identityPolicyName = "kernel-execution-kernel-identity";
    }
  });

  const product = {
    name: `${prefix}-db-create`,
    image: `example.com/${prefix}/db:1`,
    action: "create",
    team: prefix,
    serviceAccount: "db-product",
    requiredSecrets: ["db-admin-key"],
  };

  it("adds a product when it's registered, and creates its ServiceAccount", async () => {
    expect((await as("POST", "/api/products", product)).statusCode).toBe(200);
    expect(ours()).toEqual([
      { team: prefix, repository: `example.com/${prefix}/db`, action: "create", serviceAccount: "db-product" },
    ]);
    expect(ensureServiceAccount).toHaveBeenCalledWith(prefix, "db-product");
  });

  it("updates it when it's registered again with another identity", async () => {
    const response = await as("POST", "/api/products", { ...product, image: `example.com/${prefix}/db:2`, serviceAccount: "db-v2" });
    expect(response.statusCode).toBe(200);
    expect(ours()).toEqual([expect.objectContaining({ serviceAccount: "db-v2" })]);
  });

  it("writes each team's registered secrets with the products", async () => {
    const [team] = await db.select().from(teams).where(inArray(teams.name, [prefix]));
    await recordSecretGrant({ teamId: team?.id ?? "", secretName: "db-admin-key", keys: ["value"], source: "literal" });
    await syncIdentityPolicy();
    expect(JSON.parse(written?.teamSecrets ?? "{}")).toMatchObject({ [prefix]: "db-admin-key" });
  });

  it("drops it when it's deleted", async () => {
    expect((await as("DELETE", `/api/products/${product.name}`)).statusCode).toBe(204);
    expect(updateIdentityPolicy).toHaveBeenCalledOnce();
    expect(ours()).toEqual([]);
  });

  it("drops a team's products when the team is retired", async () => {
    expect((await as("POST", "/api/products", product)).statusCode).toBe(200);
    expect(ours()).toHaveLength(1);
    expect((await as("POST", `/api/teams/${prefix}/retire`)).statusCode).toBe(200);
    expect(ours()).toEqual([]);
  });

  it("fails the change if the cluster can't be updated", async () => {
    vi.mocked(updateIdentityPolicy).mockRejectedValueOnce(new Error("API server unreachable"));
    const response = await as("POST", "/api/products", { ...product, team: null, name: `${prefix}-platform`, image: `example.com/${prefix}/platform:1` });
    expect(response.statusCode).toBe(500);
  });
});

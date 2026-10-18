// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateApiToken, hashApiToken } from "../src/auth/apiToken.js";
import { hashPassword } from "../src/auth/password.js";
import { db } from "../src/db/client.js";
import { createApiToken, createBotUser, createTeam, createUser, setUserAdmin } from "../src/db/queries.js";
import { products, teams, users, wiringTypes } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";

// Registering a team's product creates its ServiceAccount in the team's
// namespace (test/product-policy.test.ts checks that); not here.
vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  ensureServiceAccount: vi.fn(() => Promise.resolve()),
}));

// What catalog CI registers about a product beyond its image (the
// catalog's docs/product-schema.md), and its wiring vocabulary.

const prefix = `cat-${randomUUID().slice(0, 6)}`;
const emails: string[] = [];
let app: FastifyInstance;
let admin: string;
let member: string;
let catalogCi: string;

const as = (token: string, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload: payload as object });

async function newUser(isAdmin: boolean): Promise<string> {
  const email = `${prefix}-${randomUUID().slice(0, 6)}@example.com`;
  emails.push(email);
  const user = await createUser(email, await hashPassword("correct-horse-battery"));
  if (isAdmin) await setUserAdmin(user.id, true);
  return app.jwt.sign({ userId: user.id });
}

interface Listed {
  name: string;
  inputSchema: Record<string, unknown>;
  displayName: string | null;
  description: string | null;
  outputSchema: Record<string, unknown>;
  serviceAccount: string | null;
  requiredSecrets: string[];
}

async function listed(name: string): Promise<Listed | undefined> {
  return (await as(admin, "GET", "/api/products")).json<Listed[]>().find((p) => p.name === name);
}

const INPUT = { type: "object", additionalProperties: false, properties: { instanceName: { type: "string", title: "Instance name" } } };
const OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: { connection: { type: "string", title: "Connection", "x-acyclix-provides": "gcp.cloudsql.connection" } },
};

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await createTeam(prefix);
  admin = await newUser(true);
  member = await newUser(false);
  const botEmail = `${prefix}-ci@bots.acyclix.local`;
  emails.push(botEmail);
  const bot = await createBotUser(botEmail);
  const token = generateApiToken();
  await createApiToken(bot.id, "catalog CI", hashApiToken(token), ["products:register"]);
  catalogCi = token;
});

afterAll(async () => {
  await db.delete(wiringTypes);
  await db.delete(products).where(like(products.name, `${prefix}%`));
  await db.delete(teams).where(inArray(teams.name, [prefix]));
  await db.delete(users).where(inArray(users.email, emails));
  await app.close();
});

describe("registering a product's full description", () => {
  const name = `${prefix}-db-create`;
  const full = {
    name,
    image: `example.com/${prefix}/db:1`,
    action: "create",
    team: prefix,
    inputSchema: INPUT,
    displayName: "Database",
    description: "A database instance.",
    outputSchema: OUTPUT,
    serviceAccount: "db-product",
    requiredSecrets: ["db-admin-key"],
    resources: { cpu: "250m", memory: "512Mi", memoryLimit: "1Gi" },
  };

  it("stores and lists everything catalog CI sends", async () => {
    const response = await as(catalogCi, "POST", "/api/products", full);
    expect(response.statusCode).toBe(200);
    expect(await listed(name)).toMatchObject({
      inputSchema: INPUT,
      displayName: "Database",
      description: "A database instance.",
      outputSchema: OUTPUT,
      serviceAccount: "db-product",
      requiredSecrets: ["db-admin-key"],
      resources: { cpu: "250m", memory: "512Mi", memoryLimit: "1Gi" },
    });
  });

  it("refuses a size that isn't a Kubernetes quantity", async () => {
    for (const resources of [{ cpu: "lots" }, { memory: "512 MiB" }, { memoryLimit: "-1" }]) {
      const response = await as(catalogCi, "POST", "/api/products", { ...full, resources });
      expect(response.statusCode).toBe(400);
    }
  });

  it("drops resource kinds it doesn't know, like the rest of the API", async () => {
    const response = await as(catalogCi, "POST", "/api/products", {
      ...full,
      resources: { cpu: "100m", gpu: "1" },
    });
    expect(response.statusCode).toBe(200);
    expect((await listed(name))?.resources).toEqual({ cpu: "100m" });
  });

  it("keeps what's stored when a later registration leaves fields out", async () => {
    const response = await as(catalogCi, "POST", "/api/products", {
      name,
      image: `example.com/${prefix}/db:2`,
      action: "create",
      team: prefix,
    });
    expect(response.statusCode).toBe(200);
    expect(await listed(name)).toMatchObject({ inputSchema: INPUT, outputSchema: OUTPUT, serviceAccount: "db-product" });
  });

  it("gives a product registered without them empty values, not an error", async () => {
    const bare = `${prefix}-bare-create`;
    const response = await as(admin, "POST", "/api/products", {
      name: bare,
      image: `example.com/${prefix}/bare:1`,
      action: "create",
      team: prefix,
    });
    expect(response.statusCode).toBe(200);
    expect(await listed(bare)).toMatchObject({
      inputSchema: {},
      outputSchema: {},
      displayName: null,
      serviceAccount: null,
      requiredSecrets: [],
    });
  });

  it("refuses names Kubernetes wouldn't accept", async () => {
    for (const bad of [{ serviceAccount: "Bad_Name" }, { requiredSecrets: ["ok", "Not OK"] }]) {
      const response = await as(catalogCi, "POST", "/api/products", { ...full, ...bad });
      expect(response.statusCode).toBe(400);
    }
  });
});

describe("the wiring types", () => {
  const types = {
    "gcp.project": { jsonType: "string", description: "A project id.", shared: true, defaultProvider: "gcp/project.create" },
    "gcp.region": { jsonType: "string", description: "A region.", shared: true },
  };

  it("can be replaced by catalog CI and read by anyone signed in", async () => {
    expect((await as(catalogCi, "PUT", "/api/wiring-types", types)).statusCode).toBe(200);
    const read = (await as(member, "GET", "/api/wiring-types")).json<{ name: string; defaultProvider: string | null }[]>();
    expect(read.map((t) => t.name)).toEqual(["gcp.project", "gcp.region"]);
    expect(read[0]?.defaultProvider).toBe("gcp/project.create");
    expect(read[1]?.defaultProvider).toBeNull();
  });

  it("is replaced as a whole: a type left out is removed", async () => {
    await as(catalogCi, "PUT", "/api/wiring-types", { "gcp.region": types["gcp.region"] });
    const read = (await as(member, "GET", "/api/wiring-types")).json<{ name: string }[]>();
    expect(read.map((t) => t.name)).toEqual(["gcp.region"]);
  });

  it("can't be changed by an ordinary user", async () => {
    expect((await as(member, "PUT", "/api/wiring-types", types)).statusCode).toBe(403);
  });

  it("refuses malformed types, without touching the stored ones", async () => {
    for (const bad of [
      {},
      { Project: types["gcp.project"] },
      { "gcp.project": { ...types["gcp.project"], jsonType: "object" } },
      { "gcp.project": { ...types["gcp.project"], defaultProvider: "not a provider" } },
    ]) {
      expect((await as(admin, "PUT", "/api/wiring-types", bad)).statusCode).toBe(400);
    }
    const read = (await as(member, "GET", "/api/wiring-types")).json<{ name: string }[]>();
    expect(read.map((t) => t.name)).toEqual(["gcp.region"]);
  });
});

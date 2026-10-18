// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/password.js";
import { db } from "../src/db/client.js";
import { createUser } from "../src/db/queries.js";
import { users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { ROUTE_DOCS, undocumentedRoutes } from "../src/openapi.js";

interface Operation {
  summary?: string;
  description?: string;
  security?: unknown[];
  requestBody?: unknown;
}
interface Spec {
  paths: Record<string, Record<string, Operation>>;
}

let app: FastifyInstance;
let token: string;
const email = `openapi-${randomUUID()}@example.com`;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  const user = await createUser(email, await hashPassword("correct-horse-battery"));
  token = app.jwt.sign({ userId: user.id });
});

afterAll(async () => {
  await app.close();
  await db.delete(users).where(inArray(users.email, [email]));
});

async function spec(): Promise<Spec> {
  const response = await app.inject({ method: "GET", url: "/api/openapi.json", headers: { authorization: `Bearer ${token}` } });
  expect(response.statusCode).toBe(200);
  return response.json<Spec>();
}

/** "/api/teams/{teamName}" -> "/api/teams/:teamName", ROUTE_DOCS' spelling. */
const fastifyPath = (path: string) => path.replace(/\{([^}]+)\}/g, ":$1");

describe("the API reference", () => {
  it("documents every /api route, and nothing that isn't one", async () => {
    expect(undocumentedRoutes).toEqual([]);
    const operations = Object.entries((await spec()).paths).flatMap(([path, methods]) =>
      Object.keys(methods).map((method) => `${method.toUpperCase()} ${fastifyPath(path)}`),
    );
    expect(operations.sort()).toEqual(Object.keys(ROUTE_DOCS).sort());
  });

  it("says who may call every operation", async () => {
    for (const [path, methods] of Object.entries((await spec()).paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        expect(operation.summary, `${method} ${path}`).toBeTruthy();
        expect(operation.description, `${method} ${path}`).toMatch(/^\*\*Who can call it:\*\*/);
        expect(operation.security, `${method} ${path}`).toBeDefined();
      }
    }
  });

  it("describes the DAG a submission takes", async () => {
    expect((await spec()).paths["/api/executions"]?.["post"]?.requestBody).toBeDefined();
  });

  it("is for signed-in users only", async () => {
    expect((await app.inject({ method: "GET", url: "/api/openapi.json" })).statusCode).toBe(401);
  });
});

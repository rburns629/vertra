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

let app: FastifyInstance;
let token: string;
const email = `docs-${randomUUID()}@example.com`;

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

const get = (url: string) => app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

describe("the in-app guides", () => {
  it("lists the guides in order, the walkthrough first", async () => {
    const response = await get("/api/docs");
    expect(response.statusCode).toBe(200);
    const docs = response.json<{ id: string; title: string }[]>();
    expect(docs[0]).toEqual({ id: "01-getting-started", title: "Try Acyclix end to end" });
    expect(docs.map((d) => d.id)).toEqual([...docs.map((d) => d.id)].sort());
  });

  it("serves a guide as markdown, and every link between guides resolves", async () => {
    const docs = (await get("/api/docs")).json<{ id: string }[]>();
    // The API reference is a page of its own, not a guide file.
    const ids = new Set([...docs.map((d) => d.id), "api-reference"]);
    for (const { id } of docs) {
      const page = await get(`/api/docs/${id}`);
      expect(page.statusCode).toBe(200);
      for (const [, target] of page.body.matchAll(/\]\(([a-zA-Z0-9_-]+)\.md\)/g)) {
        expect(ids, `${id} links to ${String(target)}`).toContain(target);
      }
    }
  });

  it("refuses anything that isn't a plain guide name", async () => {
    expect((await get("/api/docs/..%2F..%2Fpackage")).statusCode).toBe(400);
    expect((await get("/api/docs/no-such-guide")).statusCode).toBe(404);
  });

  it("is for signed-in users only", async () => {
    expect((await app.inject({ method: "GET", url: "/api/docs" })).statusCode).toBe(401);
  });
});

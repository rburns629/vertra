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
import { caller } from "./rpc.js";

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

const call = caller(() => app);
const listGuides = async () => (await call<{ guides: { id: string; title: string }[] }>(token, "GuideService/ListGuides")).body.guides;
const getGuide = (id: string, as: string | undefined = token) => call<{ markdown: string }>(as, "GuideService/GetGuide", { id });

describe("the in-app guides", () => {
  it("lists the guides in order, the walkthrough first", async () => {
    const docs = await listGuides();
    expect(docs[0]).toEqual({ id: "01-getting-started", title: "Try Acyclix end to end" });
    expect(docs.map((d) => d.id)).toEqual([...docs.map((d) => d.id)].sort());
  });

  it("serves a guide as markdown, and every link between guides resolves", async () => {
    const docs = await listGuides();
    // The API reference is a page of its own, not a guide file.
    const ids = new Set([...docs.map((d) => d.id), "api-reference"]);
    for (const { id } of docs) {
      const page = await getGuide(id);
      expect(page.code).toBe("ok");
      for (const [, target] of page.body.markdown.matchAll(/\]\(([a-zA-Z0-9_-]+)\.md\)/g)) {
        expect(ids, `${id} links to ${String(target)}`).toContain(target);
      }
    }
  });

  it("refuses anything that isn't a plain guide name", async () => {
    expect((await getGuide("../../package")).code).toBe("invalid_argument");
    expect((await getGuide("no-such-guide")).code).toBe("not_found");
  });

  it("is for signed-in users only", async () => {
    expect((await call(undefined, "GuideService/ListGuides")).code).toBe("unauthenticated");
  });
});

// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/password.js";
import { db } from "../src/db/client.js";
import { createTeam, createUser, setUserAdmin } from "../src/db/queries.js";
import { products, teams, users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";

const prefix = `rel-${randomUUID().slice(0, 6)}`;
const emails: string[] = [];
let app: FastifyInstance;
let admin: string;

interface Listed {
  name: string;
  teamName: string | null;
  image: string;
  releases: { image: string; registeredAt: string }[];
}

function register(image: string) {
  return app.inject({
    method: "POST",
    url: "/api/products",
    headers: { authorization: `Bearer ${admin}` },
    payload: { name: `${prefix}-product`, image, action: "create", team: prefix },
  });
}

async function listed(): Promise<Listed> {
  const response = await app.inject({
    method: "GET",
    url: "/api/products",
    headers: { authorization: `Bearer ${admin}` },
  });
  const product = response.json<Listed[]>().find((p) => p.name === `${prefix}-product`);
  if (!product) throw new Error("product not listed");
  return product;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  const email = `${prefix}@example.com`;
  emails.push(email);
  const user = await createUser(email, await hashPassword("correct-horse-battery"));
  await setUserAdmin(user.id, true);
  admin = app.jwt.sign({ userId: user.id });
  await createTeam(prefix);
});

afterAll(async () => {
  await app.close();
  await db.delete(products).where(like(products.name, `${prefix}%`));
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await db.delete(users).where(inArray(users.email, emails));
});

describe("product release history", () => {
  it("records each distinct image as a release, newest first", async () => {
    expect((await register("example/app:aaa")).statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await register("example/app:bbb")).statusCode).toBe(200);

    const product = await listed();
    expect(product.teamName).toBe(prefix);
    expect(product.image).toBe("example/app:bbb");
    expect(product.releases.map((r) => r.image)).toEqual(["example/app:bbb", "example/app:aaa"]);
  });

  it("doesn't duplicate or re-date a release when the same image is registered again", async () => {
    const before = await listed();
    expect((await register("example/app:bbb")).statusCode).toBe(200);
    expect((await listed()).releases).toEqual(before.releases);
  });

  it("keeps the history when an older image becomes current again (a rollback)", async () => {
    expect((await register("example/app:aaa")).statusCode).toBe(200);
    const product = await listed();
    // The current image is what `latest` means, not the newest date.
    expect(product.image).toBe("example/app:aaa");
    expect(product.releases.map((r) => r.image)).toEqual(["example/app:bbb", "example/app:aaa"]);
  });
});

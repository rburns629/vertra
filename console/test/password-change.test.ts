// SPDX-License-Identifier: MIT
/**
 * A password someone else set (an admin's new account or reset) must be
 * changed first: until then the session may only see who it is and change
 * it (rpc/interceptors.ts). An admin resetting their own isn't forced, nor
 * is a single sign-on session.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import { failureCode, PASSWORD, rpcClient, type RpcError } from "./rpc.js";

let app: FastifyInstance;
const { rpc, makeUser, signIn, cleanUp, createdEmails } = rpcClient(() => app);
let admin: string;
let adminEmail: string;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  const made = await makeUser({ admin: true });
  adminEmail = made.email;
  admin = await signIn(made.email);
});

afterAll(async () => {
  await app.close();
  await cleanUp();
});

async function login(email: string, password: string): Promise<string> {
  const response = await rpc("AuthService", "Login", { email, password });
  expect(response.statusCode).toBe(200);
  return response.json<{ token: string }>().token;
}

const me = async (token: string) => (await rpc("AuthService", "GetMe", {}, { token })).json<{ mustChangePassword?: boolean }>();
// Anything a signed-in person may call.
const listProducts = (token: string) => rpc("ProductService", "ListProducts", {}, { token });

describe("a password someone else set", () => {
  it("allows nothing but changing it, then everything", async () => {
    const email = `pwchange-${Date.now()}@example.com`;
    createdEmails.push(email);
    const created = (await rpc("UserService", "CreateUser", { email, teams: [], admin: false }, { token: admin })).json<{ temporaryPassword: string }>();
    const first = await login(email, created.temporaryPassword);

    expect((await me(first)).mustChangePassword).toBe(true);
    const refused = await listProducts(first);
    expect(refused.statusCode).toBe(403);
    expect(failureCode(refused.json<RpcError>())).toBe("PASSWORD_CHANGE_REQUIRED");

    const changed = await rpc("AuthService", "ChangePassword", { currentPassword: created.temporaryPassword, newPassword: PASSWORD }, { token: first });
    expect(changed.statusCode).toBe(200);
    const next = changed.json<{ token: string }>().token;
    expect((await me(next)).mustChangePassword ?? false).toBe(false);
    expect((await listProducts(next)).statusCode).toBe(200);
  });

  it("is forced by an admin's reset of someone else's, not of their own", async () => {
    const other = await makeUser();
    expect((await rpc("UserService", "ResetPassword", { email: other.email, newPassword: "an-admin-picked-this-1" }, { token: admin })).statusCode).toBe(200);
    expect((await listProducts(await login(other.email, "an-admin-picked-this-1"))).statusCode).toBe(403);

    expect((await rpc("UserService", "ResetPassword", { email: adminEmail, newPassword: "my-own-new-password-1" }, { token: admin })).statusCode).toBe(200);
    expect((await listProducts(await login(adminEmail, "my-own-new-password-1"))).statusCode).toBe(200);
  });

  it("doesn't hold back a single sign-on session", async () => {
    const other = await makeUser();
    await rpc("UserService", "ResetPassword", { email: other.email, newPassword: "an-admin-picked-this-2" }, { token: admin });
    const sso = app.jwt.sign({ userId: other.id, sso: true });
    expect((await listProducts(sso)).statusCode).toBe(200);
  });
});

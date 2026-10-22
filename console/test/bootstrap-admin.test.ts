// SPDX-License-Identifier: MIT
/**
 * The first admin (db/bootstrapAdmin.ts): a generated password was printed,
 * so it must be changed at the first sign-in; one the operator set isn't
 * forced; and an existing account is never touched.
 */
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { verifyPassword } from "../src/auth/password.js";
import { seedBootstrapAdmin } from "../src/db/bootstrapAdmin.js";
import { db } from "../src/db/client.js";
import { findUserByEmail, setUserPassword } from "../src/db/queries.js";
import { users } from "../src/db/schema.js";

const made: string[] = [];
const email = () => {
  const address = `bootstrap-${randomUUID()}@example.com`;
  made.push(address);
  return address;
};

afterAll(async () => {
  await db.delete(users).where(inArray(users.email, made));
});

describe("the first admin", () => {
  it("must change a generated password, printed once", async () => {
    const printed: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: string) => void printed.push(line));
    const address = email();
    await seedBootstrapAdmin(db, address, undefined);
    log.mockRestore();

    const admin = await findUserByEmail(address);
    expect(admin).toMatchObject({ isAdmin: true, mustChangePassword: true });
    const password = /generated: (\S+)/.exec(printed.join("\n"))?.[1];
    expect(password).toBeDefined();
    expect(await verifyPassword(admin!.passwordHash!, password!)).toBe(true);
  });

  it("isn't forced to change a password the operator set", async () => {
    const address = email();
    await seedBootstrapAdmin(db, address, "an-operator-chosen-password");
    expect(await findUserByEmail(address)).toMatchObject({ isAdmin: true, mustChangePassword: false });
  });

  it("leaves an existing account alone", async () => {
    const address = email();
    await seedBootstrapAdmin(db, address, "the-first-password");
    const admin = await findUserByEmail(address);
    await setUserPassword(admin!.id, admin!.passwordHash!, false);
    await seedBootstrapAdmin(db, address, undefined);
    expect(await findUserByEmail(address)).toMatchObject({ mustChangePassword: false, passwordHash: admin!.passwordHash });
  });
});

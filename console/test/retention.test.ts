// SPDX-License-Identifier: MIT
/** Deleting what's past retention (retention.ts), and keeping the rest. */
import { randomUUID } from "node:crypto";
import { inArray, like } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { auditLog, imageScans, submittedExecutions } from "../src/db/schema.js";
import { deleteExpired } from "../src/retention.js";
import { createUser } from "../src/db/queries.js";
import { users } from "../src/db/schema.js";

const prefix = `ret-${randomUUID().slice(0, 6)}`;
const longAgo = new Date("2000-01-01T00:00:00Z");
const oldId = randomUUID();
const newId = randomUUID();
const digest = (c: string) => `sha256:${c.repeat(64)}`;

const email = `${prefix}@example.com`;

afterAll(async () => {
  await db.delete(users).where(inArray(users.email, [email]));
  await db.delete(submittedExecutions).where(inArray(submittedExecutions.executionId, [oldId, newId]));
  await db.delete(auditLog).where(like(auditLog.route, `/api/${prefix}%`));
  await db.delete(imageScans).where(like(imageScans.image, `${prefix}%`));
});

describe("retention", () => {
  it("deletes old execution records, audit entries and unused scans, and keeps recent ones", async () => {
    const submittedBy = (await createUser(email, "not-a-real-hash")).id;
    await db.insert(submittedExecutions).values([
      { executionId: oldId, teams: [prefix], submittedBy, name: "old", createdAt: longAgo },
      { executionId: newId, teams: [prefix], submittedBy, name: "new" },
    ]);
    await db.insert(auditLog).values([
      { method: "POST", route: `/api/${prefix}/old`, status: 200, at: longAgo },
      { method: "POST", route: `/api/${prefix}/new`, status: 200 },
    ]);
    await db.insert(imageScans).values([
      { digest: digest("d"), image: `${prefix}/old`, status: "passed", lastUsedAt: longAgo },
      { digest: digest("e"), image: `${prefix}/new`, status: "passed" },
    ]);

    await deleteExpired();

    const executions = await db.select().from(submittedExecutions).where(inArray(submittedExecutions.executionId, [oldId, newId]));
    expect(executions.map((e) => e.name)).toEqual(["new"]);
    const audit = await db.select().from(auditLog).where(like(auditLog.route, `/api/${prefix}%`));
    expect(audit.map((a) => a.route)).toEqual([`/api/${prefix}/new`]);
    const scans = await db.select().from(imageScans).where(like(imageScans.image, `${prefix}%`));
    expect(scans.map((s) => s.image)).toEqual([`${prefix}/new`]);
  });
});

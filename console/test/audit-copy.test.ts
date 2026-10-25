// SPDX-License-Identifier: MIT
/**
 * ObserveService/GetAuditCopy: the audit log's write-once copy as Observe
 * and the Admin page show it. How far it has gone, what's waiting, and
 * where the chain broke, for everyone signed in; where it goes, for admins.
 */
import { randomUUID } from "node:crypto";
import { desc, eq, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportAudit } from "../src/auditExport.js";
import { config } from "../src/config.js";
import { db } from "../src/db/client.js";
import { auditExport, auditLog } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { rpcClient } from "./rpc.js";

let app: FastifyInstance;
const { rpc, makeUser, signIn, cleanUp } = rpcClient(() => app);
const prefix = `copy-${randomUUID().slice(0, 6)}`;
const originalExport = { ...config.audit.export };
let originalState: typeof auditExport.$inferSelect | undefined;

type Copy = { enabled: boolean; destination: string; copiedThrough: string; waiting: string; brokenAt: string; problem: string; checkedAt?: string };

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  [originalState] = await db.select().from(auditExport).where(eq(auditExport.id, 1));
});

afterAll(async () => {
  Object.assign(config.audit.export, originalExport);
  await db.delete(auditExport);
  if (originalState) await db.insert(auditExport).values(originalState);
  await db.delete(auditLog).where(like(auditLog.requestId, `${prefix}%`));
  await app.close();
  await cleanUp();
});

async function copyAs(token: string): Promise<Copy> {
  const response = await rpc("ObserveService", "GetAuditCopy", {}, { token });
  expect(response.statusCode).toBe(200);
  return response.json<Copy>();
}

describe("the audit log's copy", () => {
  it("says when this install keeps none", async () => {
    config.audit.export.bucket = "";
    const token = await signIn((await makeUser()).email);
    expect(await copyAs(token)).toMatchObject({ enabled: false, destination: "" });
  });

  it("shows how far it has gone to everyone, and where it goes to admins only", async () => {
    Object.assign(config.audit.export, { bucket: "acme-audit", provider: "gcs", prefix: "vertra-audit/" });
    // An entry of its own to wait: the newest of all may be another file's, which it deletes.
    const [own] = await db
      .insert(auditLog)
      .values({ actorId: null, method: "RPC", route: "waiting", target: {}, status: 200, requestId: `${prefix}-waiting` })
      .returning({ id: auditLog.id });
    const through = (own?.id ?? 1) - 1;
    await db.delete(auditExport);
    await db.insert(auditExport).values({ id: 1, lastId: through, lastHash: "", exportedAt: new Date(), checkedAt: new Date() });

    const admin = await copyAs(await signIn((await makeUser({ admin: true })).email));
    expect(admin).toMatchObject({ enabled: true, destination: "gs://acme-audit/vertra-audit/", copiedThrough: String(through), brokenAt: "0" });
    // At least the newest entry, and the sign-ins since.
    expect(Number(admin.waiting)).toBeGreaterThanOrEqual(1);

    const member = await copyAs(await signIn((await makeUser()).email));
    expect(member).toMatchObject({ enabled: true, destination: "", copiedThrough: String(through) });
  });

  it("names the entry where the chain broke, and copies nothing from there", async () => {
    Object.assign(config.audit.export, { bucket: "acme-audit", provider: "gcs" });
    const token = await signIn((await makeUser()).email);
    const [newest] = await db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(1);
    await db.delete(auditExport);
    await db.insert(auditExport).values({ id: 1, lastId: newest!.id, lastHash: newest!.hash ?? "" });
    // Written behind the console's back: its hash doesn't follow.
    const [forged] = await db
      .insert(auditLog)
      .values({ actorId: null, method: "RPC", route: "forged", target: {}, status: 200, requestId: `${prefix}-forged`, hash: "not-the-chain" })
      .returning();

    expect(await exportAudit(app.log)).toBe(true);
    const copy = await copyAs(token);
    expect(copy.brokenAt).toBe(String(forged!.id));
    expect(copy.problem).toContain(`breaks at entry ${String(forged!.id)}`);
    expect(copy.copiedThrough).toBe(String(newest!.id));
    expect(copy.checkedAt).toBeDefined();
  });
});

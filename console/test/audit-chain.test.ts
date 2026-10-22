// SPDX-License-Identifier: MIT
/**
 * The audit log's hash chain (audit.ts): each entry's hash follows from the
 * entry before it, so an entry changed, removed or slipped in breaks every
 * later hash, and the export (auditExport.ts) stops there. The export to a
 * real bucket is proven on kind (docs/operations.md).
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull, like, lt } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { appendAuditEntry, chainHash } from "../src/audit.js";
import { brokenAt } from "../src/auditExport.js";
import { db } from "../src/db/client.js";
import { auditLog } from "../src/db/schema.js";

const prefix = `chain-${randomUUID().slice(0, 6)}`;

afterAll(async () => {
  await db.delete(auditLog).where(like(auditLog.requestId, `${prefix}%`));
});

type Row = typeof auditLog.$inferSelect;

function rowsOf(...entries: { route: string }[]): Row[] {
  let previous = "";
  return entries.map((entry, i) => {
    const row = { id: i + 1, at: new Date(1_800_000_000_000 + i), actorId: null, method: "RPC", route: entry.route, target: {}, status: 200, requestId: `r${String(i)}` };
    const hash = chainHash(previous, { ...row, requestId: row.requestId });
    previous = hash;
    return { ...row, hash };
  });
}

describe("the audit chain", () => {
  it("links each entry the console writes to the hashed one before it", async () => {
    await appendAuditEntry(db, { actorId: null, method: "RPC", route: "chained", target: { team: "a", nested: { b: 1, a: 2 } }, status: 200, requestId: `${prefix}-1` });
    const [mine] = await db.select().from(auditLog).where(eq(auditLog.requestId, `${prefix}-1`));
    const [before] = await db
      .select()
      .from(auditLog)
      .where(and(lt(auditLog.id, mine!.id), isNotNull(auditLog.hash)))
      .orderBy(desc(auditLog.id))
      .limit(1);
    expect(mine!.hash).toBe(
      chainHash(before?.hash ?? "", { ...mine!, target: mine!.target as Record<string, unknown>, requestId: mine!.requestId ?? "" }),
    );
  });

  it("is whole as written", () => {
    expect(brokenAt("", rowsOf({ route: "a" }, { route: "b" }, { route: "c" }))).toBeUndefined();
  });

  it("breaks at an entry changed, one after a removal, one slipped in, or a hash taken off", () => {
    const changed = rowsOf({ route: "a" }, { route: "b" }, { route: "c" });
    changed[1] = { ...changed[1]!, status: 403 };
    expect(brokenAt("", changed)?.route).toBe("b");

    const removed = rowsOf({ route: "a" }, { route: "b" }, { route: "c" });
    expect(brokenAt("", [removed[0]!, removed[2]!])?.route).toBe("c");

    const inserted = rowsOf({ route: "a" }, { route: "b" });
    const forged = { ...inserted[1]!, id: 99, route: "forged", hash: "0".repeat(64) };
    expect(brokenAt("", [inserted[0]!, forged, inserted[1]!])?.route).toBe("forged");

    const stripped = rowsOf({ route: "a" }, { route: "b" });
    expect(brokenAt("", [stripped[0]!, { ...stripped[1]!, hash: null }])?.route).toBe("b");
  });

  it("starts after the last export's hash", () => {
    const rows = rowsOf({ route: "a" }, { route: "b" }, { route: "c" });
    expect(brokenAt(rows[0]!.hash!, rows.slice(1))).toBeUndefined();
    expect(brokenAt("not the last hash", rows.slice(1))?.route).toBe("b");
  });

  it("lets entries from before the chain lead it, never follow it", () => {
    const rows = rowsOf({ route: "a" });
    const legacy = { ...rows[0]!, id: 0, route: "legacy", hash: null };
    expect(brokenAt("", [legacy, ...rows])).toBeUndefined();
  });
});

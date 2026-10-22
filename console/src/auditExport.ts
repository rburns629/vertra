// SPDX-License-Identifier: MIT
/**
 * Shipping the audit log to write-once storage (config.audit.export): every
 * few minutes one console (an advisory lock) takes the entries after the
 * last one exported, checks their chain (audit.ts) links from the last
 * exported hash, and writes them as one JSON-lines object to a bucket that
 * refuses deletes and overwrites (a GCS retention policy, S3 Object Lock),
 * create-only on its side too. A broken chain (an entry changed, removed or
 * inserted in the database) stops the export where it breaks, loudly: what
 * was shipped stays the record. The bucket and its lock are vertra's
 * (docs/operations.md, "The audit log's copy").
 */
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { asc, count, eq, gt, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { chainHash } from "./audit.js";
import { config } from "./config.js";
import { db } from "./db/client.js";
import { auditExport, auditLog } from "./db/schema.js";
import { gcpMetadataToken } from "./registry.js";

const LOCK = 0x7665727465787074; // "vertexpt"
/** The most entries in one object. */
const BATCH = 5000;

type Row = typeof auditLog.$inferSelect;

/** The first entry whose hash doesn't follow from the one before it, if any. */
export function brokenAt(previousHash: string, rows: Row[]): Row | undefined {
  let previous = previousHash;
  for (const row of rows) {
    if (row.hash === null) {
      // From before the chain: only before its first hashed entry.
      if (previous === "") continue;
      return row;
    }
    const expected = chainHash(previous, {
      at: row.at,
      actorId: row.actorId,
      method: row.method,
      route: row.route,
      target: row.target as Record<string, unknown>,
      status: row.status,
      requestId: row.requestId ?? "",
    });
    if (expected !== row.hash) return row;
    previous = row.hash;
  }
  return undefined;
}

async function put(name: string, body: string): Promise<void> {
  const target = config.audit.export;
  if (target.provider === "gcs") {
    // Create-only: ifGenerationMatch=0 refuses an object that exists.
    const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(target.bucket)}/o`);
    url.search = new URLSearchParams({ uploadType: "media", name, ifGenerationMatch: "0" }).toString();
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${await gcpMetadataToken()}`, "content-type": "application/x-ndjson" },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GCS answered ${String(response.status)}: ${(await response.text()).slice(0, 300)}`);
    return;
  }
  const s3 = new S3Client({
    region: target.region || "us-east-1",
    ...(target.endpoint ? { endpoint: target.endpoint, forcePathStyle: true } : {}),
  });
  // Create-only: If-None-Match refuses an object that exists. The bucket's
  // default retention (Object Lock) applies to it.
  await s3.send(new PutObjectCommand({ Bucket: target.bucket, Key: name, Body: body, IfNoneMatch: "*", ContentType: "application/x-ndjson" }));
}

async function record(values: Partial<typeof auditExport.$inferInsert>): Promise<void> {
  await db
    .insert(auditExport)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: auditExport.id, set: values });
}

/** One export; false when another console holds the lock. */
export async function exportAudit(log: FastifyBaseLogger): Promise<boolean> {
  if (!config.audit.export.bucket) return true;
  return db.transaction(async (tx) => {
    const locked = await tx.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock(${LOCK}) AS locked`);
    if (!locked.rows[0]?.locked) return false;
    const now = new Date();
    const [state] = await tx.select().from(auditExport).where(eq(auditExport.id, 1));
    const lastId = state?.lastId ?? 0;
    const rows = await tx.select().from(auditLog).where(gt(auditLog.id, lastId)).orderBy(asc(auditLog.id)).limit(BATCH);
    const [first] = rows;
    const last = rows.at(-1);
    if (!first || !last) {
      await record({ checkedAt: now, error: null, brokenAt: null });
      return true;
    }
    const broken = brokenAt(state?.lastHash ?? "", rows);
    if (broken) {
      const error = `the audit log's chain breaks at entry ${String(broken.id)}: it was changed, or one before it was removed or added, after it was written. Nothing from there on is exported.`;
      log.error({ event: "audit_chain_broken", entryId: broken.id }, error);
      await record({ checkedAt: now, error, brokenAt: broken.id });
      return true;
    }
    const day = last.at.toISOString().slice(0, 10).replaceAll("-", "/");
    const name = `${config.audit.export.prefix}${day}/${String(first.id).padStart(12, "0")}-${String(last.id).padStart(12, "0")}.jsonl`;
    try {
      await put(name, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    } catch (error) {
      log.error({ event: "audit_export_failed", err: error }, "couldn't export the audit log");
      await record({ checkedAt: now, error: `couldn't write to the bucket: ${error instanceof Error ? error.message : String(error)}`, brokenAt: null });
      return true;
    }
    await record({ lastId: last.id, lastHash: last.hash ?? state?.lastHash ?? "", exportedAt: now, checkedAt: now, error: null, brokenAt: null });
    log.info({ event: "audit_exported", object: name, entries: rows.length }, "audit log exported");
    return true;
  });
}

/** The export's state, for Observe: none when it's off. */
export async function auditExportStatus() {
  if (!config.audit.export.bucket) return null;
  const [state] = await db.select().from(auditExport).where(eq(auditExport.id, 1));
  return state ?? { lastId: 0, lastHash: "", exportedAt: null, checkedAt: null, error: null, brokenAt: null };
}

/** Where the copy goes, as a URL: gs://bucket/prefix or s3://bucket/prefix. */
export function auditExportDestination(): string {
  const target = config.audit.export;
  return `${target.provider === "gcs" ? "gs" : "s3"}://${target.bucket}/${target.prefix}`;
}

/** Entries written since the last one copied. */
export async function auditEntriesNotCopied(lastId: number): Promise<number> {
  const [row] = await db.select({ n: count() }).from(auditLog).where(gt(auditLog.id, lastId));
  return row?.n ?? 0;
}

export function startAuditExport(log: FastifyBaseLogger): void {
  if (!config.audit.export.bucket) return;
  const run = () => {
    exportAudit(log).catch((error: unknown) => {
      log.error({ event: "audit_export_failed", err: error }, "couldn't export the audit log");
    });
  };
  run();
  setInterval(run, config.audit.export.minutes * 60_000).unref();
}

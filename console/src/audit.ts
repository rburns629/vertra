// SPDX-License-Identifier: MIT
/**
 * Who changed what: every call that can change something (a Connect method
 * not marked NO_SIDE_EFFECTS), allowed or refused, is recorded once it's
 * answered, in the audit_log table and as a structured log line
 * (`event: "audit"`, for shipping to a SIEM), by rpc/interceptors.ts's
 * audit interceptor. One interceptor, so a new method is covered without
 * remembering to.
 *
 * Recorded: the caller (its user id; bots are users), the method, the
 * identifying fields of the request (TARGET_FIELDS: names, teams, images,
 * emails, scopes, reasons), and the status. Never the rest of a request: a
 * secret's value, a password, a token or a credential is never read here.
 * Sign-in and password changes aren't recorded (they have their own
 * throttling and logs, and their requests are mostly secrets).
 */
import type { FastifyBaseLogger } from "fastify";
import { db } from "./db/client.js";
import { auditLog } from "./db/schema.js";

/** Body fields that only ever identify what was acted on. */
const TARGET_FIELDS = [
  "name",
  "team",
  "namespace",
  "secretName",
  "secretStoreName",
  "serviceAccount",
  "image",
  "action",
  "email",
  "label",
  "scopes",
  "reason",
  "source",
  "additional",
  "executionId",
  "taskId",
  "tokenId",
  "userId",
  "digest",
  "repository",
  "secretStore",
] as const;

export function targetFields(body: unknown): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  if (body && typeof body === "object" && !Array.isArray(body)) {
    for (const field of TARGET_FIELDS) {
      const value = (body as Record<string, unknown>)[field];
      if (value !== undefined && (typeof value !== "string" || value.length <= 500)) target[field] = value;
    }
    const tasks = (body as Record<string, unknown>)["tasks"];
    if (Array.isArray(tasks)) target["tasks"] = tasks.length;
    // A submission's DAG: its name and how many tasks.
    const dag = (body as Record<string, unknown>)["dag"];
    if (dag) Object.assign(target, targetFields(dag));
  }
  return target;
}

/** Writes one audit entry, as a log line and a row; a failed write is logged. */
export async function writeAuditEntry(
  log: FastifyBaseLogger,
  entry: {
    actorId: string | null;
    method: string;
    route: string;
    target: Record<string, unknown>;
    status: number;
    requestId: string;
  },
): Promise<void> {
  log.info({ event: "audit", ...entry }, `${entry.method} ${entry.route} ${String(entry.status)}`);
  try {
    await db.insert(auditLog).values(entry);
  } catch (error) {
    // The request has been answered; losing its record is logged loudly,
    // and the log line above still has it.
    log.error({ err: error, event: "audit_write_failed" }, "couldn't record an audit entry");
  }
}

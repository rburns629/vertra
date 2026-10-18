// SPDX-License-Identifier: MIT
/**
 * Who changed what: every request that tries to change something through
 * /api (POST, PUT, PATCH, DELETE), allowed or refused, is recorded once it's
 * answered, in the audit_log table and as a structured log line
 * (`event: "audit"`, for shipping to a SIEM). One hook, so a new route is
 * covered without remembering to.
 *
 * Recorded: the caller (its user id; bots are users), the route pattern, the
 * route's parameters, the identifying fields of the body (TARGET_FIELDS:
 * names, teams, images, emails, scopes, reasons), and the status. Never the
 * rest of a body: a secret's value, a password, a token or a credential is
 * never read here. Sign-in and password routes aren't recorded (they have
 * their own throttling and logs, and their bodies are mostly secrets).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { db } from "./db/client.js";
import { auditLog } from "./db/schema.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SKIPPED = /^\/api\/(auth\/|me\/password)/;
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
] as const;

export function auditTarget(request: FastifyRequest): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  if (request.params && typeof request.params === "object") Object.assign(target, request.params);
  const body = request.body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    for (const field of TARGET_FIELDS) {
      const value = (body as Record<string, unknown>)[field];
      if (value !== undefined && (typeof value !== "string" || value.length <= 500)) target[field] = value;
    }
    const tasks = (body as Record<string, unknown>)["tasks"];
    if (Array.isArray(tasks)) target["tasks"] = tasks.length;
  }
  return target;
}

export function registerAudit(app: FastifyInstance): void {
  app.addHook("onResponse", async (request, reply) => {
    if (!MUTATING.has(request.method)) return;
    const route = request.routeOptions.url;
    if (!route?.startsWith("/api/") || SKIPPED.test(route)) return;
    const entry = {
      actorId: request.authUser?.id ?? null,
      method: request.method,
      route,
      target: auditTarget(request),
      status: reply.statusCode,
      requestId: request.id,
    };
    request.log.info({ event: "audit", ...entry }, `${request.method} ${route} ${String(reply.statusCode)}`);
    try {
      await db.insert(auditLog).values(entry);
    } catch (error) {
      // The request has been answered; losing its record is logged loudly,
      // and the log line above still has it.
      request.log.error({ err: error, event: "audit_write_failed" }, "couldn't record an audit entry");
    }
  });
}

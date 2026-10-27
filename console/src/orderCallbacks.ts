// SPDX-License-Identifier: MIT
/**
 * Order callbacks (decision 23): when an ordering bot's order finishes
 * (succeeded, failed or cancelled), its outcome is posted to the bot's
 * callback, so the system that placed it (a storefront, a Marketplace page)
 * hears back without polling. The post is small: which order, which run,
 * how it ended. Its outputs are read with GetExecution, as the bot.
 *
 * Each post is signed with the bot's secret (shown once, when the callback
 * is set): `Vertra-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of
 * "<t>.<body>">`, so a receiver checks it came from this install and isn't
 * an old one replayed. Like a team's webhook, the URL is sealed, only under
 * the install's allowed hosts (config.orders.callbackHosts), never
 * redirected, and posted up to five times, every 30 seconds
 * (notifier.ts's pass).
 */
import type { FastifyBaseLogger } from "fastify";
import { createHmac, randomBytes } from "node:crypto";
import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import { config } from "./config.js";
import { backendAllowed } from "./core/apis.js";
import { db } from "./db/client.js";
import { botCallbacks, callbackDeliveries } from "./db/schema.js";
import { seal, unseal } from "./sealed.js";

const MAX_ATTEMPTS = 5;
/** An order finished longer ago than this when it's recorded isn't news. */
const NEWS_MS = 60 * 60_000;
const URLS = "order callback urls";
const SECRETS = "order callback secrets";

/** Why a callback URL can't be used, or null. */
export function callbackUrlProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "That isn't a URL.";
  }
  if (parsed.protocol !== "https:") return "A callback URL starts with https://.";
  if (parsed.username || parsed.password) return "A callback URL has no user name or password in it.";
  const hosts = config.orders.callbackHosts;
  if (hosts.length === 0) return "This install allows no order callbacks (the console chart's orders.callbackHosts).";
  if (!backendAllowed(url, hosts)) return `Callbacks may only go to ${hosts.join(", ")} (the install's orders.callbackHosts).`;
  return null;
}

/** A new signing secret. */
export function newCallbackSecret(): string {
  return `vcs_${randomBytes(32).toString("base64url")}`;
}

export function sealCallback(url: string, secret: string): { urlEncrypted: string; secretEncrypted: string } {
  return { urlEncrypted: seal(url, URLS), secretEncrypted: seal(secret, SECRETS) };
}

export function unsealSecret(stored: string): string | null {
  return unseal(stored, SECRETS);
}

/** The Vertra-Signature header for a body, at a time (unix seconds). */
export function signature(secret: string, body: string, at: number): string {
  return `t=${String(at)},v1=${createHmac("sha256", secret).update(`${String(at)}.${body}`).digest("hex")}`;
}

export interface FinishedOrder {
  executionId: string;
  submittedBy: string | null;
  template: string | null;
  onBehalfOf: string | null;
  payload: unknown;
  state: string;
  finishedAt: string | null;
}

/** Queues a finished order's outcome for its bot's callback, if it has one; once per finish. */
export async function orderFinished(order: FinishedOrder): Promise<void> {
  if (!order.submittedBy || !order.template) return;
  if (!["SUCCEEDED", "FAILED", "CANCELLED"].includes(order.state)) return;
  const at = order.finishedAt ? Date.parse(order.finishedAt) : NaN;
  if (!Number.isFinite(at) || Date.now() - at > NEWS_MS) return;
  const requestId = (order.payload as { requestId?: unknown } | null)?.requestId;
  const body = JSON.stringify({
    type: "order.finished",
    executionId: order.executionId,
    requestId: typeof requestId === "string" ? requestId : null,
    template: order.template,
    onBehalfOf: order.onBehalfOf,
    state: order.state,
    finishedAt: order.finishedAt,
  });
  // Only a bot with a callback: insert-from-select, so none is a no-op.
  await db
    .insert(callbackDeliveries)
    .select(
      db
        .select({
          key: sql<string>`${`${order.executionId}:${order.state}:${order.finishedAt ?? ""}`}::text`.as("key"),
          botId: botCallbacks.botId,
          body: sql<string>`${body}::text`.as("body"),
          attempts: sql<number>`0`.as("attempts"),
          sentAt: sql<null>`null::timestamptz`.as("sent_at"),
          createdAt: sql<Date>`now()`.as("created_at"),
        })
        .from(botCallbacks)
        .where(eq(botCallbacks.botId, order.submittedBy)),
    )
    .onConflictDoNothing();
}

/** Posts one signed body; throws why it couldn't. */
export async function postCallback(url: string, secret: string, body: string): Promise<void> {
  const problem = callbackUrlProblem(url);
  if (problem) throw new Error(problem);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "vertra-signature": signature(secret, body, Math.floor(Date.now() / 1000)) },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`The callback answered ${String(response.status)}.`);
}

/** Posts what's waiting to be posted, oldest first. */
export async function deliverCallbacks(log: FastifyBaseLogger): Promise<number> {
  const pending = await db
    .select({
      key: callbackDeliveries.key,
      botId: callbackDeliveries.botId,
      attempts: callbackDeliveries.attempts,
      body: callbackDeliveries.body,
      urlEncrypted: botCallbacks.urlEncrypted,
      secretEncrypted: botCallbacks.secretEncrypted,
    })
    .from(callbackDeliveries)
    .innerJoin(botCallbacks, eq(botCallbacks.botId, callbackDeliveries.botId))
    .where(and(isNull(callbackDeliveries.sentAt), lt(callbackDeliveries.attempts, MAX_ATTEMPTS)))
    .orderBy(asc(callbackDeliveries.createdAt))
    .limit(50);
  let sent = 0;
  for (const d of pending) {
    const where = eq(callbackDeliveries.key, d.key);
    try {
      const url = unseal(d.urlEncrypted, URLS);
      const secret = unsealSecret(d.secretEncrypted);
      if (!url || !secret) throw new Error("The stored callback can't be read (the console's key changed): set it again.");
      await postCallback(url, secret, d.body);
      await db.update(callbackDeliveries).set({ sentAt: sql`now()`, attempts: d.attempts + 1 }).where(where);
      await db.update(botCallbacks).set({ lastSentAt: sql`now()`, lastError: null }).where(eq(botCallbacks.botId, d.botId));
      sent += 1;
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      await db.update(callbackDeliveries).set({ attempts: d.attempts + 1 }).where(where);
      await db.update(botCallbacks).set({ lastError: why.slice(0, 500) }).where(eq(botCallbacks.botId, d.botId));
      log.warn({ event: "callback_failed", botId: d.botId, err: why }, "couldn't post to an ordering bot's callback");
    }
  }
  return sent;
}

// SPDX-License-Identifier: MIT
/**
 * An ordering bot's rate (decision 23): at most config.orders.ratePerMinute
 * orders in any minute, counted from the runs it made (submitted_executions),
 * so every console replica sees the same count. Past it: resource_exhausted
 * (429) with Retry-After, the gateway's refusal. A retried order (its
 * requestId) makes no new run, so it isn't counted twice; a schedule's runs
 * aren't limited.
 */
import { and, count, eq, gt, isNull, min, sql } from "drizzle-orm";
import { ApiError } from "../apiError.js";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { submittedExecutions } from "../db/schema.js";

const WINDOW_MS = 60_000;

/** Throws the 429 when an ordering bot already placed its minute's orders. Anyone else: nothing. */
export async function ensureOrderRate(caller: { id: string; orderTemplates?: string[] } | undefined): Promise<void> {
  if (!caller?.orderTemplates) return;
  const limit = config.orders.ratePerMinute;
  const [recent] = await db
    .select({ made: count(), oldest: min(submittedExecutions.createdAt) })
    .from(submittedExecutions)
    .where(
      and(
        eq(submittedExecutions.submittedBy, caller.id),
        isNull(submittedExecutions.scheduleId),
        gt(submittedExecutions.createdAt, sql`now() - interval '1 minute'`),
      ),
    );
  if (!recent || recent.made < limit) return;
  const oldest = recent.oldest ? new Date(recent.oldest).getTime() : Date.now();
  const retryAfterSeconds = Math.max(1, Math.ceil((oldest + WINDOW_MS - Date.now()) / 1000));
  throw new ApiError(
    429,
    "RATE_LIMITED",
    `This bot placed ${String(limit)} orders in the last minute, the most it may. Try again in ${String(retryAfterSeconds)} seconds.`,
    undefined,
    { retryAfterSeconds },
  );
}

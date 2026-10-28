// SPDX-License-Identifier: MIT
/**
 * Slows password guessing against one account, from any number of IPs,
 * without locking its owner out.
 *
 * The per-IP limit on sign-in (rpc/services/auth.ts) stops one source; an
 * attacker with many IPs gets 10 guesses per IP per window. This counts an
 * account's failed sign-ins across all sources instead, and past a free
 * allowance spaces attempts out: after FREE_FAILURES failures within the
 * window, the next attempt must wait 1 s, then 2 s, 4 s ... up to
 * MAX_GAP_MS. An attempt that comes too soon is refused before its
 * password is checked, so refusals reveal nothing about the password. So a
 * sustained attack gets about one guess a minute against an account, and
 * its real owner waits at most a minute for a turn instead of being locked
 * out. A successful sign-in clears the account's count.
 *
 * Counted for every email tried, existing or not: throttling only real
 * accounts would tell an attacker which emails exist. In Postgres
 * (sign_in_failures), so every copy of the console counts the same
 * failures; retention.ts deletes rows whose window has passed.
 */
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { signInFailures } from "../db/schema.js";

const WINDOW_MS = 60 * 60 * 1000;
const FREE_FAILURES = 10;
const MAX_GAP_MS = 60 * 1000;

function key(email: string): string {
  return email.trim().toLowerCase();
}

/** Seconds until this account may try again, or 0 if it may now. */
export async function loginWaitSeconds(email: string, now = Date.now()): Promise<number> {
  const [state] = await db.select().from(signInFailures).where(eq(signInFailures.email, key(email)));
  if (!state?.nextAt || now - state.windowStart.getTime() > WINDOW_MS) return 0;
  const next = state.nextAt.getTime();
  return next > now ? Math.ceil((next - now) / 1000) : 0;
}

export async function recordLoginFailure(email: string, now = Date.now()): Promise<void> {
  const at = new Date(now);
  const windowEnded = new Date(now - WINDOW_MS);
  // One statement, so failures from two consoles at once both count.
  const { rows } = await db.execute<{ failures: number }>(sql`
    INSERT INTO sign_in_failures (email, failures, window_start) VALUES (${key(email)}, 1, ${at})
    ON CONFLICT (email) DO UPDATE SET
      failures = CASE WHEN sign_in_failures.window_start < ${windowEnded} THEN 1 ELSE sign_in_failures.failures + 1 END,
      window_start = CASE WHEN sign_in_failures.window_start < ${windowEnded} THEN ${at} ELSE sign_in_failures.window_start END
    RETURNING failures`);
  const over = (rows[0]?.failures ?? 0) - FREE_FAILURES;
  const nextAt = over > 0 ? new Date(now + Math.min(1000 * 2 ** (over - 1), MAX_GAP_MS)) : null;
  await db.update(signInFailures).set({ nextAt }).where(eq(signInFailures.email, key(email)));
}

export async function recordLoginSuccess(email: string): Promise<void> {
  await db.delete(signInFailures).where(eq(signInFailures.email, key(email)));
}

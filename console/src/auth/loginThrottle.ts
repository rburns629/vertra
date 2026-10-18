// SPDX-License-Identifier: MIT
/**
 * Slows password guessing against one account, from any number of IPs,
 * without locking its owner out.
 *
 * The per-IP limit on /auth/login (routes/auth.ts) stops one source; an
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
 * accounts would tell an attacker which emails exist. In memory and per
 * replica, like the per-IP limit (the console runs one replica); a restart
 * forgets the counts, which only ever errs toward letting someone in.
 */

const WINDOW_MS = 60 * 60 * 1000;
const FREE_FAILURES = 10;
const MAX_GAP_MS = 60 * 1000;
// Bounds the memory an attacker can make this hold by spraying emails.
const MAX_TRACKED = 50_000;

interface AccountState {
  failures: number;
  windowStart: number;
  /** No attempt is evaluated before this time. */
  nextAt: number;
}

const accounts = new Map<string, AccountState>();

function key(email: string): string {
  return email.trim().toLowerCase();
}

function current(email: string, now: number): AccountState | undefined {
  const state = accounts.get(key(email));
  if (state && now - state.windowStart > WINDOW_MS) {
    accounts.delete(key(email));
    return undefined;
  }
  return state;
}

/** Seconds until this account may try again, or 0 if it may now. */
export function loginWaitSeconds(email: string, now = Date.now()): number {
  const state = current(email, now);
  return state && state.nextAt > now ? Math.ceil((state.nextAt - now) / 1000) : 0;
}

export function recordLoginFailure(email: string, now = Date.now()): void {
  const state = current(email, now) ?? { failures: 0, windowStart: now, nextAt: 0 };
  state.failures += 1;
  const over = state.failures - FREE_FAILURES;
  state.nextAt = over > 0 ? now + Math.min(1000 * 2 ** (over - 1), MAX_GAP_MS) : 0;
  accounts.delete(key(email)); // re-insert, so the Map stays oldest-first
  accounts.set(key(email), state);
  if (accounts.size > MAX_TRACKED) prune(now);
}

export function recordLoginSuccess(email: string): void {
  accounts.delete(key(email));
}

function prune(now: number): void {
  for (const [email, state] of accounts) {
    if (now - state.windowStart > WINDOW_MS) accounts.delete(email);
  }
  // Still too many: drop the least recently failed.
  for (const email of accounts.keys()) {
    if (accounts.size <= MAX_TRACKED) break;
    accounts.delete(email);
  }
}

/** Tests only: forget every account. */
export function resetLoginThrottle(): void {
  accounts.clear();
}

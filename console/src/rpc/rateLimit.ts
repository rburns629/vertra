// SPDX-License-Identifier: MIT
/**
 * Fixed-window limits for the Connect methods that check a password or are
 * otherwise worth bounding (sign-in, registration, password change, adding
 * members): fixed windows and keys per caller or address, since Connect's
 * routes can't carry @fastify/rate-limit settings.
 *
 * In memory, per replica, like those: fine at one replica; more need a
 * shared store for the limit to mean anything.
 */
import { Code, type HandlerContext } from "@connectrpc/connect";
import { rpcError } from "./errors.js";

/** At most this many windows remembered; expired ones are dropped first. */
const MAX_KEYS = 10_000;

export class FixedWindowLimit {
  private readonly windows = new Map<string, { count: number; resetsAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /**
   * Counts an attempt for `key`; throws resource_exhausted, with a
   * Retry-After header, once more than `max` were made this window.
   */
  take(key: string, ctx: HandlerContext, now = Date.now()): void {
    let window = this.windows.get(key);
    if (!window || window.resetsAt <= now) {
      if (this.windows.size >= MAX_KEYS) this.prune(now);
      window = { count: 0, resetsAt: now + this.windowMs };
      this.windows.set(key, window);
    }
    window.count += 1;
    if (window.count <= this.max) return;
    const seconds = Math.ceil((window.resetsAt - now) / 1000);
    ctx.responseHeader.set("Retry-After", String(seconds));
    throw rpcError(
      Code.ResourceExhausted,
      "RATE_LIMITED",
      `Too many attempts. Try again in ${describe(seconds)}.`,
      true,
    );
  }

  private prune(now: number): void {
    for (const [key, window] of this.windows) {
      if (window.resetsAt <= now) this.windows.delete(key);
    }
    // Still full: drop the oldest.
    for (const key of this.windows.keys()) {
      if (this.windows.size < MAX_KEYS) break;
      this.windows.delete(key);
    }
  }
}

function describe(seconds: number): string {
  if (seconds < 120) return `${String(seconds)} seconds`;
  return `${String(Math.ceil(seconds / 60))} minutes`;
}

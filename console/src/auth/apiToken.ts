// SPDX-License-Identifier: MIT
/**
 * API tokens for bot users (see db/schema.ts's users.isBot) -- a durable,
 * revocable credential for non-interactive callers (catalog CI) that can't
 * do the human /auth/login flow. A fast hash, not argon2: the raw token is
 * 256 bits of real randomness, not a human-guessable password, so there's
 * no brute-force surface for argon2's deliberate slowness to defend
 * against -- it would only cost every lookup for nothing.
 */
import { createHash, randomBytes } from "node:crypto";

export const API_TOKEN_PREFIX = "mp_";

export function generateApiToken(): string {
  return API_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function hashApiToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

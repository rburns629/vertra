// SPDX-License-Identifier: MIT
/**
 * argon2id — the current recommended default (winner of the Password
 * Hashing Competition, more resistant to GPU/ASIC cracking than bcrypt).
 * Never hand-roll parameters here; the library's defaults are already
 * tuned to current guidance.
 */
import { Type } from "@sinclair/typebox";
import { randomBytes } from "node:crypto";
import * as argon2 from "argon2";

/** The policy for any *new* password: registration, self-service change,
 * and admin reset. Deliberately not applied at login, so an account created
 * under an older, shorter minimum can still sign in and then change it.
 * The upper bound only stops a multi-megabyte body from being fed to
 * argon2. */
export const NewPassword = Type.String({ minLength: 12, maxLength: 256 });

export function hashPassword(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, { type: argon2.argon2id });
}

export function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
  return argon2.verify(hash, plaintext);
}

let dummyHash: Promise<string> | undefined;

/** Checks a password against a throwaway hash, taking as long as a real
 * check. The login route calls this when the email has no account, so a
 * wrong guess costs the same time either way and response times don't
 * reveal which emails exist. */
export async function verifyAgainstNothing(plaintext: string): Promise<false> {
  dummyHash ??= hashPassword(randomBytes(32).toString("hex"));
  await argon2.verify(await dummyHash, plaintext);
  return false;
}

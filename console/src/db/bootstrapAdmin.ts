// SPDX-License-Identifier: MIT
/**
 * Ensures a first-login account exists after a brand-new install, so
 * standing up the system doesn't require an out-of-band bootstrap step.
 * Idempotent -- only creates the account if its email doesn't already
 * exist, so re-running migrations (a Helm upgrade, a local re-run) never
 * touches an admin password someone already changed.
 *
 * Deliberately never a hardcoded password: BOOTSTRAP_ADMIN_PASSWORD is
 * read the same way every other credential in this system flows in (an
 * env var / mounted Secret at deploy time, never baked into the image or
 * committed to git — see CLAUDE.md's security section). If it isn't set,
 * a random one is generated and printed once to the migration's own log
 * output -- the operator retrieves it from there (`vertra apply` shows it,
 * or `kubectl logs` on the migrate Job), the same one-time-initial-password
 * pattern Jenkins/Grafana use, rather than a value anyone could guess.
 * Because it was printed, its owner must choose their own at first sign-in
 * (users.must_change_password); a password the operator set themselves
 * (kind's fixed local one) isn't forced.
 *
 * Takes the `db` the migration runner already opened, rather than
 * importing db/queries.ts (which opens its own separate connection pool,
 * one a one-shot script would then have to know to close too).
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { hashPassword } from "../auth/password.js";
import * as schema from "./schema.js";

export async function seedBootstrapAdmin<S extends Record<string, unknown>>(
  db: NodePgDatabase<S>,
  email: string,
  givenPassword: string | undefined,
): Promise<void> {
  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);
  if (existing) return;

  const password = givenPassword ?? randomBytes(18).toString("base64url");
  await db.insert(schema.users).values({
    email,
    passwordHash: await hashPassword(password),
    isAdmin: true,
    mustChangePassword: givenPassword === undefined,
  });

  console.log(`Bootstrap admin account created: ${email}`);
  if (givenPassword === undefined) {
    console.log(
      `No BOOTSTRAP_ADMIN_PASSWORD was set, so one was generated: ${password}\n` +
        "Save this now -- it is not stored anywhere in plaintext and will not be shown again. " +
        "It must be changed at the first sign-in.",
    );
  }
}

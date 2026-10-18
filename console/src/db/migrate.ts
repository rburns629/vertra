// SPDX-License-Identifier: MIT
/** Applies pending migrations, then exits — run once at deploy time (a
 * migration Job, matching kernel/ Helm chart's own migrate-then-serve
 * pattern), not from inside the running server. */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import * as schema from "./schema.js";
import { hashPassword } from "../auth/password.js";

/**
 * Ensures a first-login account exists after a brand-new install, so
 * standing up the system doesn't require an out-of-band bootstrap step.
 * Idempotent -- only creates the account if BOOTSTRAP_ADMIN_EMAIL doesn't
 * already exist, so re-running migrations (a Helm upgrade, a local re-run)
 * never touches an admin password someone already changed.
 *
 * Deliberately never a hardcoded password: BOOTSTRAP_ADMIN_PASSWORD is
 * read the same way every other credential in this system flows in (an
 * env var / mounted Secret at deploy time, never baked into the image or
 * committed to git — see CLAUDE.md's security section). If it isn't set,
 * a random one is generated and printed once to this job's own log output
 * -- the operator retrieves it from there (`kubectl logs` on the migrate
 * Job, or the local `npm run db:migrate` output), the same one-time-
 * initial-password pattern Jenkins/Grafana use, rather than a value
 * anyone could guess.
 *
 * Uses the same `db` the migration runner already opened, rather than
 * importing db/queries.ts (which opens its own separate connection pool,
 * one this one-shot script would then have to know to close too).
 */
async function seedBootstrapAdmin(db: NodePgDatabase): Promise<void> {
  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, config.bootstrapAdminEmail))
    .limit(1);
  if (existing) return;

  const password = config.bootstrapAdminPassword ?? randomBytes(18).toString("base64url");
  await db.insert(schema.users).values({
    email: config.bootstrapAdminEmail,
    passwordHash: await hashPassword(password),
    isAdmin: true,
  });

  console.log(`Bootstrap admin account created: ${config.bootstrapAdminEmail}`);
  if (!config.bootstrapAdminPassword) {
    console.log(
      `No BOOTSTRAP_ADMIN_PASSWORD was set, so one was generated: ${password}\n` +
        "Save this now -- it is not stored anywhere in plaintext and will not be shown again.",
    );
  }
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: config.databaseUrl });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./src/db/migrations" });
  console.log("Migrations applied.");

  await seedBootstrapAdmin(db);

  await pool.end();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

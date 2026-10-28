// SPDX-License-Identifier: MIT
import pg from "pg";

/**
 * Sign-in's limits are counted in the database now (rpc/rateLimit.ts,
 * auth/loginThrottle.ts), so a run would inherit the last one's counts:
 * every run starts with none.
 */
export default async function setup(): Promise<void> {
  const client = new pg.Client({ connectionString: process.env["TEST_DATABASE_URL"] ?? "postgresql://localhost/execution_console_test" });
  await client.connect();
  try {
    await client.query("DELETE FROM rate_limit_windows; DELETE FROM sign_in_failures; DELETE FROM revoked_sessions;");
  } finally {
    await client.end();
  }
}

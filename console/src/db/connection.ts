// SPDX-License-Identifier: MIT
/**
 * How every pool the console opens connects: DATABASE_URL, and with
 * DATABASE_IAM_AUTH=gcp, its Workload Identity's short-lived token as each
 * new connection's password (Cloud SQL's IAM database authentication), so
 * no database password exists anywhere.
 */
import type { PoolConfig } from "pg";
import { parseIntoClientConfig } from "pg-connection-string";
import { config } from "../config.js";
import { gcpMetadataToken } from "../gcpMetadata.js";

export function poolConfig(max?: number): PoolConfig {
  const pool = { ...(max ? { max } : {}) };
  if (config.databaseIamAuth !== "gcp") return { connectionString: config.databaseUrl, ...pool };
  // The URL parsed here, not given as connectionString: node-postgres
  // parses that over every other option, its empty password included,
  // which would replace the token.
  return { ...parseIntoClientConfig(config.databaseUrl), ...pool, password: gcpMetadataToken };
}

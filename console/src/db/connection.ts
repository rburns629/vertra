// SPDX-License-Identifier: MIT
/**
 * How every pool the console opens connects: DATABASE_URL, and with
 * DATABASE_IAM_AUTH, a short-lived token as each new connection's password,
 * so no database password exists anywhere: gcp, its Workload Identity's
 * (Cloud SQL's IAM database authentication); aws, one its role signs for
 * Amazon RDS (db/rds.ts).
 */
import type { PoolConfig } from "pg";
import { parseIntoClientConfig } from "pg-connection-string";
import { config } from "../config.js";
import { gcpMetadataToken } from "../gcpMetadata.js";
import { rdsTokens } from "./rds.js";

export function poolConfig(max?: number): PoolConfig {
  // A connection opened just as Postgres moves (its Pod replaced) would
  // otherwise wait out TCP's retries, about two minutes, and every request
  // needing one with it.
  const pool = { ...(max ? { max } : {}), connectionTimeoutMillis: config.databaseConnectTimeoutSeconds * 1000 };
  if (config.databaseIamAuth === "") return { connectionString: config.databaseUrl, ...pool };
  // The URL parsed here, not given as connectionString: node-postgres
  // parses that over every other option, its empty password included,
  // which would replace the token.
  const parsed = parseIntoClientConfig(config.databaseUrl);
  const password =
    config.databaseIamAuth === "aws"
      ? rdsTokens(config.databaseIamRegion, parsed.host ?? "", parsed.port ?? 5432, parsed.user ?? "")
      : gcpMetadataToken;
  return { ...parsed, ...pool, password };
}

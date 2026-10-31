// SPDX-License-Identifier: MIT
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import { poolConfig } from "./connection.js";
import * as schema from "./schema.js";

const pool = new Pool(poolConfig(config.databasePoolSize));
// An idle connection Postgres closes (a restart, a failover) is an error on
// the pool, not on any request: unheard, Node ends the whole process. The
// pool drops that connection and opens another when one's needed.
pool.on("error", (err) => {
  console.error(JSON.stringify({ level: 50, event: "database_connection_lost", msg: "an idle database connection was closed", err: err.message }));
});

export const db = drizzle(pool, { schema });

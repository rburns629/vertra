// SPDX-License-Identifier: MIT
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import { poolConfig } from "./connection.js";
import * as schema from "./schema.js";

const pool = new Pool(poolConfig(config.databasePoolSize));

export const db = drizzle(pool, { schema });

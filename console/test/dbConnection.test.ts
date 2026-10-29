// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import { poolConfig } from "../src/db/connection.js";
import { gcpMetadataToken } from "../src/gcpMetadata.js";

describe("how the console connects to its database", () => {
  const before = config.databaseIamAuth;
  afterEach(() => {
    (config as { databaseIamAuth: string }).databaseIamAuth = before;
  });

  it("uses the URL's password, unless signing in with its cloud identity", () => {
    expect(poolConfig(7)).toEqual({ connectionString: config.databaseUrl, max: 7 });
    (config as { databaseIamAuth: string }).databaseIamAuth = "gcp";
    // Each new connection asks for the token (kept until a minute before it
    // expires), and nothing parsed from the URL is left to replace it: a
    // connectionString would, with its empty password.
    const iam = poolConfig(7);
    expect(iam.password).toBe(gcpMetadataToken);
    expect(iam.connectionString).toBeUndefined();
    expect(iam.max).toBe(7);
    // As node-postgres merges them (connection-parameters.js).
    expect(Object.assign({}, iam).password).toBe(gcpMetadataToken);
  });
});

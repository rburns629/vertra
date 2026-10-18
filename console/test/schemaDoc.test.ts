// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../src/db/schema.js";

/** The columns each "### <table>" section of a doc documents: the
 * backticked names in the first cell of its table rows. */
function documentedColumns(markdown: string): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  let current: Set<string> | null = null;
  for (const line of markdown.split("\n")) {
    const heading = /^#{2,3} (.+)$/.exec(line);
    if (heading?.[1]) {
      const name = /^[a-z_]+$/.test(heading[1]) ? heading[1] : null;
      current = name ? new Set() : null;
      if (name && current) tables.set(name, current);
      continue;
    }
    const firstCell = /^\| (`[^|]+) \|/.exec(line)?.[1];
    if (current && firstCell) {
      for (const match of firstCell.matchAll(/`([a-z_]+)`/g)) if (match[1]) current.add(match[1]);
    }
  }
  return tables;
}

describe("the database guide", () => {
  const doc = readFileSync(new URL("../docs/06-database-schemas.md", import.meta.url), "utf8");
  // Only the console's half: the kernel's tables are checked by the kernel's tests.
  const consoleHalf = doc.slice(doc.indexOf("## The console database"));

  it("documents every console table and column, and nothing that's gone", () => {
    const actual = new Map(
      Object.values(schema)
        .filter((value): value is PgTable => is(value, PgTable))
        .map((table) => {
          const config = getTableConfig(table);
          return [config.name, new Set(config.columns.map((c) => c.name))] as const;
        }),
    );
    const documented = documentedColumns(consoleHalf);
    expect([...documented.keys()].sort()).toEqual([...actual.keys()].sort());
    for (const [table, columns] of actual) {
      expect([...(documented.get(table) ?? [])].sort(), table).toEqual([...columns].sort());
    }
  });
});

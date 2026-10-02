/**
 * Ratchet on tables that exist only through runtime DDL.
 *
 * The schema is defined in several places: shared/schema (Drizzle), ordered
 * startup migrations, always-run ensure* services, preload bridges and SQL
 * migrations. Tables created outside shared/schema are invisible to
 * drizzle-kit, which is why drizzle.config.ts filters push to declared tables
 * and `npm run db:push` refuses non-empty databases. This test keeps the gap
 * from growing: a new runtime-only table must be declared in shared/schema
 * instead, and a table that gets declared must leave the baseline.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

import * as schema from "../shared/schema";

const root = process.cwd();
const baseline = JSON.parse(fs.readFileSync(path.join(root, "config/runtime-only-tables.json"), "utf8")) as {
  tables: string[];
};

function runtimeCreatedTables(): Set<string> {
  const files = execFileSync("git", ["ls-files", "server", "migrations"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((file) => /\.(ts|mjs|sql)$/.test(file) && !file.includes(".test."));
  const names = new Set<string>();
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    for (const match of source.matchAll(/CREATE TABLE IF NOT EXISTS\s+(?:public\.)?"?([a-z0-9_]+)"?/gi)) {
      names.add(match[1].toLowerCase());
    }
  }
  return names;
}

describe("runtime-only tables", () => {
  it("only shrink: new tables are declared in shared/schema", () => {
    const declared = new Set(
      Object.values(schema)
        .filter((value): value is PgTable => value instanceof PgTable)
        .map((table) => getTableConfig(table).name)
    );
    const runtimeOnly = [...runtimeCreatedTables()].filter((name) => !declared.has(name)).sort();
    const allowed = new Set(baseline.tables);

    const added = runtimeOnly.filter((name) => !allowed.has(name));
    expect(added, `Declare these tables in shared/schema instead of only in runtime DDL: ${added.join(", ")}`).toEqual(
      []
    );

    const resolved = baseline.tables.filter((name) => !runtimeOnly.includes(name));
    expect(
      resolved,
      `These tables are now declared in shared/schema (or no longer created); remove them from config/runtime-only-tables.json: ${resolved.join(", ")}`
    ).toEqual([]);
  });
});

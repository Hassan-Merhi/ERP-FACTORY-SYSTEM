/**
 * Ratchet on tables that the migrations create but shared/schema does not declare.
 *
 * The schema is owned by numbered migrations (migrations/manifest/schema.tsv is
 * the catalog they produce); shared/schema (Drizzle) is the typed query layer.
 * Tables missing from shared/schema are invisible to typed queries and to
 * drizzle-kit, which is why drizzle.config.ts filters push to declared tables.
 * This test keeps the gap from growing: a new undeclared table must be declared
 * in shared/schema instead, and a table that gets declared (or is no longer
 * created) must leave config/runtime-only-tables.json.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

import * as schema from "../shared/schema";
import { schemaManifest } from "./helpers/schemaManifest";

const root = process.cwd();
const baseline = JSON.parse(fs.readFileSync(path.join(root, "config/runtime-only-tables.json"), "utf8")) as {
  tables: string[];
};

/** Every public table the migrations create. */
function migratedTables(): Set<string> {
  return new Set(
    schemaManifest()
      .filter((entry) => entry.kind === "table" && entry.identity.startsWith("public."))
      .map((entry) => entry.identity.slice("public.".length).replace(/^"(.*)"$/, "$1"))
  );
}

describe("runtime-only tables", () => {
  it("only shrink: new tables are declared in shared/schema", () => {
    const declared = new Set(
      Object.values(schema)
        .filter((value): value is PgTable => value instanceof PgTable)
        .map((table) => getTableConfig(table).name)
    );
    const runtimeOnly = [...migratedTables()].filter((name) => !declared.has(name)).sort();
    const allowed = new Set(baseline.tables);

    const added = runtimeOnly.filter((name) => !allowed.has(name));
    expect(added, `Declare these tables in shared/schema: ${added.join(", ")}`).toEqual([]);

    const resolved = baseline.tables.filter((name) => !runtimeOnly.includes(name));
    expect(
      resolved,
      `These tables are now declared in shared/schema (or no longer created by migrations); remove them from config/runtime-only-tables.json: ${resolved.join(", ")}`
    ).toEqual([]);
  });
});

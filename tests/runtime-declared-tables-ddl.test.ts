/**
 * shared/schema/runtime declares tables that used to be created only by runtime
 * DDL. The schema now comes from migrations alone (migrations/manifest/schema.tsv
 * is the catalog they produce), so a column declared in Drizzle but missing from
 * the migrations would make queries fail, and a migrated column missing from the
 * declaration would be invisible to typed queries. This test keeps the two in
 * step: every column the migrations create for a declared runtime table is
 * declared, and every declared column is created by the migrations.
 */
import { describe, it, expect } from "vitest";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

import * as runtimeTables from "../shared/schema/runtime";
import { hasTable, schemaManifest } from "./helpers/schemaManifest";

function migratedColumns(table: string, schema = "public"): Set<string> {
  const prefix = `${schema}.${table}.`;
  return new Set(
    schemaManifest()
      .filter((entry) => entry.kind === "column" && entry.identity.startsWith(prefix))
      // Reserved words such as "position" are quoted in the identity.
      .map((entry) => entry.identity.slice(prefix.length).replace(/^"(.*)"$/, "$1"))
  );
}

describe("declared runtime tables", () => {
  const tables = Object.values(runtimeTables).filter((value): value is PgTable => value instanceof PgTable);

  it("declares every runtime table it exports", () => {
    expect(tables.length).toBeGreaterThan(0);
  });

  for (const table of tables) {
    const config = getTableConfig(table);
    it(`${config.name} matches its migrated columns`, () => {
      const schema = config.schema ?? "public";
      expect(hasTable(`${schema}.${config.name}`), `${config.name} is not created by migrations/`).toBe(true);
      const migrated = migratedColumns(config.name, schema);
      const declared = new Set(config.columns.map((column) => column.name));
      expect([...migrated].filter((column) => !declared.has(column)).sort(), "created by migrations, not declared").toEqual(
        []
      );
      expect([...declared].filter((column) => !migrated.has(column)).sort(), "declared, not created by migrations").toEqual(
        []
      );
    });
  }
});

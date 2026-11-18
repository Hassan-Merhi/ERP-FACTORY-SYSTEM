/**
 * Column defaults: the Drizzle declarations must state what the migrations create.
 *
 * Inserts through Drizzle omit columns that are not given, so the database's own
 * default is what applies. The schema now comes from migrations/ alone (the
 * catalog is migrations/manifest/schema.tsv), so a default declared only in
 * Drizzle is never applied, and a migrated default missing from Drizzle is
 * invisible to the code. Both happened: users.chatbot_enabled was declared true
 * while every database defaults it to false, and factory_bales.cost_per_kg was
 * declared DEFAULT 0 with no default in the database (fixed by migration 0008).
 *
 * The comparison is semantic: casts, numeric quoting and now()/CURRENT_TIMESTAMP
 * spellings are normalised away, so only a different value fails.
 */
import { describe, it, expect } from "vitest";
import { is, SQL } from "drizzle-orm";
import { getTableConfig, PgDialect, PgTable } from "drizzle-orm/pg-core";

import * as schema from "../shared/schema";
import { schemaManifest } from "./helpers/schemaManifest";

const dialect = new PgDialect();

/** A default expression without casts, parentheses or equivalent spellings. */
function normalise(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  let text = String(value)
    .replace(/::[a-z ]+(\(\d+(,\s*\d+)?\))?(\[\])?/gi, "")
    .replace(/public\./g, "")
    .trim();
  while (/^\((.*)\)$/s.test(text)) text = text.slice(1, -1).trim();
  // PostgreSQL stores interval literals as hh:mm:ss: interval '20 minutes' == '00:20:00'.
  text = text.replace(/interval '(\d+) (second|minute|hour)s?'/gi, (_, amount: string, unit: string) => {
    const seconds = Number(amount) * { second: 1, minute: 60, hour: 3600 }[unit.toLowerCase() as "second"];
    const pad = (n: number) => String(n).padStart(2, "0");
    return `'${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}'`;
  });
  if (/^current_timestamp$/i.test(text)) text = "now()";
  if (/^nextval\(/i.test(text)) text = "nextval";
  text = text.replace(/^'(-?\d+(\.\d+)?)'$/, "$1").replace(/^(-?\d+)\.0+$/, "$1");
  return text;
}

type DrizzleColumn = {
  name: string;
  hasDefault: boolean;
  default: unknown;
  columnType: string;
  defaultFn?: unknown;
};

/** The SQL default a Drizzle column declares, or undefined for client-side ($defaultFn) defaults. */
function declaredDefault(column: DrizzleColumn): string | null | undefined {
  if (/Serial/.test(column.columnType)) return "nextval";
  if (column.defaultFn !== undefined && column.default === undefined) return undefined;
  if (!column.hasDefault || column.default === undefined) return null;
  const value = column.default;
  if (is(value, SQL)) return normalise(dialect.sqlToQuery(value as SQL).sql);
  if (typeof value === "string") return normalise(`'${value.replace(/'/g, "''")}'`);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // Array columns: PostgreSQL array literal, e.g. [] -> '{}', ["a"] -> '{a}'.
  if (Array.isArray(value) && column.columnType === "PgArray") return normalise(`'{${value.join(",")}}'`);
  if (value && typeof value === "object") return normalise(`'${JSON.stringify(value)}'`);
  return normalise(String(value));
}

describe("Drizzle column defaults", () => {
  const migrated = new Map<string, string | null>();
  for (const entry of schemaManifest()) {
    if (entry.kind !== "column") continue;
    migrated.set(entry.identity, normalise((entry.def as { default?: string | null }).default));
  }
  const tables = Object.values(schema).filter((value): value is PgTable => is(value, PgTable));

  it("finds the declared tables and the migrated columns", () => {
    expect(tables.length).toBeGreaterThan(100);
    expect(migrated.size).toBeGreaterThan(1000);
  });

  it("declares exactly the default every migrated column has", () => {
    const mismatches: string[] = [];
    let compared = 0;
    for (const table of tables) {
      const config = getTableConfig(table);
      for (const column of config.columns as unknown as DrizzleColumn[]) {
        const identity = `${config.schema ?? "public"}.${config.name}.${/^[a-z_][a-z0-9_]*$/.test(column.name) ? column.name : `"${column.name}"`}`;
        if (!migrated.has(identity)) continue;
        const declared = declaredDefault(column);
        if (declared === undefined) continue;
        compared += 1;
        const actual = migrated.get(identity) ?? null;
        if (declared !== actual)
          mismatches.push(`${identity}: Drizzle ${declared ?? "no default"}, migrations ${actual ?? "no default"}`);
      }
    }
    expect(compared).toBeGreaterThan(1000);
    expect(mismatches).toEqual([]);
  });
});

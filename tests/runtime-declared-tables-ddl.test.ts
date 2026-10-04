/**
 * shared/schema/runtime declares tables that runtime DDL also creates
 * (CREATE TABLE IF NOT EXISTS in server/ and migrations/). drizzle-kit push
 * creates them from the declaration first, after which the runtime CREATE is a
 * no-op, so a column added to the runtime DDL but not to the declaration
 * would silently never exist in a pushed database. This test keeps the two in
 * step: every column the runtime DDL creates or adds for a declared runtime
 * table is declared, and every declared column is created by the DDL.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

import * as runtimeTables from "../shared/schema/runtime";

const root = process.cwd();

const CONSTRAINT_WORDS = new Set(["constraint", "primary", "unique", "foreign", "check", "exclude"]);

function ddlSources(): string[] {
  // CI checks the repository out as a tarball without .git, so walk the tree.
  return ["server", "migrations"]
    .flatMap((dir) =>
      (fs.readdirSync(path.join(root, dir), { recursive: true }) as string[]).map((file) => path.join(dir, file))
    )
    .filter((file) => /\.(ts|mjs|sql)$/.test(file) && !file.includes(".test."))
    .map((file) => fs.readFileSync(path.join(root, file), "utf8"));
}

/** The body of `CREATE TABLE IF NOT EXISTS name (...)`, matching parentheses. */
function createTableBody(source: string, start: number): string | null {
  const open = source.indexOf("(", start);
  if (open < 0) return null;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    else if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return null;
}

function topLevelParts(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of body) {
    if (char === "(" || char === "[") depth += 1;
    if (char === ")" || char === "]") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  return parts.map((part) => part.replace(/--[^\n]*/g, "").trim()).filter(Boolean);
}

function runtimeColumns(table: string, sources: string[]): Set<string> {
  const columns = new Set<string>();
  const create = new RegExp(`CREATE TABLE IF NOT EXISTS\\s+(?:public\\.)?"?${table}"?\\s*\\(`, "gi");
  // One ALTER TABLE statement may add several columns; read it up to its end.
  const alter = new RegExp(
    `ALTER TABLE\\s+(?:IF EXISTS\\s+)?(?:ONLY\\s+)?(?:public\\.)?"?${table}"?\\s([^;\`]*)`,
    "gi"
  );
  for (const source of sources) {
    for (const match of source.matchAll(create)) {
      const body = createTableBody(source, match.index ?? 0);
      if (!body) continue;
      for (const part of topLevelParts(body)) {
        const word = /^"?([A-Za-z0-9_]+)"?/.exec(part)?.[1];
        if (word && !CONSTRAINT_WORDS.has(word.toLowerCase())) columns.add(word.toLowerCase());
      }
    }
    for (const statement of source.matchAll(alter)) {
      for (const added of statement[1].matchAll(/ADD COLUMN\s+(?:IF NOT EXISTS\s+)?"?([a-z0-9_]+)"?/gi)) {
        columns.add(added[1].toLowerCase());
      }
    }
  }
  return columns;
}

describe("declared runtime tables", () => {
  const sources = ddlSources();
  const tables = Object.values(runtimeTables).filter((value): value is PgTable => value instanceof PgTable);

  it("declares every runtime table it exports", () => {
    expect(tables.length).toBeGreaterThan(0);
  });

  for (const table of tables) {
    const config = getTableConfig(table);
    it(`${config.name} matches its runtime DDL columns`, () => {
      const ddl = runtimeColumns(config.name, sources);
      expect(ddl.size, `no CREATE TABLE IF NOT EXISTS ${config.name} found in server/ or migrations/`).toBeGreaterThan(
        0
      );
      const declared = new Set(config.columns.map((column) => column.name));
      expect([...ddl].filter((column) => !declared.has(column)).sort(), "created by runtime DDL, not declared").toEqual(
        []
      );
      expect([...declared].filter((column) => !ddl.has(column)).sort(), "declared, not created by runtime DDL").toEqual(
        []
      );
    });
  }
});

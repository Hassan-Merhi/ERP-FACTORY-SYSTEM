#!/usr/bin/env node
/**
 * Runtime DDL audit: the application must never change the database schema.
 *
 * Schema changes live only in migrations/ (applied by scripts/db/migrate.mjs).
 * This audit scans every runtime source file under server/ and shared/ (tests
 * excluded) and fails if a string, template or SQL literal contains a
 * schema-changing statement: CREATE/ALTER/DROP of tables, indexes, functions,
 * triggers, views, policies, sequences, schemas, extensions or types, COMMENT ON,
 * row-level-security toggles, or ADD/DROP COLUMN. Comments are ignored, so
 * history notes remain allowed.
 *
 * `CREATE TEMP[ORARY] TABLE` is deliberately not matched: a session/transaction
 * temporary table (e.g. ON COMMIT DROP scratch space inside an audited data
 * repair) lives in pg_temp and never changes the persistent schema.
 *
 * Usage: node scripts/audit-runtime-ddl.mjs [--json]
 * Exit 1 when any finding is not in ALLOWED below.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SCAN_DIRS = ["server", "shared"];
const SOURCE = /\.(ts|tsx|mjs|js|cjs)$/;
const EXCLUDE = /(\.test\.|\.spec\.|__tests__|\/test-fixtures\/|\.d\.ts$)/;

export const DDL_PATTERN = new RegExp(
  [
    String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?(?:UNLOGGED\s+)?(?:TABLE|INDEX|SEQUENCE|SCHEMA|EXTENSION|TYPE|DOMAIN|VIEW|MATERIALIZED\s+VIEW|POLICY|FUNCTION|PROCEDURE|TRIGGER|CONSTRAINT\s+TRIGGER|EVENT\s+TRIGGER|RULE|ROLE)\b`,
    String.raw`\bALTER\s+(?:TABLE|INDEX|SEQUENCE|SCHEMA|TYPE|DOMAIN|VIEW|POLICY|FUNCTION|PROCEDURE|TRIGGER|EXTENSION|ROLE)\b`,
    String.raw`\bDROP\s+(?:TABLE|INDEX|SEQUENCE|SCHEMA|EXTENSION|TYPE|DOMAIN|VIEW|MATERIALIZED\s+VIEW|POLICY|FUNCTION|PROCEDURE|TRIGGER|RULE|ROLE|CONSTRAINT)\b`,
    String.raw`\bCOMMENT\s+ON\s+(?:TABLE|COLUMN|FUNCTION|INDEX|TRIGGER|POLICY|CONSTRAINT)\b`,
    String.raw`\b(?:ENABLE|DISABLE|FORCE)\s+ROW\s+LEVEL\s+SECURITY\b`,
    String.raw`\b(?:ADD|DROP)\s+COLUMN\b`,
    String.raw`\b(?:ENABLE|DISABLE)\s+(?:ALWAYS\s+|REPLICA\s+)?TRIGGER\b`,
  ].join("|"),
  "i"
);

/**
 * Reviewed exceptions: literal text that matches the pattern but is never sent
 * to PostgreSQL as DDL. Each entry is "file" -> reason. Keep this list short.
 */
export const ALLOWED = new Map([
  [
    "server/lib/codeAgentTools.ts",
    "Developer code-agent tool descriptions/guards that mention SQL keywords; never executed against the database.",
  ],
]);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (name === "node_modules" || name === "public" || name === "dist") continue;
      yield* walk(full);
    } else if (SOURCE.test(name) && !EXCLUDE.test(full)) {
      yield full;
    }
  }
}

/**
 * Extract string/template literal contents with their line numbers, skipping
 * comments. A small tokenizer is enough for this codebase (no JSX in server/).
 */
export function literals(source) {
  const out = [];
  let i = 0;
  let line = 1;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "\n") {
      line += 1;
      i += 1;
    } else if (ch === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i += 1;
    } else if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") line += 1;
        i += 1;
      }
      i += 2;
    } else if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      const startLine = line;
      let text = "";
      i += 1;
      while (i < n && source[i] !== quote) {
        if (source[i] === "\\") {
          text += source[i] + (source[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (quote === "`" && source[i] === "$" && source[i + 1] === "{") {
          // Skip the interpolation expression (balanced braces).
          let depth = 1;
          i += 2;
          text += " ${} ";
          while (i < n && depth > 0) {
            if (source[i] === "{") depth += 1;
            else if (source[i] === "}") depth -= 1;
            else if (source[i] === "\n") line += 1;
            i += 1;
          }
          continue;
        }
        if (source[i] === "\n") {
          line += 1;
          if (quote !== "`") break;
        }
        text += source[i];
        i += 1;
      }
      i += 1;
      out.push({ line: startLine, text });
    } else {
      i += 1;
    }
  }
  return out;
}

export function auditRuntimeDdl(root = ROOT) {
  const findings = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(root, dir))) {
      const relative = path.relative(root, file).split(path.sep).join("/");
      if (ALLOWED.has(relative)) continue;
      const source = readFileSync(file, "utf8");
      for (const literal of literals(source)) {
        const match = DDL_PATTERN.exec(literal.text);
        if (match) findings.push({ file: relative, line: literal.line, statement: match[0].replace(/\s+/g, " ") });
      }
    }
  }
  return findings;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const findings = auditRuntimeDdl();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ findings }, null, 2));
  } else if (findings.length === 0) {
    console.log("Runtime DDL audit: no schema-changing SQL in server/ or shared/ runtime code.");
  } else {
    console.error(`Runtime DDL audit: ${findings.length} schema-changing statement(s) found in runtime code.`);
    console.error("Schema changes belong in migrations/ (see docs/database-migrations.md).");
    for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.statement}`);
  }
  if (findings.length) process.exitCode = 1;
}

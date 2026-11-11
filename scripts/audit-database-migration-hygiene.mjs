#!/usr/bin/env node
/**
 * Read-only migration hygiene report.
 *
 * This intentionally does NOT connect to PostgreSQL, execute SQL or modify files.
 * It inventories migration registration debt and startup schema mutations so that
 * moving DDL into versioned migrations can be planned without touching live data.
 *
 * Run: node scripts/audit-database-migration-hygiene.mjs [--json] [--strict]
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFile(path.join(root, p), "utf8");
const walk = async (dir) => {
  const found = [];
  for (const item of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const relative = path.posix.join(dir, item.name);
    if (item.isDirectory()) found.push(...await walk(relative));
    else found.push(relative);
  }
  return found;
};
const journal = JSON.parse(await read("migrations/meta/_journal.json"));
const migrationFiles = (await readdir(path.join(root, "migrations")))
  .filter((name) => name.endsWith(".sql")).sort();
const tags = new Set(migrationFiles.map((name) => name.slice(0, -4)));
const entries = journal.entries ?? [];
const registered = new Set(entries.map((entry) => entry.tag));
const legacyMissing = new Set([
  "0000_conscious_william_stryker",
  "0001_parallel_guardian",
  "0002_married_loa"
]);
const missingRegisteredSql = entries.filter((entry) => !tags.has(entry.tag)).map((entry) => ({
  tag: entry.tag,
  grandfathered: legacyMissing.has(entry.tag)
}));
const unregisteredSql = migrationFiles.filter((name) => !registered.has(name.slice(0, -4)));

const preloads = (await walk("server")).filter((name) => /(?:Bridge|Preload|Repair|startup)/i.test(name) && /\.(?:mjs|js|ts)$/.test(name));
const pattern = /\b(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|INDEX|UNIQUE\s+INDEX|FUNCTION|TRIGGER|POLICY)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX|FUNCTION|TRIGGER|POLICY)|TRUNCATE\s+|DELETE\s+FROM)\b/gi;
const startupMutationCandidates = [];
for (const file of preloads) {
  const source = await read(file);
  const lines = source.split(/\r?\n/);
  const matches = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Candidates require manual review: comments, strings, and diagnostics can match.
    const tokens = [...line.matchAll(pattern)].map((m) => m[0].toUpperCase());
    if (tokens.length) matches.push({ line: i + 1, operations: [...new Set(tokens)] });
  }
  if (matches.length) startupMutationCandidates.push({ file, matches });
}
const findings = {
  generatedAt: new Date().toISOString(),
  mode: "read-only-static",
  registeredMigrationCount: entries.length,
  migrationSqlFileCount: migrationFiles.length,
  missingRegisteredSql,
  unregisteredSql,
  startupMutationCandidates,
  blockers: [
    ...missingRegisteredSql.filter((v) => !v.grandfathered).map((v) => "Missing registered SQL: " + v.tag),
    ...unregisteredSql.map((v) => "Unregistered SQL: " + v)
  ],
  legacyDebt: missingRegisteredSql.filter((v) => v.grandfathered).map((v) => v.tag),
};
if (process.argv.includes("--json")) {
  process.stdout.write(JSON.stringify(findings, null, 2) + "\n");
} else {
  console.log("Database migration hygiene (read-only)");
  console.log("Registered journal entries:", findings.registeredMigrationCount);
  console.log("SQL files:", findings.migrationSqlFileCount);
  console.log("Missing registered SQL:", missingRegisteredSql.length);
  console.log("Unregistered SQL:", unregisteredSql.length);
  console.log("Startup mutation candidate files:", startupMutationCandidates.length);
  for (const item of missingRegisteredSql) console.log("  MISSING", item.tag, item.grandfathered ? "(legacy)" : "");
  for (const item of unregisteredSql) console.log("  UNREGISTERED", item);
  for (const item of startupMutationCandidates) console.log("  STARTUP", item.file, item.matches.map((m) => m.line).join(","));
  console.log("No database was accessed or modified.");
}
if (process.argv.includes("--strict") &&
    (findings.blockers.length || findings.legacyDebt.length || startupMutationCandidates.length)) {
  process.exitCode = 1;
}

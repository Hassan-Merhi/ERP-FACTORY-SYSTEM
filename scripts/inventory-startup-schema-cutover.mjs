#!/usr/bin/env node
/**
 * Read-only repository inventory for the migration-only schema cutover.
 *
 * Runs without a database, Git credentials, TypeScript compilation, or dev deps.
 * Inventories all requested legacy files AND other likely schema writers.
 * SQL token hits are candidates, not proof of executed startup DDL.
 *
 * node scripts/inventory-startup-schema-cutover.mjs
 * node scripts/inventory-startup-schema-cutover.mjs --json
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isSource = (file) => /\.(?:ts|tsx|js|mjs|cjs|json)$/.test(file);
const walk = async (dir) => {
  const result = [];
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!["node_modules", "dist", "coverage", ".git"].includes(entry.name)) {
        result.push(...await walk(relative));
      }
    } else if (entry.isFile()) result.push(relative);
  }
  return result;
};
const paths = (await Promise.all(
  ["server", "scripts", "tests", "migrations", "shared", "config"].map(async (dir) => {
    try { return await walk(dir); }
    catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  })
)).flat().sort();
for (const file of ["package.json", "drizzle.config.ts", "vitest.config.ts"]) {
  if (!paths.includes(file)) paths.push(file);
}
const cache = new Map();
const source = async (file) => {
  if (!cache.has(file)) cache.set(file, await readFile(path.join(root, file), "utf8"));
  return cache.get(file);
};
const startupFiles = paths.filter((p) => p.startsWith("server/startup-schema/") && p.endsWith(".ts"));
const bridgeFiles = paths.filter((p) => /^server\/[^/]+Bridge\.mjs$/.test(p));
const sqlFiles = paths.filter((p) => p.startsWith("migrations/") && p.endsWith(".sql"));
const schemaPattern = /\b(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|INDEX|UNIQUE\s+INDEX|FUNCTION|TRIGGER|POLICY|VIEW|SCHEMA)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX|FUNCTION|TRIGGER|POLICY|VIEW)|TRUNCATE\s+TABLE|GRANT\s+|REVOKE\s+)\b/gi;
const dataPattern = /\b(?:INSERT\s+INTO|UPDATE\s+[a-z_][\w.]*|DELETE\s+FROM)\b/gi;
const candidate = (file, body) => {
  const lines = body.split(/\r?\n/);
  const ddl = [], data = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // A text audit intentionally retains false positives from comments and SQL
    // templates rather than silently miss dynamically executed migrations.
    if (schemaPattern.test(line)) ddl.push(i + 1);
    schemaPattern.lastIndex = 0;
    if (dataPattern.test(line)) data.push(i + 1);
    dataPattern.lastIndex = 0;
  }
  return { file, ddlLineCandidates: ddl, dataLineCandidates: data };
};
const tracked = [...startupFiles, ...bridgeFiles];
const selected = [];
for (const file of tracked) selected.push(candidate(file, await source(file)));

const otherCandidates = [];
const references = {};
const trackedNames = tracked.map((p) => path.posix.basename(p).replace(/\.(?:ts|mjs)$/, ""));
const referenced = (text, name) => text.includes(name);
for (const file of paths.filter(isSource)) {
  const body = await source(file);
  if (file.startsWith("server/") && !tracked.includes(file)) {
    const result = candidate(file, body);
    if (result.ddlLineCandidates.length && /(?:startup|ensure|schema|repair|migration|preload)/i.test(file)) {
      otherCandidates.push(result);
    }
  }
  const hits = trackedNames.filter((name) => referenced(body, name));
  if (hits.length) references[file] = hits;
}
const index = await source("server/startup-schema/index.ts");
const orderedImports = [...index.matchAll(/from\s+["']\.\/(\d{3}[^"']+)["']/g)]
  .map((match) => "server/startup-schema/" + match[1] + ".ts");
const missingFromIndex = startupFiles.filter((p) => p !== "server/startup-schema/index.ts" && !orderedImports.includes(p));
const nonexistentInIndex = orderedImports.filter((p) => !startupFiles.includes(p));
const report = {
  generatedAt: new Date().toISOString(),
  mode: "read-only-source-inventory",
  counts: {
    startupSchemaFiles: startupFiles.length,
    orderedStartupModules: orderedImports.length,
    bridges: bridgeFiles.length,
    migrationSqlFiles: sqlFiles.length,
    otherStartupWriterCandidates: otherCandidates.length,
  },
  orderedImports,
  missingFromIndex,
  nonexistentInIndex,
  bridgeFiles,
  requestedFiles: selected,
  otherCandidates,
  references,
  notes: [
    "SQL token occurrences are only candidates; manual review must inspect runtime paths and imported SQL.",
    "Runtime-only bridges must have their behavior preserved if renamed or deleted.",
    "This audit does not prove a schema baseline or a read-only boot; those need PostgreSQL tests.",
  ],
};
if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
else {
  console.log("Migration-only cutover source inventory (read-only)");
  console.log(JSON.stringify(report.counts, null, 2));
  console.log("Missing startup index imports:", missingFromIndex);
  console.log("Broken startup index imports:", nonexistentInIndex);
  console.log("Bridge classifications: docs/database-migration-only-phase1-inventory.md");
  console.log("Next: inspect --json for call sites, SQL candidates, and references.");
}
if (missingFromIndex.length || nonexistentInIndex.length) process.exitCode = 1;

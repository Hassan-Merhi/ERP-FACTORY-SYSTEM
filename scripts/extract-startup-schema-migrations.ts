#!/usr/bin/env node
/**
 * Phase 3: extract the exact 43 ordered startup-schema modules into numbered,
 * review-only SQL and a checksum manifest.
 *
 * Run: npx tsx scripts/extract-startup-schema-migrations.ts --out /tmp/erp-startup-sql
 * This process MUST NOT connect to PostgreSQL, replace controlled migrations,
 * or automatically execute archive/DML repairs.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import process from "node:process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaDir = path.join(root, "server/startup-schema");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--out" || !args[1]) {
  throw new Error("Usage: npx tsx scripts/extract-startup-schema-migrations.ts --out /tmp/erp-startup-sql");
}
const outDir = path.resolve(args[1]);
if (outDir.startsWith(path.join(root, "migrations", "controlled")) ||
    outDir === path.join(root, "migrations", "controlled")) {
  throw new Error("Refusing to write directly to executable controlled migration directory");
}
const index = await readFile(path.join(schemaDir, "index.ts"), "utf8");
const importPaths = new Map<string, string>();
for (const found of index.matchAll(/^import\s+\{\s*(\w+)\s*\}\s+from\s+"(\.\/[^"]+)";/gm)) {
  if (importPaths.has(found[1])) throw new Error("Duplicate imported migration symbol: " + found[1]);
  importPaths.set(found[1], found[2]);
}
const block = index.match(/export const startupMigrations: string\[\] = \[([\s\S]*?)\n\];/);
if (!block) throw new Error("Startup migration registry changed; inspect manually");
const orderedNames = [...block[1].matchAll(/^\s*\.\.\.(\w+),/gm)].map((m) => m[1]);
if (orderedNames.length !== 43 || importPaths.size !== 43 ||
    new Set(orderedNames).size !== 43) {
  throw new Error("Expected exactly 43 distinct startup-schema modules; found " + orderedNames.length);
}
const safeName = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_");
const digest = (input: string) => createHash("sha256").update(input).digest("hex");
const extracted: string[] = [];
const manifest: any = {
  schema: "erp-startup-schema-extraction-v1",
  status: "REVIEW_ONLY_NOT_REGISTERED",
  prerequisite: "Verified clean-install core schema baseline and upgrade adoption",
  databaseAccess: false,
  noAutomaticDmlExecution: true,
  modules: [],
};
await mkdir(outDir, { recursive: true });
for (const [indexInOrder, name] of orderedNames.entries()) {
  const relative = importPaths.get(name);
  if (!relative) throw new Error("Unresolved startup import: " + name);
  const filePath = path.resolve(schemaDir, relative + ".ts");
  if (!filePath.startsWith(schemaDir + path.sep)) throw new Error("Unsafe startup import path: " + relative);
  const imported = await import(pathToFileURL(filePath).href);
  const statements: unknown = imported[name];
  if (!Array.isArray(statements) || statements.some((s) => typeof s !== "string")) {
    throw new Error("Module does not export a static string[]: " + relative);
  }
  const entries = statements.map((s: string, idx: number) => {
    const sql = s.trim();
    if (!sql) throw new Error("Empty SQL statement " + name + ":" + idx);
    if (/^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\s*;?\s*$/im.test(sql) ||
        /\b(?:CREATE|DROP)\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i.test(sql)) {
      throw new Error("Transaction-unsafe statement in " + name + ":" + idx);
    }
    // Review all DML anywhere, including inside DO blocks; this is intentionally
    // conservative and will produce false positives to inspect.
    const containsDml = /\b(?:INSERT\s+INTO|UPDATE\s+[a-z_"]|DELETE\s+FROM|TRUNCATE\s+|MERGE\s+INTO)\b/i.test(sql);
    const mayDropObject = /\bDROP\s+(?:TABLE|COLUMN|INDEX|CONSTRAINT|TRIGGER|FUNCTION|SCHEMA|SEQUENCE)\b/i.test(sql);
    return { sql, containsDml, mayDropObject };
  });
  const ordinal = String(indexInOrder + 1).padStart(3, "0");
  const base = ordinal + "_" + safeName(path.basename(relative).toLowerCase());
  const statementsSql = entries.map(({sql}, idx) =>
    "-- statement " + String(idx + 1).padStart(4, "0") + " of " + entries.length +
    "\n" + sql.replace(/;\s*$/, "") + ";"
  ).join("\n\n") + "\n";
  const fileName = base + ".sql";
  const content = "-- REVIEW ONLY — NEVER APPLY AUTOMATICALLY TO EXISTING ERP DATA.\n" +
    "-- Startup module: " + relative + ".ts\n" +
    "-- Source variable: " + name + "\n" +
    "-- Original execution position: " + ordinal + " / 043\n" +
    "-- Contains data-changing statements: " + entries.some((v) => v.containsDml) + "\n" +
    "-- Contains destructive schema statements: " + entries.some((v) => v.mayDropObject) + "\n\n" +
    statementsSql;
  const sha256 = digest(content);
  await writeFile(path.join(outDir, fileName), content);
  const meta = {
    ordinal: indexInOrder + 1, module: relative + ".ts", exportName: name,
    fileName, statementCount: entries.length, sha256,
    dataReviewStatementNumbers: entries.flatMap((v, i) => v.containsDml ? [i + 1] : []),
    destructiveReviewStatementNumbers: entries.flatMap((v, i) => v.mayDropObject ? [i + 1] : []),
  };
  manifest.modules.push(meta);
  extracted.push(...statements);
}
const assembled = (await import(pathToFileURL(path.join(schemaDir, "index.ts")).href)).startupMigrations;
if (JSON.stringify(extracted) !== JSON.stringify(assembled)) {
  throw new Error("Ordered extraction differs from live startup migration array; refusing output");
}
manifest.totalStatements = extracted.length;
manifest.originalStartupArraySha256 = digest(JSON.stringify(assembled));
manifest.extractedOrderHash = digest(orderedNames.join("\n"));
manifest.requiresManualDmlReview = manifest.modules
  .filter((m: any) => m.dataReviewStatementNumbers.length).map((m: any) => m.fileName);
manifest.requiresDestructiveDdlReview = manifest.modules
  .filter((m: any) => m.destructiveReviewStatementNumbers.length).map((m: any) => m.fileName);
await writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({
  output: outDir, modules: manifest.modules.length, statements: manifest.totalStatements,
  exactSourceOrderVerified: true,
  dmlReviewModules: manifest.requiresManualDmlReview.length,
  destructiveReviewModules: manifest.requiresDestructiveDdlReview.length,
  status: manifest.status,
}, null, 2));

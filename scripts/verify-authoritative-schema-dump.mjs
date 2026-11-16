#!/usr/bin/env node
/**
 * Phase 2: conservative, read-only validation of a schema-only pg_dump.
 * The baseline is NOT generated automatically: an owner must review the source
 * schema and authorize a separately numbered migration before it is applied.
 *
 * node scripts/verify-authoritative-schema-dump.mjs --input /safe/path/schema.sql
 * node scripts/verify-authoritative-schema-dump.mjs --input /safe/path/schema.sql --json
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";

const argv = process.argv.slice(2);
const inputIndex = argv.indexOf("--input");
const json = argv.includes("--json");
const options = argv.filter((arg) => arg.startsWith("--") && !["--input", "--json"].includes(arg));
if (options.length || inputIndex === -1 || !argv[inputIndex + 1] ||
    argv.filter((arg) => arg === "--input").length !== 1) {
  console.error("Usage: node scripts/verify-authoritative-schema-dump.mjs --input schema.sql [--json]");
  process.exit(2);
}
const source = await readFile(argv[inputIndex + 1], "utf8");
const sha256 = createHash("sha256").update(source).digest("hex");
const errors = [];
const warnings = [];
const header = source.slice(0, 2000);
if (!/^--\s*PostgreSQL database dump/im.test(header)) {
  errors.push("Source lacks the PostgreSQL pg_dump header; a hand-built SQL file is not an authoritative dump.");
}
if (!/^--\s*Dumped from database version\s+\S+/im.test(header)) {
  errors.push("Missing pg_dump source PostgreSQL version.");
}
if (!/^--\s*Dumped by pg_dump version\s+\S+/im.test(header)) {
  errors.push("Missing pg_dump tool version.");
}
if (!/^--\s*PostgreSQL database dump complete/im.test(source.slice(-3000))) {
  errors.push("Missing completed pg_dump footer; dump may be truncated.");
}
if (/^\s*(?:COPY\s+[^;]+FROM\s+stdin|INSERT\s+INTO\s+|DELETE\s+FROM\s+|UPDATE\s+|TRUNCATE\s+)/im.test(source)) {
  errors.push("Data-modification SQL found; require schema-only pg_dump, not a data or hybrid dump.");
}
if (/^\s*SELECT\s+pg_catalog\.setval\s*\(/im.test(source)) {
  errors.push("Sequence values found; schema-only dump must not include production sequence state.");
}
if (/^\s*\\(?:connect|copy|i|include|o|output|!)/im.test(source)) {
  errors.push("Dangerous or context-changing psql meta-commands found.");
}
if (/^\s*(?:CREATE\s+DATABASE|DROP\s+DATABASE|ALTER\s+SYSTEM|CREATE\s+ROLE|CREATE\s+USER|DROP\s+ROLE|DROP\s+USER)\b/im.test(source)) {
  errors.push("Cluster-level or database provisioning commands found; expected a schema-only database-local dump.");
}
const requiredTables = [
  "companies", "users", "vouchers", "voucher_entries", "stock_items", "locations",
];
const required = {};
for (const table of requiredTables) {
  const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp("(^|\\n)\\s*CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:(?:public\\.)?\\\"?" + escaped + "\\\"?)\\s*\\(", "i");
  required[table] = pattern.test(source);
  if (!required[table]) errors.push("Missing core table CREATE TABLE: " + table);
}
const tableNames = [...source.matchAll(/^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"?public"?\.)?)("?[-a-zA-Z_0-9]+"?)\s*\(/gim)]
  .map((match) => match[1].replaceAll('"', "").toLowerCase());
const duplicateTables = tableNames.filter((name, index) => tableNames.indexOf(name) !== index);
if (duplicateTables.length) errors.push("Duplicate CREATE TABLE definitions: " + [...new Set(duplicateTables)].join(", "));
const rlsPolicies = [...source.matchAll(/^\s*CREATE\s+POLICY\s+/gim)].length;
const triggers = [...source.matchAll(/^\s*CREATE\s+TRIGGER\s+/gim)].length;
if (tableNames.length < 100) warnings.push("Fewer than 100 tables; compare source against the authoritative deployed database.");
if (rlsPolicies === 0) warnings.push("No CREATE POLICY statements detected; independently verify tenant RLS coverage.");
if (triggers === 0) warnings.push("No CREATE TRIGGER statements detected; verify financial and audit trigger coverage.");
if (/^\s*\\(?:restrict|unrestrict)\b/im.test(source)) {
  warnings.push("pg_dump includes psql-only \\restrict markers; raw dump cannot be passed directly to pg.Client.query.");
}
const report = {
  kind: "schema-only-pg-dump-preflight",
  checksPassed: errors.length === 0,
  certification: false,
  sourceSha256: sha256,
  bytes: Buffer.byteLength(source),
  tables: tableNames.length,
  policies: rlsPolicies,
  triggers,
  requiredCoreTables: required,
  errors,
  warnings,
  nextSteps: [
    "Confirm dump provenance from the authorized production-like database and retain its hash.",
    "Compare catalog, extensions, RLS, grants, indexes, functions, triggers and schema history.",
    "Sanitize and translate pg_dump for the transactional migration runner; never replay pg_dump psql commands as-is.",
    "Rehearse on an isolated empty PostgreSQL instance and a separately restored upgrade snapshot.",
    "Only then commit an immutable numbered baseline with explicit fresh-install and upgrade adoption paths.",
  ],
};
if (json) console.log(JSON.stringify(report, null, 2));
else {
  console.log("Authoritative schema dump preflight:", report.checksPassed ? "passed (NOT certified)" : "FAILED");
  console.log("SHA-256:", report.sourceSha256);
  console.log("Tables:", report.tables, "Policies:", report.policies, "Triggers:", report.triggers);
  for (const error of errors) console.error("ERROR:", error);
  for (const warning of warnings) console.warn("WARN:", warning);
  console.log("No SQL was executed. No migration files were written.");
}
if (errors.length) process.exitCode = 1;

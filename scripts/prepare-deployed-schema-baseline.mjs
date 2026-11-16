#!/usr/bin/env node
/**
 * Converts an authorized, schema-only PostgreSQL plain-format pg_dump into a
 * reference migration candidate. This NEVER connects to a database and does
 * not register a production migration or modify the controlled runner.
 *
 * node scripts/prepare-deployed-schema-baseline.mjs --input /path/HMD_SCHEMA.sql --variant hmd --out /tmp/baselines
 *
 * Run once per deployment (hmd / factory_copy). Never concatenate variants.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
function flag(key) {
  const at = args.indexOf("--" + key);
  if (at < 0 || at + 1 >= args.length) throw Error("Missing --" + key);
  return args[at + 1];
}
const sha = (value) => createHash("sha256").update(value).digest("hex");
try {
  const input = resolve(flag("input"));
  const variant = flag("variant");
  const outputRoot = resolve(flag("out"));
  if (!["hmd", "factory_copy"].includes(variant)) throw Error("variant must be hmd or factory_copy");
  const dump = await readFile(input, "utf8");
  if (!/^--\s*PostgreSQL database dump/m.test(dump.slice(0, 500))) {
    throw Error("Not an original pg_dump text export");
  }
  if (!/^--\s*Dumped from database version\s+\S+/m.test(dump.slice(0, 1500))) {
    throw Error("Missing source PostgreSQL version");
  }
  if (!/^--\s*Dumped by pg_dump version\s+\S+/m.test(dump.slice(0, 1500))) {
    throw Error("Missing pg_dump version");
  }
  if (!/-- PostgreSQL database dump complete/.test(dump.slice(-3000))) {
    throw Error("Incomplete pg_dump export");
  }
  if (/^\s*(?:COPY\s+\S+.*FROM\s+stdin|INSERT\s+INTO\s+|UPDATE\s+|DELETE\s+FROM\s+|TRUNCATE\s+|SELECT\s+pg_catalog\.setval\s*\()/im.test(dump)) {
    throw Error("Unsafe: dump includes data manipulation or sequence-state restoration");
  }
  const commands = [...dump.matchAll(/^\\(\w+)(?:[ \t]+([^\r\n]+))?/gm)];
  if (commands.some((c) => !["restrict", "unrestrict"].includes(c[1]))) {
    throw Error("Unexpected psql meta-command; manual review required");
  }
  if (commands.length !== 2 || commands[0][1] !== "restrict" ||
      commands[1][1] !== "unrestrict" || commands[0][2] !== commands[1][2]) {
    throw Error("Invalid or mismatched pg_dump restrict markers");
  }
  const cleaned = dump.replace(/^\\(?:restrict|unrestrict)[^\r\n]*\r?\n/gm, "");
  const objects = {
    tables: [...cleaned.matchAll(/^CREATE TABLE ([^ (\r\n]+) \(/gm)].map((m) => m[1]),
    functions: [...cleaned.matchAll(/^CREATE FUNCTION /gm)].length,
    indexes: [...cleaned.matchAll(/^CREATE (?:UNIQUE )?INDEX /gm)].length,
    triggers: [...cleaned.matchAll(/^CREATE TRIGGER /gm)].length,
    policies: [...cleaned.matchAll(/^CREATE POLICY /gm)].length,
  };
  const requiredTables = ["companies", "users", "vouchers", "voucher_entries", "stock_items", "locations"];
  for (const table of requiredTables) {
    if (!objects.tables.includes("public." + table)) throw Error("Core table missing: " + table);
  }
  const migration = [
    "-- REFERENCE BASELINE — NEVER RUN AGAINST A POPULATED/EXISTING DATABASE.",
    "-- This file has not been installed or tested on fresh PostgreSQL by this preparation script.",
    "-- Source SHA-256: " + sha(dump),
    "",
    cleaned,
  ].join("\n");
  const dir = join(outputRoot, variant);
  await mkdir(dir, { recursive: true });
  const filename = join(dir, "0001_deployed_schema_snapshot.sql");
  await writeFile(filename, migration);
  const report = {
    variant, sourceSha256: sha(dump), migrationSha256: sha(migration),
    sourceBytes: Buffer.byteLength(dump), migrationBytes: Buffer.byteLength(migration),
    tableCountAllSchemas: objects.tables.length,
    tableCountPublic: objects.tables.filter((name) => name.startsWith("public.")).length,
    functions: objects.functions, indexes: objects.indexes,
    triggers: objects.triggers, policies: objects.policies,
    registration: "UNREGISTERED_REFERENCE_ONLY",
    freshPostgresTest: "NOT_RUN",
    productionChanges: false,
  };
  await writeFile(join(dir, "manifest.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error("Baseline preparation refused:", error.message);
  process.exitCode = 1;
}

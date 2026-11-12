#!/usr/bin/env node
/**
 * Controlled forward migration runner (v2).
 *
 * Opt-in only. Never invoked by app startup or Render build.
 * New migrations live ONLY in migrations/controlled; older migration systems
 * retain their histories until a separately approved reconciliation/cutover.
 *
 * Usage:
 *   node scripts/run-controlled-migrations.mjs --plan
 *   MIGRATION_CONFIRMATION=APPLY_CONTROLLED_MIGRATIONS \
 *     node scripts/run-controlled-migrations.mjs --apply
 *
 * --plan does not connect to PostgreSQL. --status connects READ ONLY and
 * does not create the history table. --apply requires explicit confirmation.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import pg from "pg";
import { resolveDatabaseSsl } from "../server/lib/databaseSsl.mjs";

const DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations/controlled");
const HISTORY = "erp_controlled_migration_history";
const LOCK_KEY = 748392106;
const APPROVAL = "APPLY_CONTROLLED_MIGRATIONS";
const filePattern = /^\d{8}_\d{3}_[a-z0-9_-]+\.sql$/;
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const connectionString = process.env.DATABASE_URL;
const args = new Set(process.argv.slice(2));
const modes = ["--plan", "--status", "--apply"].filter((mode) => args.has(mode));
const fail = (message) => { throw new Error(message); };

async function loadManifest() {
  const names = (await readdir(DIRECTORY)).filter((x) => x.endsWith(".sql")).sort();
  const invalid = names.filter((name) => !filePattern.test(name));
  if (invalid.length) fail("Invalid controlled migration filenames: " + invalid.join(", "));
  const result = [];
  for (const name of names) {
    const sql = await readFile(path.join(DIRECTORY, name), "utf8");
    if (!sql.trim()) fail("Empty controlled migration: " + name);
    if (/\b(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\s*;/i.test(sql)) {
      fail("Managed migration transactions must not contain transaction control SQL: " + name);
    }
    if (/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b|\bDROP\s+INDEX\s+CONCURRENTLY\b/i.test(sql)) {
      fail("CONCURRENTLY requires a separately reviewed nontransactional release: " + name);
    }
    result.push({ name, checksum: sha256(sql), sql });
  }
  return result;
}

function reconcile(manifest, appliedRows) {
  const expected = new Map(manifest.map((m) => [m.name, m]));
  const applied = new Map();
  for (const row of appliedRows) {
    if (applied.has(row.migration_name)) fail("Duplicate applied migration: " + row.migration_name);
    if (!expected.has(row.migration_name)) fail("Unknown applied migration: " + row.migration_name);
    if (expected.get(row.migration_name).checksum !== row.checksum) {
      fail("Migration checksum mismatch: " + row.migration_name);
    }
    applied.set(row.migration_name, row.checksum);
  }
  const pending = manifest.filter((m) => !applied.has(m.name));
  // Once any later migration is recorded, no earlier migration may appear
  // pending. Repair history under human review rather than guessing.
  const firstPending = manifest.findIndex((m) => !applied.has(m.name));
  if (firstPending >= 0 && manifest.slice(firstPending).some((m) => applied.has(m.name))) {
    fail("Non-prefix migration history; refusing out-of-order replay");
  }
  return pending;
}

async function main() {
  if (modes.length !== 1 || args.size !== 1) fail("Select exactly one of --plan, --status, --apply");
  const manifest = await loadManifest();
  if (args.has("--plan")) {
    console.log(JSON.stringify({ mode: "plan", databaseAccess: false,
      migrations: manifest.map(({name,checksum})=>({name,checksum})) }, null, 2));
    return;
  }
  if (!connectionString) fail("DATABASE_URL is required");
  if (args.has("--apply") && process.env.MIGRATION_CONFIRMATION !== APPROVAL) {
    fail("Apply denied: set MIGRATION_CONFIRMATION=" + APPROVAL + " for this command");
  }
  const client = new pg.Client({
    connectionString,
    ssl: resolveDatabaseSsl(connectionString),
    connectionTimeoutMillis: 15000
  });
  let locked = false;
  try {
    await client.connect();
    await client.query("SET lock_timeout = '10s'");
    await client.query("SET statement_timeout = '120s'");
    if (args.has("--apply")) {
      const lock = await client.query("SELECT pg_try_advisory_lock($1) AS acquired", [LOCK_KEY]);
      locked = lock.rows[0]?.acquired === true;
      if (!locked) fail("Another controlled migration runner holds the lock");
    }
    // --status intentionally never creates or modifies any DB object.
    const exists = await client.query("SELECT to_regclass($1) IS NOT NULL AS present", ["public." + HISTORY]);
    const rows = exists.rows[0]?.present
      ? (await client.query("SELECT migration_name, checksum FROM " + HISTORY + " ORDER BY migration_name")).rows
      : [];
    // Do this check before any schema writes, including history table creation.
    const pending = reconcile(manifest, rows);
    if (!args.has("--apply")) {
      console.log(JSON.stringify({ mode: "status", historyExists: !!exists.rows[0]?.present,
        applied: rows.length, pending: pending.map(({name,checksum})=>({name,checksum})) }, null, 2));
      return;
    }
    if (!pending.length) {
      console.log("Controlled migrations: already up to date; no database writes.");
      return;
    }
    // History creation is the first allowed write and happens only after full reconciliation.
    await client.query(`CREATE TABLE IF NOT EXISTS ${HISTORY} (
      migration_name TEXT PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      execution_ms INTEGER NOT NULL,
      app_version TEXT,
      applied_by TEXT NOT NULL DEFAULT current_user
    )`);
    for (const migration of pending) {
      const began = Date.now();
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL lock_timeout = '10s'");
        await client.query("SET LOCAL statement_timeout = '120s'");
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO " + HISTORY + " (migration_name,checksum,execution_ms,app_version) VALUES ($1,$2,$3,$4)",
          [migration.name,migration.checksum,Date.now()-began,process.env.APP_VERSION??null]
        );
        await client.query("COMMIT");
        console.log("Applied: " + migration.name);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error("Failed migration " + migration.name + ": " + (error instanceof Error ? error.message : String(error)));
      }
    }
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    await client.end().catch(() => {});
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

/**
 * The numbered migration registry: the single authoritative definition of the
 * database schema.
 *
 * Files: migrations/NNNN_snake_case_name.sql, applied in numeric order. Each file
 * is immutable once applied anywhere; its SHA-256 is recorded in
 * public.schema_migrations and re-checked by the runner and at server startup.
 *
 * Shared by scripts/db/migrate.mjs (plan/status/apply/adopt/verify) and the
 * read-only startup gate (server/schema/startupSchemaGate.mjs). Nothing in this
 * module writes to a database.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MIGRATION_HISTORY_TABLE } from "./schemaCatalog.mjs";

export { MIGRATION_HISTORY_TABLE };

/** Repository-relative migrations directory (works from server/ and dist/ alike). */
export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

/** Expected-schema manifests generated from a fresh install (see migrate.mjs manifest). */
export const MANIFEST_DIR = path.join(MIGRATIONS_DIR, "manifest");
export const BASELINE_MIGRATION = "0001_baseline_schema";
export const BASELINE_MANIFEST = path.join(MANIFEST_DIR, `${BASELINE_MIGRATION}.tsv`);
export const SCHEMA_MANIFEST = path.join(MANIFEST_DIR, "schema.tsv");

export const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

/** A migration that must run outside a transaction declares this on line 1. */
export const NO_TRANSACTION_DIRECTIVE = "-- migrate:no-transaction";

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/**
 * Load and validate every migration file.
 * @param {string} [directory]
 * @returns {Array<{ id: string, number: number, file: string, sql: string, checksum: string, transactional: boolean }>}
 */
export function loadMigrations(directory = MIGRATIONS_DIR) {
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
  const invalid = files.filter((file) => !MIGRATION_FILE_PATTERN.test(file));
  if (invalid.length) {
    throw new Error(`Invalid migration file name(s): ${invalid.join(", ")} (expected NNNN_snake_case.sql)`);
  }
  const migrations = files.map((file) => {
    const [, digits] = MIGRATION_FILE_PATTERN.exec(file);
    const sql = readFileSync(path.join(directory, file), "utf8");
    if (!sql.trim()) throw new Error(`Empty migration: ${file}`);
    const transactional = !sql.startsWith(NO_TRANSACTION_DIRECTIVE);
    if (transactional && /^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\s*;/im.test(sql)) {
      throw new Error(`${file}: transaction control is managed by the runner; remove BEGIN/COMMIT`);
    }
    if (transactional && /\bCONCURRENTLY\b/i.test(stripSqlComments(sql))) {
      throw new Error(`${file}: CONCURRENTLY cannot run in a transaction; mark the file ${NO_TRANSACTION_DIRECTIVE}`);
    }
    return { id: file.slice(0, -4), number: Number(digits), file, sql, checksum: sha256(sql), transactional };
  });
  migrations.forEach((migration, index) => {
    if (migration.number !== index + 1) {
      throw new Error(
        `Migration numbering must be contiguous from 0001: expected ${String(index + 1).padStart(4, "0")}, found ${migration.file}`
      );
    }
  });
  return migrations;
}

function stripSqlComments(sql) {
  return sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Reconcile recorded history with the files. Fail closed on anything that is
 * not an exact prefix of the registry with matching checksums.
 *
 * @param {ReturnType<typeof loadMigrations>} migrations
 * @param {Array<{ id: string, checksum: string }>} appliedRows rows from schema_migrations
 * @returns {{ applied: typeof migrations, pending: typeof migrations }}
 */
export function reconcileHistory(migrations, appliedRows) {
  const byId = new Map(migrations.map((m) => [m.id, m]));
  const seen = new Set();
  for (const row of appliedRows) {
    if (seen.has(row.id)) throw new Error(`Duplicate migration history row: ${row.id}`);
    seen.add(row.id);
    const migration = byId.get(row.id);
    if (!migration) {
      throw new Error(
        `Database records migration ${row.id}, which does not exist in this release. ` +
          "Refusing to run older code against a newer schema."
      );
    }
    if (migration.checksum !== row.checksum) {
      throw new Error(
        `Checksum mismatch for applied migration ${row.id}: recorded ${row.checksum}, file ${migration.checksum}. ` +
          "Applied migrations are immutable; restore the original file and add a new migration instead."
      );
    }
  }
  const firstPending = migrations.findIndex((m) => !seen.has(m.id));
  if (firstPending >= 0 && migrations.slice(firstPending).some((m) => seen.has(m.id))) {
    const gap = migrations.slice(firstPending).filter((m) => !seen.has(m.id) && migrations.slice(migrations.indexOf(m)).some((later) => seen.has(later.id)));
    throw new Error(`Out-of-order migration history: ${gap.map((m) => m.id).join(", ")} not applied but later migrations are`);
  }
  return {
    applied: migrations.filter((m) => seen.has(m.id)),
    pending: migrations.filter((m) => !seen.has(m.id)),
  };
}

/** Read the expected-schema manifest lines. */
export function readManifest(file = SCHEMA_MANIFEST) {
  if (!existsSync(file)) throw new Error(`Schema manifest not found: ${path.relative(process.cwd(), file)}`);
  return readFileSync(file, "utf8").split("\n");
}

/**
 * Read applied history without creating anything.
 * @param {{ query: Function }} client
 * @returns {Promise<{ exists: boolean, rows: Array<{ id: string, checksum: string, mode: string }> }>}
 */
export async function readHistory(client) {
  const exists = await client.query("SELECT to_regclass($1) IS NOT NULL AS present", [`public.${MIGRATION_HISTORY_TABLE}`]);
  if (!exists.rows[0]?.present) return { exists: false, rows: [] };
  const { rows } = await client.query(
    `SELECT id, checksum, mode FROM public.${MIGRATION_HISTORY_TABLE} ORDER BY id`
  );
  return { exists: true, rows };
}

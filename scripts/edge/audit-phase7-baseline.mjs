#!/usr/bin/env node
/**
 * Phase 7: privacy-preserving fingerprints of two DISPOSABLE, QUIESCED database
 * clones and their uploads, then strict equality comparison.
 * No live cloud/edge DB, no restore, no authorization, and no raw data export.
 * A matching report is NOT source provenance or operator approval.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, open } from "node:fs/promises";
import { resolve, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const PHASE7_BASELINE_PROTOCOL = "erp-factory/phase7-readonly-fingerprint/v1";
const SHA = /^[0-9a-f]{64}$/;
const safeInt = (x) => Number.isSafeInteger(x) && x >= 0;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const hashUpdate = (hash, value) => hash.update(Buffer.from(String(value.length) + ":" + value, "utf8"));
const quoteIdent = (value) => '"' + value.replaceAll('"', '""') + '"';

function checkReport(report, scope) {
  if (!report || report.protocol !== PHASE7_BASELINE_PROTOCOL || report.scope !== scope ||
      !SHA.test(report.snapshotSha256 ?? "") || !SHA.test(report.schemaSha256 ?? "") ||
      !Array.isArray(report.tables) || report.tables.length === 0 ||
      !Array.isArray(report.sequences) || !report.uploads ||
      !safeInt(report.uploads.files) || !safeInt(report.uploads.bytes) ||
      !SHA.test(report.uploads.sha256 ?? "")) {
    throw new Error("PHASE7_BASELINE_REPORT_INVALID");
  }
  for (const entry of report.tables) {
    if (!entry || typeof entry.name !== "string" || !entry.name ||
        !safeInt(entry.rows) || !SHA.test(entry.sha256 ?? "")) {
      throw new Error("PHASE7_BASELINE_TABLE_INVALID");
    }
  }
  for (const entry of report.sequences) {
    if (!entry || typeof entry.name !== "string" || !entry.name ||
        typeof entry.lastValue !== "string" || typeof entry.isCalled !== "boolean") {
      throw new Error("PHASE7_BASELINE_SEQUENCE_INVALID");
    }
  }
  for (const array of [report.tables, report.sequences]) {
    const names = array.map((value) => value.name);
    if (new Set(names).size !== names.length || names.some((name, i) => i && name <= names[i - 1])) {
      throw new Error("PHASE7_BASELINE_ORDER_INVALID");
    }
  }
  return {
    protocol: report.protocol,
    snapshotSha256: report.snapshotSha256,
    schemaSha256: report.schemaSha256,
    tables: report.tables,
    sequences: report.sequences,
    uploads: report.uploads,
  };
}

export function comparePhase7Baselines(source, restored) {
  const a = checkReport(source, "source");
  const b = checkReport(restored, "restore");
  if (a.snapshotSha256 !== b.snapshotSha256) throw new Error("PHASE7_BASELINE_SNAPSHOT_MISMATCH");
  if (a.schemaSha256 !== b.schemaSha256) throw new Error("PHASE7_BASELINE_SCHEMA_MISMATCH");
  if (JSON.stringify(a.tables) !== JSON.stringify(b.tables)) throw new Error("PHASE7_BASELINE_TABLES_MISMATCH");
  if (JSON.stringify(a.sequences) !== JSON.stringify(b.sequences)) throw new Error("PHASE7_BASELINE_SEQUENCES_MISMATCH");
  if (JSON.stringify(a.uploads) !== JSON.stringify(b.uploads)) throw new Error("PHASE7_BASELINE_UPLOADS_MISMATCH");
  return { tables: a.tables.length, sequences: a.sequences.length, uploads: a.uploads.files };
}

async function uploadFingerprint(root) {
  const abs = resolve(root);
  const rootStat = await lstat(abs);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("PHASE7_UPLOAD_ROOT_INVALID");
  const files = [];
  async function walk(dir) {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error("PHASE7_UPLOAD_SYMLINK_FORBIDDEN");
      if (stat.isDirectory()) await walk(path);
      else if (stat.isFile()) files.push({ path, stat });
      else throw new Error("PHASE7_UPLOAD_SPECIAL_FILE_FORBIDDEN");
    }
  }
  await walk(abs);
  const aggregate = createHash("sha256");
  let bytes = 0;
  for (const file of files) {
    const name = relative(abs, file.path).split(sep).join("/");
    const fileHash = createHash("sha256");
    for await (const chunk of createReadStream(file.path)) fileHash.update(chunk);
    const after = await lstat(file.path);
    if (after.size !== file.stat.size || after.mtimeMs !== file.stat.mtimeMs ||
        after.ino !== file.stat.ino) throw new Error("PHASE7_UPLOAD_CHANGED_DURING_AUDIT");
    hashUpdate(aggregate, name);
    hashUpdate(aggregate, String(file.stat.size));
    hashUpdate(aggregate, fileHash.digest("hex"));
    bytes += file.stat.size;
    if (!safeInt(bytes)) throw new Error("PHASE7_UPLOAD_TOO_LARGE");
  }
  return { files: files.length, bytes, sha256: aggregate.digest("hex") };
}

async function captureClone({ connectionString, scope, uploadsDir, snapshotSha256 }) {
  if (scope !== "source" && scope !== "restore") throw new Error("PHASE7_BASELINE_SCOPE_INVALID");
  if (!SHA.test(snapshotSha256 ?? "")) throw new Error("PHASE7_BASELINE_SNAPSHOT_DIGEST_REQUIRED");
  if (!connectionString) throw new Error("PHASE7_BASELINE_DATABASE_REQUIRED");

  // Never accidentally read or write the production cloud or active LAN DB.
  const { Client } = await import("pg");
  const client = new Client({ connectionString, connectionTimeoutMillis: 8000 });
  await client.connect();
  try {
    const identity = await client.query("SELECT current_database() AS db, pg_is_in_recovery() AS recovering");
    if (!/^erp_(?:phase7|edge)_rehearsal_[a-z0-9_]+$/.test(identity.rows[0]?.db ?? "")) {
      throw new Error("PHASE7_BASELINE_DISPOSABLE_DATABASE_REQUIRED");
    }
    // An ordinary tenant-scoped app user may silently see only one company.
    // This privileged audit is ONLY safe because the database name and operator
    // controls require a stopped, disposable clone, never the live factory DB.
    const role = await client.query(
      "SELECT rolsuper OR rolbypassrls AS complete FROM pg_roles WHERE rolname=current_user"
    );
    if (role.rows[0]?.complete !== true) throw new Error("PHASE7_BASELINE_FULL_SCOPE_ROLE_REQUIRED");
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      await client.query("SET LOCAL statement_timeout = '300s'");
      const schemaRows = await client.query(
        "SELECT n.nspname, c.relname, a.attnum, a.attname, format_type(a.atttypid,a.atttypmod) AS data_type, " +
        "a.attnotnull, pg_get_expr(d.adbin,d.adrelid) AS default_expr " +
        "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace " +
        "JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped " +
        "LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum " +
        "WHERE n.nspname='public' AND c.relkind IN ('r','p') " +
        "ORDER BY n.nspname,c.relname,a.attnum"
      );
      const indexes = await client.query(
        "SELECT schemaname, tablename, indexname, indexdef FROM pg_indexes " +
        "WHERE schemaname='public' ORDER BY schemaname,tablename,indexname"
      );
      const constraints = await client.query(
        "SELECT c.conrelid::regclass::text AS relname, c.conname, pg_get_constraintdef(c.oid) AS definition " +
        "FROM pg_constraint c WHERE c.connamespace='public'::regnamespace " +
        "ORDER BY 1,2"
      );
      const schemaSha256 = digest(JSON.stringify([schemaRows.rows, indexes.rows, constraints.rows]));
      const objects = await client.query(
        "SELECT n.nspname AS schema_name, c.relname AS object_name, c.relkind " +
        "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace " +
        "WHERE n.nspname='public' AND (c.relkind='S' OR (c.relkind IN ('r','p') AND NOT c.relispartition)) " +
        "AND c.relname NOT IN ('session') ORDER BY n.nspname,c.relname"
      );
      const tables = [];
      const sequences = [];
      for (const obj of objects.rows) {
        const name = obj.schema_name + "." + obj.object_name;
        const sqlName = quoteIdent(obj.schema_name) + "." + quoteIdent(obj.object_name);
        if (obj.relkind === "S") {
          const seq = await client.query("SELECT last_value::text AS value, is_called FROM " + sqlName);
          if (seq.rows.length !== 1) throw new Error("PHASE7_SEQUENCE_MISSING");
          sequences.push({ name, lastValue: seq.rows[0].value, isCalled: seq.rows[0].is_called });
          continue;
        }
        // One snapshot, bounded application memory. PostgreSQL may spill SORT
        // to disk for big tables; only run on an isolated clone with disk headroom.
        await client.query("DECLARE phase7_scan NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS record FROM " +
          sqlName + " t ORDER BY row_to_json(t)::text COLLATE \"C\"");
        const h = createHash("sha256");
        let rows = 0;
        for (;;) {
          const batch = await client.query("FETCH FORWARD 500 FROM phase7_scan");
          if (!batch.rows.length) break;
          for (const entry of batch.rows) {
            hashUpdate(h, entry.record);
            rows++;
          }
        }
        await client.query("CLOSE phase7_scan");
        tables.push({ name, rows, sha256: h.digest("hex") });
      }
      await client.query("COMMIT");
      tables.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      sequences.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      // Clones + file tree MUST be frozen, else DB and files may not represent
      // a single point in time. This cannot prove atomic DB/uploads capture.
      const uploads = await uploadFingerprint(uploadsDir);
      return { protocol: PHASE7_BASELINE_PROTOCOL, scope, snapshotSha256,
        schemaSha256, tables, sequences, uploads };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  } finally {
    await client.end();
  }
}

async function main(args) {
  if (args[0] === "compare" && args.length === 3) {
    const [source, restored] = await Promise.all(
      args.slice(1).map(async (name) => JSON.parse(await readFile(resolve(name), "utf8")))
    );
    const outcome = comparePhase7Baselines(source, restored);
    console.log("PHASE7_BASELINE_COMPARE_OK: " + JSON.stringify(outcome));
    console.log("Not certification: independently authenticate source snapshot, identity, uploads and approval.");
    return;
  }
  if (args[0] === "capture" && args.length === 3) {
    const report = await captureClone({
      connectionString: process.env.PHASE7_AUDIT_DATABASE_URL,
      scope: process.env.PHASE7_AUDIT_SCOPE,
      snapshotSha256: process.env.PHASE7_AUDIT_SNAPSHOT_SHA256,
      uploadsDir: args[1],
    });
    // Exclusive creation; no preexisting output, symlink, or loose permissions.
    const output = await open(resolve(args[2]), "wx", 0o600);
    try { await output.writeFile(JSON.stringify(report, null, 2) + "\n"); }
    finally { await output.close(); }
    console.log("PHASE7_BASELINE_CAPTURE_RECORDED: private read-only clone evidence only");
    return;
  }
  throw new Error("Usage: capture <isolated-uploads-dir> <new-private-report.json> OR compare <source-report.json> <restore-report.json>");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

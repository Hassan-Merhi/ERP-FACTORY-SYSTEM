#!/usr/bin/env node
/**
 * Prove the server boots without changing the database schema.
 *
 *   node scripts/db/verify-boot-no-ddl.mjs            # migrated DB: must boot, must run no DDL
 *   node scripts/db/verify-boot-no-ddl.mjs --expect-refusal
 *                                                     # incomplete DB: must refuse to start
 *
 * DATABASE_URL must point at a DISPOSABLE database (CI's service container).
 * The script needs a superuser to install an event trigger: it records every DDL
 * command (ddl_command_end and sql_drop) executed by ANY session while the
 * server boots and serves requests. Temporary objects (pg_temp) are ignored:
 * they never change the persistent schema. It also compares full catalog
 * snapshots before and after. Requires a built server (npm run build).
 *
 * Exit 0 only if the expectation holds.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { resolveDatabaseSsl } from "../../server/lib/databaseSsl.mjs";
import { compareSnapshots, summariseComparison, takeCatalogSnapshot } from "../../server/schema/schemaCatalog.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXPECT_REFUSAL = process.argv.includes("--expect-refusal");
const PORT = process.env.BOOT_CHECK_PORT ?? "5099";
const BOOT_TIMEOUT_MS = 180_000;

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL (disposable database) is required");

async function connect() {
  const client = new pg.Client({ connectionString: url, ssl: resolveDatabaseSsl(url) });
  await client.connect();
  return client;
}

const WATCH_SQL = `
  CREATE SCHEMA IF NOT EXISTS ddl_watch;
  CREATE TABLE IF NOT EXISTS ddl_watch.events (
    id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT clock_timestamp(),
    event text, command_tag text, object_type text, object_identity text,
    application_name text, query text);
  CREATE OR REPLACE FUNCTION ddl_watch.on_ddl() RETURNS event_trigger LANGUAGE plpgsql AS $$
  DECLARE r record;
  BEGIN
    FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
      IF r.schema_name IS NULL OR (r.schema_name NOT LIKE 'pg_temp%' AND r.schema_name <> 'ddl_watch') THEN
        INSERT INTO ddl_watch.events (event, command_tag, object_type, object_identity, application_name, query)
        VALUES (tg_event, r.command_tag, r.object_type, r.object_identity,
                current_setting('application_name', true), left(current_query(), 500));
      END IF;
    END LOOP;
  END $$;
  CREATE OR REPLACE FUNCTION ddl_watch.on_drop() RETURNS event_trigger LANGUAGE plpgsql AS $$
  DECLARE r record;
  BEGIN
    FOR r IN SELECT * FROM pg_event_trigger_dropped_objects() LOOP
      IF NOT r.is_temporary AND coalesce(r.schema_name, '') <> 'ddl_watch' THEN
        INSERT INTO ddl_watch.events (event, command_tag, object_type, object_identity, application_name, query)
        VALUES (tg_event, 'DROP', r.object_type, r.object_identity,
                current_setting('application_name', true), left(current_query(), 500));
      END IF;
    END LOOP;
  END $$;
  DROP EVENT TRIGGER IF EXISTS ddl_watch_end;
  DROP EVENT TRIGGER IF EXISTS ddl_watch_drop;
  CREATE EVENT TRIGGER ddl_watch_end ON ddl_command_end EXECUTE FUNCTION ddl_watch.on_ddl();
  CREATE EVENT TRIGGER ddl_watch_drop ON sql_drop EXECUTE FUNCTION ddl_watch.on_drop();
  TRUNCATE ddl_watch.events;`;

const REMOVE_WATCH_SQL = `
  DROP EVENT TRIGGER IF EXISTS ddl_watch_end;
  DROP EVENT TRIGGER IF EXISTS ddl_watch_drop;
  DROP SCHEMA IF EXISTS ddl_watch CASCADE;`;

const withoutWatch = (lines) => lines.filter((line) => !line.includes("ddl_watch"));

function startServer() {
  const child = spawn(
    process.execPath,
    ["--expose-gc", "--import", "./server/startupPreload.mjs", "--import", "./server/runtimeMemoryGuard.mjs", "dist/index.js"],
    { cwd: ROOT, env: { ...process.env, PORT, ENABLE_SCHEDULERS: "false" }, stdio: ["ignore", "pipe", "pipe"] }
  );
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return { child, exited, output: () => output };
}

async function waitForReady(server) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health/db`);
      if (res.ok && (await res.text()).includes('"status":"ok"')) return true;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

/** Requests that reach the database through ordinary request handling. */
async function exerciseServer() {
  const paths = [
    "/api/health/db",
    "/api/health/ready",
    "/api/build-info",
    "/api/boot",
    "/api/auth/me",
    "/api/companies",
    "/api/vouchers",
    "/api/factory/containers",
    "/api/sp/containers",
    "/api/stock-items",
  ];
  const results = [];
  for (const p of paths) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}${p}`);
      results.push(`${p} ${res.status}`);
    } catch (error) {
      results.push(`${p} ${error.message}`);
    }
  }
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "boot-check-nonexistent", password: "not-a-real-password" }),
    });
    results.push(`POST /api/auth/login ${res.status}`);
  } catch (error) {
    results.push(`POST /api/auth/login ${error.message}`);
  }
  return results;
}

async function stopServer(server) {
  server.child.kill("SIGTERM");
  const timer = setTimeout(() => server.child.kill("SIGKILL"), 15_000);
  await server.exited;
  clearTimeout(timer);
}

async function main() {
  const admin = await connect();
  let failed = false;
  try {
    await admin.query(WATCH_SQL);
    const before = withoutWatch(await takeCatalogSnapshot(admin));
    const server = startServer();

    if (EXPECT_REFUSAL) {
      const ready = await Promise.race([waitForReady(server), server.exited.then(() => false)]);
      if (ready) {
        console.error("FAIL: server became ready on an incomplete schema");
        failed = true;
        await stopServer(server);
      } else {
        const { code } = await server.exited;
        const refused = code !== 0 && /Database schema does not match this release/.test(server.output());
        console.log(refused ? `OK: server refused to start (exit ${code})` : `FAIL: unexpected exit ${code}`);
        if (!refused) {
          failed = true;
          console.error(server.output().slice(-4000));
        }
      }
    } else {
      const ready = await waitForReady(server);
      if (!ready) {
        console.error("FAIL: server did not become ready");
        console.error(server.output().slice(-6000));
        failed = true;
      } else {
        console.log("Server ready; exercising endpoints");
        for (const line of await exerciseServer()) console.log(`  ${line}`);
        // Let post-listen jobs run before stopping.
        await new Promise((resolve) => setTimeout(resolve, Number(process.env.BOOT_CHECK_SETTLE_MS ?? 15_000)));
      }
      await stopServer(server);
    }

    const events = await admin.query(
      "SELECT event, command_tag, object_type, object_identity, application_name, query FROM ddl_watch.events ORDER BY id"
    );
    const after = withoutWatch(await takeCatalogSnapshot(admin));
    const diff = compareSnapshots(before, after);
    const unchanged = diff.missing.length === 0 && diff.changed.length === 0 && diff.extra.length === 0;

    console.log(`DDL events recorded while the server ran: ${events.rowCount}`);
    for (const e of events.rows.slice(0, 50)) {
      console.log(`  ${e.command_tag} ${e.object_type} ${e.object_identity} [${e.application_name}] ${String(e.query).replace(/\s+/g, " ").slice(0, 160)}`);
    }
    console.log(`Catalog unchanged: ${unchanged} ${unchanged ? "" : JSON.stringify(summariseComparison(diff))}`);
    if (events.rowCount > 0 || !unchanged) failed = true;
  } finally {
    await admin.query(REMOVE_WATCH_SQL).catch(() => {});
    await admin.end();
  }
  if (failed) {
    console.error(EXPECT_REFUSAL ? "Boot refusal check FAILED" : "Boot no-DDL check FAILED");
    process.exitCode = 1;
  } else {
    console.log(EXPECT_REFUSAL ? "Boot refusal check passed" : "Boot no-DDL check passed: the server changed no schema");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

import { Server } from "node:http";
import { Client } from "pg";
import { deploymentRuntimeConfig, factoryEdgeRuntimeConfig } from "./deploymentPreflight.mjs";
import { hasFactoryEdgeData } from "./edge/edgeDatabaseProof.mjs";
import { runtimeReleaseState } from "./runtimeReleaseState.mjs";
import { resolveDatabaseSsl } from "./lib/databaseSsl.mjs";
import {
  criticalColumns,
  criticalIndexes,
  criticalTables,
  evaluateCriticalSchema,
} from "./criticalSchemaReadiness.mjs";

const hasDatabaseConfig = deploymentRuntimeConfig.databaseSource !== "missing-development-database";
const startedAt = Date.now();
const configuredSchemaCacheMs = Number.parseInt(process.env.READINESS_SCHEMA_CACHE_MS || "30000", 10);
const schemaCacheTtlMs = Number.isFinite(configuredSchemaCacheMs) ? Math.max(5_000, configuredSchemaCacheMs) : 30_000;
let listening = false;
let shuttingDown = false;
let schemaCache = null;

process.once("SIGTERM", () => {
  shuttingDown = true;
});
process.once("SIGINT", () => {
  shuttingDown = true;
});

async function probeCriticalSchema(client) {
  const now = Date.now();
  if (schemaCache && now - schemaCache.checkedAt < schemaCacheTtlMs) {
    return schemaCache.result;
  }

  const qualifiedColumns = criticalColumns.map(([tableName, columnName]) => `${tableName}.${columnName}`);
  const [tableResult, columnResult, indexResult] = await Promise.all([
    client.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [criticalTables]
    ),
    client.query(
      `SELECT table_name AS "tableName", column_name AS "columnName"
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (table_name || '.' || column_name) = ANY($1::text[])`,
      [qualifiedColumns]
    ),
    client.query(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = ANY($1::text[])`,
      [criticalIndexes]
    ),
  ]);

  const result = evaluateCriticalSchema({
    tables: tableResult.rows.map((row) => row.table_name),
    columns: columnResult.rows,
    indexes: indexResult.rows.map((row) => row.indexname),
  });
  schemaCache = { checkedAt: now, result };
  return result;
}

async function probeDatabase() {
  if (!hasDatabaseConfig) return { ok: false, reason: "database configuration missing" };
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    host: process.env.DATABASE_URL ? undefined : process.env.PGHOST,
    port: process.env.DATABASE_URL ? undefined : Number(process.env.PGPORT || 5432),
    user: process.env.DATABASE_URL ? undefined : process.env.PGUSER,
    password: process.env.DATABASE_URL ? undefined : process.env.PGPASSWORD,
    database: process.env.DATABASE_URL ? undefined : process.env.PGDATABASE,
    connectionTimeoutMillis: 3000,
    ssl: resolveDatabaseSsl(process.env.DATABASE_URL),
  });
  try {
    await client.connect();
    await client.query("SELECT 1");
    const schema = await probeCriticalSchema(client);
    const edgeDataProvisioned = factoryEdgeRuntimeConfig.mode !== "lan" || (await hasFactoryEdgeData(client));
    return { ok: true, schema, edgeDataProvisioned };
  } catch (error) {
    return { ok: false, reason: error?.message || String(error) };
  } finally {
    await client.end().catch(() => undefined);
  }
}

function sendJson(res, statusCode, body) {
  if (res.headersSent || res.writableEnded) return;
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

const originalListen = Server.prototype.listen;
Server.prototype.listen = function healthAwareListen(...args) {
  this.once("listening", () => {
    listening = true;
  });
  this.once("close", () => {
    listening = false;
  });
  return originalListen.apply(this, args);
};

const originalEmit = Server.prototype.emit;
Server.prototype.emit = function healthAwareEmit(event, ...args) {
  if (event !== "request") return originalEmit.call(this, event, ...args);
  const [req, res] = args;
  let pathname = "/";
  try {
    pathname = new URL(req.url || "/", "http://localhost").pathname;
  } catch {}

  if (pathname === "/api/health/live") {
    sendJson(res, 200, {
      status: "live",
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      release: runtimeReleaseState,
    });
    return true;
  }

  if (pathname === "/api/health/ready") {
    void probeDatabase().then((database) => {
      const ready =
        listening &&
        !shuttingDown &&
        hasDatabaseConfig &&
        database.ok &&
        database.schema?.ok === true &&
        database.edgeDataProvisioned !== false;
      sendJson(res, ready ? 200 : 503, {
        status: ready ? "ready" : "not_ready",
        listening,
        shuttingDown,
        environmentValid: hasDatabaseConfig,
        database,
        release: runtimeReleaseState,
      });
    });
    return true;
  }

  return originalEmit.call(this, event, ...args);
};

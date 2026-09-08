import "./startupMigrationCoordinator";
import "./companyScopeRlsBridge.mjs";
import "./stockItemSchemaRepairBridge.mjs";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import * as schema from "@shared/schema";
import { logger } from "./lib/logger";
import { readDatabaseRuntimeConfig } from "./lib/databaseConfig";
import { resolveDatabaseSsl } from "./lib/databaseSsl.mjs";
import { logDatabasePoolSnapshot, logSlowDatabaseQuery } from "./lib/databaseTelemetry";
import { isRequestPerformanceContextActive, recordDatabaseQuery } from "./lib/requestPerformanceContext";
import { getDatabaseScopeRuntimeContext } from "./services/security/databaseScopeRuntimeContext";

let connectionString: string;
let databaseSource: "DATABASE_URL" | "PG_ENV";

if (process.env.DATABASE_URL) {
  connectionString = process.env.DATABASE_URL;
  databaseSource = "DATABASE_URL";
} else if (
  process.env.PGHOST &&
  process.env.PGPORT &&
  process.env.PGUSER &&
  process.env.PGPASSWORD &&
  process.env.PGDATABASE
) {
  const { PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE } = process.env;
  connectionString = `postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${PGDATABASE}`;
  databaseSource = "PG_ENV";
} else {
  throw new Error("No database configuration found. Please set DATABASE_URL or provision a PostgreSQL database.");
}

const isLocalReplitDB = process.env.PGHOST === "helium" || connectionString.includes("@helium:");
const sslExplicitlyDisabled = process.env.PGSSLMODE === "disable";
const requiresSSL = !isLocalReplitDB && !sslExplicitlyDisabled;
const databaseRuntimeConfig = readDatabaseRuntimeConfig();

logger.info("Database configuration selected", {
  module: "database",
  action: "configure",
  source: databaseSource,
  sslEnabled: requiresSSL,
});

if (sslExplicitlyDisabled && !isLocalReplitDB) {
  logger.warn("Database SSL disabled by environment", {
    module: "database",
    action: "configure",
    setting: "PGSSLMODE=disable",
  });
}

logger.info("Database pool configured", {
  module: "database",
  action: "pool-configure",
  max: databaseRuntimeConfig.poolMax,
  min: databaseRuntimeConfig.poolMin,
  connectionTimeoutMillis: databaseRuntimeConfig.connectionTimeoutMillis,
  idleTimeoutMillis: databaseRuntimeConfig.idleTimeoutMillis,
  statementTimeoutMillis: databaseRuntimeConfig.statementTimeoutMillis,
  slowQueryThresholdMillis: databaseRuntimeConfig.slowQueryThresholdMillis,
});

const basePool = new Pool({
  connectionString,
  ssl: resolveDatabaseSsl(connectionString),
  max: databaseRuntimeConfig.poolMax,
  min: databaseRuntimeConfig.poolMin,
  connectionTimeoutMillis: databaseRuntimeConfig.connectionTimeoutMillis,
  idleTimeoutMillis: databaseRuntimeConfig.idleTimeoutMillis,
  allowExitOnIdle: false,
  options: `-c statement_timeout=${databaseRuntimeConfig.statementTimeoutMillis}`,
});

/**
 * Tracks the last scope written to each physical PostgreSQL connection.
 *
 * Scope values are session-local so a client can be returned to the pool without
 * an extra RESET round-trip. Before that client is handed to the next caller we
 * always compare its remembered signature to the current AsyncLocalStorage
 * scope and overwrite all three GUCs when they differ. An unscoped caller is a
 * real state (`off||`) rather than "leave whatever was there", which prevents a
 * tenant or maintenance identity from leaking across pooled requests.
 */
const clientScopeSignatures = new WeakMap<PoolClient, string>();

function desiredDatabaseScope(): {
  signature: string;
  maintenance: "on" | "off";
  companyId: string;
  authorizedCompanyIds: string;
} {
  const context = getDatabaseScopeRuntimeContext();

  if (context?.kind === "maintenance") {
    return {
      signature: "maintenance",
      maintenance: "on",
      companyId: "",
      authorizedCompanyIds: "",
    };
  }

  if (context?.kind === "tenant") {
    const authorizedCompanyIds =
      context.scopeMode === "authorized-companies" ? context.authorizedCompanyIds.join(",") : "";

    return {
      // Ordinary tenant requests stay pinned to the active company. Only
      // server-trusted cross-company surfaces may opt into the already-verified
      // authorized company list; caller-supplied secondary IDs alone never widen
      // the pooled RLS boundary.
      signature:
        context.scopeMode === "authorized-companies"
          ? `tenant-authorized:${context.companyId}:${authorizedCompanyIds}`
          : `tenant:${context.companyId}`,
      maintenance: "off",
      companyId: String(context.companyId),
      authorizedCompanyIds,
    };
  }

  return {
    signature: "unscoped",
    maintenance: "off",
    companyId: "",
    authorizedCompanyIds: "",
  };
}

async function ensureDatabaseClientScope(client: PoolClient): Promise<void> {
  const desired = desiredDatabaseScope();
  if (clientScopeSignatures.get(client) === desired.signature) return;

  await client.query(
    `SELECT
       set_config('app.company_scope_maintenance', $1, false),
       set_config('app.current_company_id', $2, false),
       set_config('app.authorized_company_ids', $3, false)`,
    [desired.maintenance, desired.companyId, desired.authorizedCompanyIds]
  );
  clientScopeSignatures.set(client, desired.signature);
}

const scopedPoolConnect = (async () => {
  const client = await basePool.connect();
  try {
    await ensureDatabaseClientScope(client);
    return client;
  } catch (error) {
    client.release();
    throw error;
  }
}) as typeof basePool.connect;

const scopedPoolQuery = (async (...args: Parameters<typeof basePool.query>) => {
  const shouldRecordRequestQuery = isRequestPerformanceContextActive();
  const startedAt = performance.now();
  const client = await basePool.connect();

  try {
    await ensureDatabaseClientScope(client);
    return await Reflect.apply(client.query, client, args);
  } finally {
    client.release();
    const durationMillis = performance.now() - startedAt;

    if (shouldRecordRequestQuery) {
      recordDatabaseQuery(durationMillis);
    }

    logSlowDatabaseQuery(durationMillis, databaseRuntimeConfig.slowQueryThresholdMillis);
  }
}) as typeof basePool.query;

/**
 * Public application pool. `query` and `connect` are the only lease-producing
 * surfaces and both establish an explicit database scope before tenant data can
 * be touched. Everything else (events, counters, shutdown) stays bound to the
 * physical node-postgres pool.
 */
export const pool = new Proxy(basePool, {
  get(target, property) {
    if (property === "query") return scopedPoolQuery;
    if (property === "connect") return scopedPoolConnect;

    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

pool.on("error", (error) => {
  logger.error("Database pool idle-client error", {
    module: "database",
    action: "pool-error",
    error,
  });
  logPoolStats("on-error");
});

pool.on("connect", () => logPoolStats("connect"));
pool.on("remove", () => logPoolStats("remove"));

const POOL_PRESSURE_GRACE_MS = 250;
let poolPressureTimer: NodeJS.Timeout | null = null;

pool.on("acquire", () => {
  if (pool.waitingCount === 0 || poolPressureTimer) return;

  poolPressureTimer = setTimeout(() => {
    poolPressureTimer = null;
    if (pool.waitingCount > 0) {
      logPoolStats("sustained-acquire-pressure");
    }
  }, POOL_PRESSURE_GRACE_MS);
  poolPressureTimer.unref();
});

export function logPoolStats(trigger: string) {
  logDatabasePoolSnapshot(pool, trigger);
}

export const db = drizzle(pool, { schema });

/** The application's drizzle database handle. */
export type Database = typeof db;

/**
 * The transaction handle drizzle hands to a `db.transaction` callback.
 *
 * Derived from `db` rather than written out, so it tracks the schema and the
 * driver automatically. Route and service helpers that take a transaction
 * should use this instead of `any`.
 */
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Either handle, for helpers that run the same statements inside or outside a
 * transaction. `db` and a transaction share the query surface these helpers use.
 */
export type DatabaseOrTransaction = Database | DbTransaction;

/**
 * A row shape for `db.execute` / `tx.execute`.
 *
 * Drizzle constrains that generic to `Record<string, unknown>`. Wrapping a
 * precise row interface here at the call site keeps the interface itself free
 * of a catch-all index signature, which would otherwise hide a misspelled
 * column in every consumer of the result.
 */
export type RawQueryRow<TRow> = TRow & Record<string, unknown>;

/** The application's pg connection pool. */
export type DatabasePool = typeof pool;

// Lightweight pool snapshot exposed on globalThis so mjs lifecycle/health
// modules can read it without creating a circular import dependency.
(
  globalThis as unknown as typeof globalThis & {
    __erpDatabasePoolSnapshot: () => { totalCount: number; idleCount: number; waitingCount: number };
  }
).__erpDatabasePoolSnapshot = () => ({
  totalCount: pool.totalCount,
  idleCount: pool.idleCount,
  waitingCount: pool.waitingCount,
});

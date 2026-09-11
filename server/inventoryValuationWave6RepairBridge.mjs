import process from "node:process";
import pg from "pg";
import { resolveDatabaseSsl } from "./lib/databaseSsl.mjs";

const { Client } = pg;
const INSTALL_KEY = Symbol.for("erp.inventory-valuation-wave6-repair.applied");
const STARTUP_LOCK_KEY = 741_220_266;
const ENV_KEY = "INVENTORY_VALUATION_WAVE6_REPAIR";

function resolveConnectionString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (process.env.PGHOST && process.env.PGUSER && process.env.PGPASSWORD && process.env.PGDATABASE) {
    return `postgresql://${encodeURIComponent(process.env.PGUSER)}:${encodeURIComponent(process.env.PGPPASSWORD)}@${process.env.PGHOST}:${process.env.PGPORT || "5432"}/${process.env.PGDATABASE}`;
  }
  return "";
}

function log(level, message, extra = {}) {
  const method = level === "ERROR" ? "error" : level === "WARN" ? "warn" : "log";
  console[method](
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      module: "inventory-valuation-wave6-repair",
      action: "startup-guarded-repair",
      ...extra,
    })
  );
}

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function requireNonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function requireNumericString(value, name, { positive = false } = {}) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a numeric string`);
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || (positive && numeric <= 0)) {
    throw new Error(`${name} must be ${positive ? "a positive" : "a finite"} numeric string`);
  }
  return value.trim();
}

function requireTimestamp(value, name) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`${name} must be an ISO timestamp`);
  }
  return value;
}

export function parseWave6RepairConfig(raw) {
  if (!raw || /^(?:0|false|off|disabled)$/i.test(raw.trim())) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${ENV_KEY} must be valid JSON`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${ENV_KEY} must contain one JSON object`);
  }

  const repairKey = typeof parsed.repairKey === "string" ? parsed.repairKey.trim() : "";
  if (!repairKey) throw new Error("repairKey is required");

  const config = {
    repairKey,
    companyId: requirePositiveInteger(parsed.companyId, "companyId"),
    locationId: requirePositiveInteger(parsed.locationId, "locationId"),
    stockItemId: requirePositiveInteger(parsed.stockItemId, "stockItemId"),
    expectedLastUpdated: requireTimestamp(parsed.expectedLastUpdated, "expectedLastUpdated"),
    expectedQuantity: requireNumericString(parsed.expectedQuantity, "expectedQuantity"),
    expectedRate: requireNumericString(parsed.expectedRate, "expectedRate", { positive: true }),
    expectedValue: requireNumericString(parsed.expectedValue, "expectedValue"),
    targetRate: requireNumericString(parsed.targetRate, "targetRate", { positive: true }),
    targetValue: requireNumericString(parsed.targetValue, "targetValue"),
    expectedNegativeLayerCount: requireNonNegativeInteger(
      parsed.expectedNegativeLayerCount,
      "expectedNegativeLayerCount"
    ),
  };

  const targetFromRate = Math.round(Number(config.expectedQuantity) * Number(config.targetRate) * 100) / 100;
  if (Math.abs(targetFromRate - Number(config.targetValue)) > 0.005) {
    throw new Error("targetValue must equal expectedQuantity × targetRate rounded to cents");
  }

  return config;
}

function numbersEqual(left, right, tolerance = 0.0000005) {
  return Math.abs(Number(left) - Number(right)) <= tolerance;
}

export function classifyWave6InventoryState(row, config, negativeLayerCount) {
  if (!row) return "missing";
  if (negativeLayerCount !== config.expectedNegativeLayerCount) return "conflict";

  const quantityMatches = numbersEqual(row.quantity, config.expectedQuantity);
  if (!quantityMatches) return "conflict";

  const preRepairState =
    numbersEqual(row.average_rate, config.expectedRate) &&
    numbersEqual(row.total_value, config.expectedValue) &&
    row.last_updated_text === config.expectedLastUpdated;
  if (preRepairState) return "ready";

  const alreadyApplied =
    numbersEqual(row.average_rate, config.targetRate) && numbersEqual(row.total_value, config.targetValue);
  if (alreadyApplied) return "already-applied";

  return "conflict";
}

async function readInventoryForUpdate(client, config) {
  const result = await client.query(
    `SELECT
       id,
       quantity::text AS quantity,
       average_rate::text AS average_rate,
       total_value::text AS total_value,
       to_char(last_updated AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_updated_text
     FROM inventory
     WHERE company_id = $1
       AND location_id = $2
       AND stock_item_id = $3
     FOR UPDATE`,
    [config.companyId, config.locationId, config.stockItemId]
  );
  return result.rows[0] ?? null;
}

async function countNegativeLayersForUpdate(client, config) {
  const result = await client.query(
    `SELECT id
       FROM inventory_negative_layers
      WHERE company_id = $1
        AND location_id = $2
        AND stock_item_id = $3
      ORDER BY id
      FOR UPDATE`,
    [config.companyId, config.locationId, config.stockItemId]
  );
  return result.rows.length;
}

export async function applyInventoryValuationWave6Repair(rawConfig = process.env[ENV_KEY]) {
  const config = parseWave6RepairConfig(rawConfig);
  if (!config) return { status: "disabled" };

  const connectionString = resolveConnectionString();
  if (!connectionString) {
    throw new Error("Wave 6 inventory repair cannot run because no PostgreSQL configuration is available");
  }

  const client = new Client({
    connectionString,
    ssl: resolveDatabaseSsl(connectionString),
    connectionTimeoutMillis: 15_000,
  });

  try {
    await client.connect();
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SELECT pg_advisory_xact_lock($1)", [STARTUP_LOCK_KEY]);
    await client.query(
      `SELECT
         set_config('app.company_scope_maintenance', 'off', true),
         set_config('app.current_company_id', $1, true),
         set_config('app.authorized_company_ids', '', true)`,
      [String(config.companyId)]
    );

    const before = await readInventoryForUpdate(client, config);
    const negativeLayerCount = await countNegativeLayersForUpdate(client, config);
    const state = classifyWave6InventoryState(before, config, negativeLayerCount);

    if (state === "already-applied") {
      await client.query("COMMIT");
      log("INFO", "Wave 6 inventory valuation repair already applied", {
        repairKey: config.repairKey,
        companyId: config.companyId,
        locationId: config.locationId,
        stockItemId: config.stockItemId,
        inventory: before,
        negativeLayerCount,
      });
      return { status: "already-applied", before, after: before, negativeLayerCount };
    }

    if (state !== "ready") {
      throw new Error(
        `Wave 6 repair guard rejected ${config.repairKey}: inventory state is ${state}; production was not changed`
      );
    }

    const update = await client.query(
      `UPDATE inventory
          SET average_rate = $1::numeric,
              total_value = $2::numeric,
              last_updated = NOW()
        WHERE id = $3
          AND company_id = $4
          AND location_id = $5
          AND stock_item_id = $6
          AND quantity::numeric = $7::numeric
          AND average_rate::numeric = $8::numeric
          AND total_value::numeric = $9::numeric
          AND to_char(last_updated AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') = $10`,
      [
        config.targetRate,
        config.targetValue,
        before.id,
        config.companyId,
        config.locationId,
        config.stockItemId,
        config.expectedQuantity,
        config.expectedRate,
        config.expectedValue,
        config.expectedLastUpdated,
      ]
    );

    if (update.rowCount !== 1) {
      throw new Error(`Wave 6 repair guard lost its snapshot lock for ${config.repairKey}; production was not changed`);
    }

    const after = await readInventoryForUpdate(client, config);
    if (
      !after ||
      !numbersEqual(after.quantity, config.expectedQuantity) ||
      !numbersEqual(after.average_rate, config.targetRate) ||
      !numbersEqual(after.total_value, config.targetValue)
    ) {
      throw new Error(`Wave 6 repair postcondition failed for ${config.repairKey}; transaction will be rolled back`);
    }

    await client.query("COMMIT");
    log("INFO", "Wave 6 inventory valuation repair committed", {
      repairKey: config.repairKey,
      companyId: config.companyId,
      locationId: config.locationId,
      stockItemId: config.stockItemId,
      negativeLayerCount,
      before,
      after,
    });
    return { status: "applied", before, after, negativeLayerCount };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    log("ERROR", "Wave 6 inventory valuation repair failed closed", {
      errorCode: error?.code,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

if (!globalThis[INSTALL_KEY]) {
  globalThis[INSTALL_KEY] = true;
  await applyInventoryValuationWave6Repair();
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");

test("planner DDL moved to the forward-only controlled migration folder", () => {
  const sql = read("migrations/controlled/20261111_001_factory_fixed_production_plans.sql");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.factory_fixed_production_plans/);
  assert.match(sql, /factory_fixed_production_allocations_object/);
  assert.doesNotMatch(sql, /DELETE FROM|UPDATE\s+vouchers|TRUNCATE/i);
});

test("planner compatibility bridge supports read-only fail-closed verification", () => {
  const source = read("server/fixedProductionPlannerSchemaBridge.mjs");
  assert.match(source, /FIXED_PRODUCTION_PLANNER_SCHEMA_MODE/);
  assert.match(source, /BEGIN READ ONLY/);
  assert.match(source, /if \(ddl\) await client\.query\(ddl\)/);
  assert.match(source, /Schema incomplete|schema incomplete/i);
});

test("startup warning schema migration does not silently delete exchange rates", () => {
  const sql = read("migrations/controlled/20261111_002_startup_warning_schema.sql");
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS exchange_rates_company_date_pair_unique/);
  assert.doesNotMatch(sql, /DELETE\s+FROM|TRUNCATE\s+|UPDATE\s+exchange_rates/i);
});

test("startup warning verification refuses writes in verify-only mode", () => {
  const source = read("server/startupWarningRepair.mjs");
  assert.match(source, /STARTUP_WARNING_SCHEMA_MODE/);
  assert.match(source, /BEGIN READ ONLY/);
  assert.match(source, /if \(verifyOnly\) throw error/);
  assert.match(source, /if \(verifyOnly\)\s*\{\s*await verifyStartupWarningSchema/);
});

test("no implicit deployment cutover has been enabled", () => {
  const render = read("render.yaml");
  const startup = read("server/startupPreload.mjs");
  assert.doesNotMatch(render, /FIXED_PRODUCTION_PLANNER_SCHEMA_MODE|STARTUP_WARNING_SCHEMA_MODE|run-controlled-migrations/);
  assert.doesNotMatch(startup, /run-controlled-migrations/);
});

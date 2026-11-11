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


test("security permissions has controlled non-destructive migration and opt-in read-only startup", () => {
  const sql = read("migrations/controlled/20261111_003_security_permissions_schema.sql");
  const bridge = read("server/criticalSecuritySchemaBridge.mjs");
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS user_security_permissions_unique/);
  assert.doesNotMatch(sql, /DELETE\s+FROM|INSERT\s+INTO|TRUNCATE\s+/i);
  assert.match(bridge, /CRITICAL_SECURITY_SCHEMA_MODE/);
  assert.match(bridge, /BEGIN READ ONLY/);
  assert.match(bridge, /if \(verifyOnly\)/);
});

test("Factory container schema is extracted without tracking value rewrites", () => {
  const sql = read("migrations/controlled/20261111_004_factory_container_columns.sql");
  const bridge = read("server/factoryContainerSchemaBridge.mjs");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS json_cargo_tracking_status TEXT/);
  assert.doesNotMatch(sql, /UPDATE\s+factory_containers|DELETE\s+FROM|TRUNCATE\s+/i);
  assert.match(bridge, /FACTORY_CONTAINER_SCHEMA_MODE/);
  assert.match(bridge, /BEGIN READ ONLY/);
  assert.match(bridge, /tracking flags still enabled/);
});

test("tenant RLS has read-only verification with no automatic repair import", () => {
  const source = read("server/companyScopeRlsBridge.mjs");
  assert.match(source, /COMPANY_SCOPE_RLS_MODE/);
  assert.match(source, /BEGIN READ ONLY/);
  assert.match(source, /if \(verifyOnly\).*RLS schema drift/s);
  assert.match(source, /COMPANY_SCOPE_RLS_MODE !== "verify-only"/);
  assert.match(source, /migrationApplied: !verifyOnly/);
});

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
  assert.doesNotMatch(
    render,
    /FIXED_PRODUCTION_PLANNER_SCHEMA_MODE|STARTUP_WARNING_SCHEMA_MODE|run-controlled-migrations/
  );
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

test("supplier scope verification skips historical supplier-ownership updates", () => {
  const source = read("server/supplierCompanyScopeBridge.mjs");
  assert.match(source, /SUPPLIER_SCOPE_SCHEMA_MODE/);
  assert.match(source, /BEGIN READ ONLY/);
  assert.match(source, /company_code_unique/);
  assert.match(source, /Supplier company scope schema incomplete/);
});

test("multilingual Factory bridge verifies columns without applying French SQL at boot", () => {
  const source = read("server/factoryTrilingualSchemaBridge.mjs");
  const sql = read("migrations/controlled/20261111_005_factory_multilingual_catalog.sql");
  assert.match(source, /FACTORY_MULTILINGUAL_SCHEMA_MODE/);
  assert.match(source, /BEGIN READ ONLY/);
  assert.match(source, /Factory multilingual schema incomplete/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS user_language_preferences/);
  assert.doesNotMatch(sql, /UPDATE\s+factory_bales|DELETE\s+FROM/i);
});

test("Arabic Factory startup supports read-only check and controlled migration", () => {
  const bridge = read("server/factoryBilingualSchemaBridge.mjs");
  const sql = read("migrations/controlled/20261111_006_factory_bilingual_catalog.sql");
  assert.match(bridge, /FACTORY_BILINGUAL_SCHEMA_MODE/);
  assert.match(bridge, /BEGIN READ ONLY/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS factory_bale_products_company_article_code_normalized_idx/);
  assert.match(sql, /factory_v3_load_bales/);
  assert.doesNotMatch(sql, /DELETE\s+FROM|UPDATE\s+factory_bales/i);
});

test("scan timestamp audit verification checks both triggers read-only", () => {
  const bridge = read("server/customerOrderBaleScanAuditBridge.mjs");
  const sql = read("migrations/controlled/20261111_007_bale_scan_timestamp_audit.sql");
  assert.match(bridge, /BALE_SCAN_AUDIT_SCHEMA_MODE/);
  assert.match(bridge, /BEGIN READ ONLY/);
  assert.match(bridge, /scan timestamps/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.set_customer_order_bale_scanned_at/);
  assert.match(sql, /customer_order_bales_history_copy_scanned_at/);
  assert.doesNotMatch(sql, /UPDATE\s+customer_order_bales|DELETE\s+FROM customer_order_bales/i);
});

test("legacy startup runner refuses unmapped historical statements in opt-in mode", () => {
  const src = read("server/startup/runServerStartupMigrations.ts");
  assert.match(src, /LEGACY_STARTUP_MIGRATION_MODE/);
  assert.match(src, /Legacy startup cutover blocked/);
  assert.match(src, /unversioned startup statements have not been mapped/);
});

test("strict legacy startup failures never mark ERP healthy", () => {
  const index = read("server/index.ts");
  const runner = read("server/startup/runServerStartupMigrations.ts");
  assert.match(index, /LEGACY_STARTUP_MIGRATION_MODE === "verify-only"/);
  assert.match(index, /Strict legacy migration verification blocked boot/);
  assert.match(runner, /Legacy startup cutover blocked/);
  assert.match(runner, /Never invoke onComplete\/markStartupMigrationsComplete on a blocked/);
});

test("partial global read-only startup cutover fails before schema preload imports", () => {
  const code = read("server/startupPreload.mjs");
  const gate = code.indexOf('DATABASE_STARTUP_SCHEMA_MODE === "verify-only"');
  const bridge = code.indexOf('await import("./customerOrderBaleScanAuditBridge.mjs")');
  assert.ok(gate > 0 && bridge > gate);
  assert.match(code, /Full read-only database startup cutover is blocked/);
});

test("startup inventory includes central runtime DDL and never declares certified", () => {
  const src = read("scripts/audit-startup-mutation-coverage.mjs");
  assert.match(src, /server\/startup\/ensureRuntimeSchema\.ts/);
  assert.match(src, /server\/startup\/runServerStartupMigrations\.ts/);
  assert.match(src, /certified:false/);
  assert.match(src, /--strict/);
});

test("scheduled WhatsApp schema can be verified without running startup DDL", () => {
  const code = read("server/startup/ensureRuntimeSchema.ts");
  const sql = read("migrations/controlled/20261111_008_scheduled_whatsapp_delivery.sql");
  assert.match(code, /SCHEDULED_WHATSAPP_SCHEMA_MODE/);
  assert.match(code, /Scheduled WhatsApp schema verification failed/);
  assert.match(sql, /scheduled_whatsapp_occurrences_key_unique/);
  assert.match(sql, /scheduled_whatsapp_attachments_status_idx/);
  assert.doesNotMatch(sql, /DELETE\s+FROM|UPDATE\s+scheduled_whatsapp/i);
});

test("insurance monthly amount additive migration contains no historical member modifications", () => {
  const sql = read("migrations/controlled/20261111_009_insurance_monthly_amounts.sql");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS insurance_member_monthly_amounts/);
  assert.match(sql, /insurance_member_monthly_amounts_member_month_unique/);
  assert.doesNotMatch(sql, /INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+insurance_members/i);
});

test("startup mutation inventory loads every numbered startup SQL module", () => {
  const inventory = read("scripts/audit-startup-mutation-coverage.mjs");
  assert.match(inventory, /readdir\(path\.join\(root,"server\/startup-schema"\)\)/);
  assert.match(inventory, /targets\.push\(\.\.\.startupModules\)/);
});

test("controlled stock, Supplier Partner and POS legacy schema contain only additive statements", () => {
  const paths = [
    "migrations/controlled/20261111_010_stock_item_columns.sql",
    "migrations/controlled/20261111_011_sp_invoice_charges.sql",
    "migrations/controlled/20261111_012_pos_port_departure.sql",
  ];
  for (const file of paths) {
    const sql = read(file);
    assert.match(sql, /ALTER TABLE/);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|DROP)\s+/i);
  }
  assert.match(read(paths[0]), /selling_price numeric\(15,2\)/i);
  assert.match(read(paths[1]), /document_charges_usd NUMERIC\(20, 4\)/);
  assert.match(read(paths[2]), /port_departure_date date/);
});

test("financial idempotency, presence indexes and valuation history migrations are schema-only", () => {
  const files = [
    "migrations/controlled/20261111_013_financial_operation_requests.sql",
    "migrations/controlled/20261111_014_user_presence_indexes.sql",
    "migrations/controlled/20261111_015_inventory_valuation_overrides.sql",
  ];
  for (const path of files) {
    const sql = read(path).replace(/^--.*$/gm, "");
    assert.doesNotMatch(sql, /^\s*(?:INSERT\s+INTO|UPDATE\s+\w+|DELETE\s+FROM|TRUNCATE\s+|DROP\s+)/im);
  }
  assert.match(read(files[0]), /financial_operation_requests_company_key_unique/);
  assert.match(read(files[1]), /user_presence_company_last_seen_idx/);
  assert.match(read(files[2]), /inventory_valuation_overrides_company_item_location_idx/);
});

/**
 * Schema diagnostic routes
 *
 * GET  /api/admin/schema-check  — returns which expected columns are missing in production
 * POST /api/admin/schema-fix    — adds every missing column via ALTER TABLE … ADD COLUMN IF NOT EXISTS
 *
 * Both endpoints require Admin or Developer role.
 * Safe to call at any time; the fix is idempotent.
 */

import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { pool } from "../../db";
import { requireAuth } from "../../auth";

// ── The canonical list of columns the application expects ─────────────────────
// Each entry maps to an ALTER TABLE … ADD COLUMN IF NOT EXISTS statement.
// Extend this list any time a new migration column is added.
const EXPECTED_COLUMNS: {
  table: string;
  column: string;
  ddl: string; // the type + default used when adding the missing column
}[] = [
  // ── vouchers ────────────────────────────────────────────────────────────────
  { table: "vouchers", column: "currency", ddl: "VARCHAR(3) NOT NULL DEFAULT 'USD'" },
  { table: "vouchers", column: "supplier_id", ddl: "INTEGER" },

  // ── voucher_entries (multi-currency) ─────────────────────────────────────────
  { table: "voucher_entries", column: "transaction_currency",      ddl: "VARCHAR(3)" },
  { table: "voucher_entries", column: "transaction_debit_amount",  ddl: "NUMERIC(20,6)" },
  { table: "voucher_entries", column: "transaction_credit_amount", ddl: "NUMERIC(20,6)" },
  { table: "voucher_entries", column: "base_debit_amount",         ddl: "NUMERIC(20,6)" },
  { table: "voucher_entries", column: "base_credit_amount",        ddl: "NUMERIC(20,6)" },
  { table: "voucher_entries", column: "historical_exchange_rate",  ddl: "NUMERIC(20,10)" },
  { table: "voucher_entries", column: "rate_convention",           ddl: "VARCHAR(30)" },
  { table: "voucher_entries", column: "factory_supplier_id",       ddl: "INTEGER" },
  { table: "voucher_entries", column: "supplier_id",               ddl: "INTEGER" },

  // ── ledger_accounts ──────────────────────────────────────────────────────────
  { table: "ledger_accounts", column: "opening_balance_currency",        ddl: "VARCHAR(10)" },
  { table: "ledger_accounts", column: "opening_balance_historical_rate", ddl: "NUMERIC(20,10)" },
  { table: "ledger_accounts", column: "opening_balance_base_amount",     ddl: "NUMERIC(20,6)" },
  { table: "ledger_accounts", column: "opening_balance_native_amount",   ddl: "NUMERIC(20,6)" },
  { table: "ledger_accounts", column: "category",                        ddl: "TEXT" },
  { table: "ledger_accounts", column: "sub_type",                        ddl: "TEXT" },

  // ── Supplier Partner container linkage ───────────────────────────────────────
  { table: "sp_containers", column: "supplier_id",          ddl: "INTEGER" },
  { table: "sp_containers", column: "goods_otw_voucher_id", ddl: "INTEGER" },

  // ── bank_accounts ────────────────────────────────────────────────────────────
  { table: "bank_accounts", column: "opening_balance_currency",        ddl: "VARCHAR(10)" },
  { table: "bank_accounts", column: "opening_balance_historical_rate", ddl: "NUMERIC(20,10)" },
  { table: "bank_accounts", column: "opening_balance_base_amount",     ddl: "NUMERIC(20,6)" },
  { table: "bank_accounts", column: "opening_balance_native_amount",   ddl: "NUMERIC(20,6)" },

  // ── customers ────────────────────────────────────────────────────────────────
  { table: "customers", column: "opening_balance_currency",        ddl: "VARCHAR(10)" },
  { table: "customers", column: "opening_balance_historical_rate", ddl: "NUMERIC(20,10)" },
  { table: "customers", column: "opening_balance_base_amount",     ddl: "NUMERIC(20,6)" },
  { table: "customers", column: "opening_balance_native_amount",   ddl: "NUMERIC(20,6)" },

  // ── suppliers ────────────────────────────────────────────────────────────────
  { table: "suppliers", column: "opening_balance_side",            ddl: "VARCHAR(2) DEFAULT 'Cr'" },
  { table: "suppliers", column: "opening_balance_currency",        ddl: "VARCHAR(10)" },
  { table: "suppliers", column: "opening_balance_historical_rate", ddl: "NUMERIC(20,10)" },
  { table: "suppliers", column: "opening_balance_base_amount",     ddl: "NUMERIC(20,6)" },
  { table: "suppliers", column: "opening_balance_native_amount",   ddl: "NUMERIC(20,6)" },

  // ── employees ────────────────────────────────────────────────────────────────
  { table: "employees", column: "opening_balance_side",            ddl: "VARCHAR(2) DEFAULT 'Cr'" },
  { table: "employees", column: "opening_balance_currency",        ddl: "VARCHAR(10)" },
  { table: "employees", column: "opening_balance_historical_rate", ddl: "NUMERIC(20,10)" },
  { table: "employees", column: "opening_balance_base_amount",     ddl: "NUMERIC(20,6)" },
  { table: "employees", column: "opening_balance_native_amount",   ddl: "NUMERIC(20,6)" },
  { table: "employees", column: "sales_bonus_pct",                 ddl: "DECIMAL(10,4)" },
  { table: "employees", column: "bales_bonus_rate",                ddl: "DECIMAL(10,4)" },

  // ── fixed_assets ─────────────────────────────────────────────────────────────
  { table: "fixed_assets", column: "purchase_currency",        ddl: "VARCHAR(10)" },
  { table: "fixed_assets", column: "purchase_historical_rate", ddl: "NUMERIC(20,10)" },
  { table: "fixed_assets", column: "purchase_base_amount",     ddl: "NUMERIC(20,6)" },
  { table: "fixed_assets", column: "purchase_native_amount",   ddl: "NUMERIC(20,6)" },

  // ── salary_advances ──────────────────────────────────────────────────────────
  { table: "salary_advances", column: "remaining_balance", ddl: "DECIMAL(15,2) NOT NULL DEFAULT 0" },
  { table: "salary_advances", column: "fully_paid",        ddl: "BOOLEAN NOT NULL DEFAULT false" },

  // ── user preferences / roles ─────────────────────────────────────────────────
  { table: "user_preferences", column: "preferred_currency",                 ddl: "VARCHAR(10)" },
  { table: "user_preferences", column: "show_profit_comparison_on_pos",      ddl: "BOOLEAN NOT NULL DEFAULT false" },
  { table: "user_company_roles", column: "can_sell_negative_stock",          ddl: "BOOLEAN NOT NULL DEFAULT false" },
  { table: "user_company_roles", column: "daybook_edit_days",                ddl: "INTEGER NOT NULL DEFAULT 0" },
  { table: "user_company_roles", column: "can_access_customers",             ddl: "BOOLEAN NOT NULL DEFAULT false" },
  { table: "user_company_roles", column: "can_delete_records",               ddl: "BOOLEAN NOT NULL DEFAULT false" },
  { table: "user_company_roles", column: "cash_account_id",                  ddl: "INTEGER" },
  { table: "user_company_roles", column: "pos_station",                      ddl: "INTEGER" },
  { table: "user_company_roles", column: "pos_view_only",                    ddl: "BOOLEAN NOT NULL DEFAULT false" },
  { table: "users", column: "hidden_erp_cost_fields", ddl: "TEXT[] NOT NULL DEFAULT '{}'" },
  { table: "users", column: "chatbot_enabled",         ddl: "BOOLEAN NOT NULL DEFAULT false" },

  // ── companies ────────────────────────────────────────────────────────────────
  { table: "companies", column: "base_currency",     ddl: "VARCHAR(10) DEFAULT 'USD'" },
  { table: "companies", column: "display_currency",  ddl: "VARCHAR(10)" },
];

// ── Tables that must exist (not just columns) ─────────────────────────────────
const EXPECTED_TABLES = [
  "fiscal_period_closures",
  "user_security_permissions",
  "user_credential_versions",
  "property_contracts",
  "property_monthly_ledger",
  "property_payments",
];

export function registerSchemaDiagnosticRoutes(app: Express) {
  // ── GET /api/admin/schema-check ─────────────────────────────────────────────
  app.get("/api/admin/schema-check", requireAuth, async (req, res) => {
    const session = req.session;
    const role = session?.currentRole ?? session?.role;
    if (!["Admin", "Developer"].includes(role ?? "")) {
      return res.status(403).json({ message: "Admin or Developer role required." });
    }

    try {
      // 1. Which expected tables are missing entirely?
      const tableCheckResult = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public'`,
      );
      const existingTables = new Set(tableCheckResult.rows.map((r) => r.table_name));
      const missingTables = EXPECTED_TABLES.filter((t) => !existingTables.has(t));

      // 2. Which expected columns are missing?
      // Build a VALUES list and left-join against information_schema.
      const values = EXPECTED_COLUMNS.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(", ");
      const params: string[] = [];
      for (const ec of EXPECTED_COLUMNS) {
        params.push(ec.table, ec.column);
      }

      const colCheckResult = await pool.query<{ tbl: string; col: string }>(
        `SELECT t.tbl, t.col
         FROM (VALUES ${values}) AS t(tbl, col)
         WHERE NOT EXISTS (
           SELECT 1 FROM information_schema.columns c
           WHERE c.table_schema = 'public'
             AND c.table_name   = t.tbl
             AND c.column_name  = t.col
         )`,
        params,
      );

      const missingColumns = colCheckResult.rows.map((r) => `${r.tbl}.${r.col}`);

      const ok = missingTables.length === 0 && missingColumns.length === 0;

      return res.json({
        ok,
        summary: ok
          ? "All expected tables and columns are present."
          : `${missingTables.length} missing table(s), ${missingColumns.length} missing column(s).`,
        missingTables,
        missingColumns,
        hint: ok
          ? null
          : "POST to /api/admin/schema-fix to apply the missing additions automatically.",
      });
    } catch (err: unknown) {
      return res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── POST /api/admin/schema-fix ──────────────────────────────────────────────
  app.post("/api/admin/schema-fix", requireAuth, async (req, res) => {
    const session = req.session;
    const role = session?.currentRole ?? session?.role;
    if (!["Admin", "Developer"].includes(role ?? "")) {
      return res.status(403).json({ message: "Admin or Developer role required." });
    }

    const applied: string[] = [];
    const failed: { item: string; error: string }[] = [];

    // 1. Create missing tables (only safe no-data tables)
    const tableCheckResult = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const existingTables = new Set(tableCheckResult.rows.map((r) => r.table_name));

    if (!existingTables.has("fiscal_period_closures")) {
      try {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS fiscal_period_closures (
            id              SERIAL PRIMARY KEY,
            company_id      INTEGER NOT NULL,
            period_end_date DATE    NOT NULL,
            closed_by       TEXT,
            closed_at       TIMESTAMP NOT NULL DEFAULT NOW(),
            notes           TEXT
          )
        `);
        await pool.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS fiscal_period_closures_company_period_uidx
          ON fiscal_period_closures (company_id, period_end_date)
        `);
        applied.push("TABLE fiscal_period_closures");
      } catch (err: unknown) {
        failed.push({ item: "TABLE fiscal_period_closures", error: getErrorMessage(err) });
      }
    }

    // 2. Add missing columns
    const values = EXPECTED_COLUMNS.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(", ");
    const params: string[] = [];
    for (const ec of EXPECTED_COLUMNS) params.push(ec.table, ec.column);

    const colCheckResult = await pool.query<{ tbl: string; col: string }>(
      `SELECT t.tbl, t.col
       FROM (VALUES ${values}) AS t(tbl, col)
       WHERE NOT EXISTS (
         SELECT 1 FROM information_schema.columns c
         WHERE c.table_schema = 'public'
           AND c.table_name   = t.tbl
           AND c.column_name  = t.col
       )`,
      params,
    );

    for (const { tbl, col } of colCheckResult.rows) {
      const spec = EXPECTED_COLUMNS.find((e) => e.table === tbl && e.column === col);
      if (!spec) continue;
      const sql = `ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS ${col} ${spec.ddl}`;
      try {
        await pool.query(sql);
        applied.push(`${tbl}.${col}`);
      } catch (err: unknown) {
        failed.push({ item: `${tbl}.${col}`, error: getErrorMessage(err) });
      }
    }

    return res.json({
      ok: failed.length === 0,
      applied,
      failed,
      summary: `Applied ${applied.length} addition(s). ${failed.length} failure(s).`,
    });
  });
}

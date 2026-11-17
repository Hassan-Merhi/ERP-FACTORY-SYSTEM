/**
 * Schema diagnostic routes
 *
 * GET  /api/admin/schema-check  — read-only: which expected tables/columns are missing
 * POST /api/admin/schema-fix    — retired (410): the server never changes the schema.
 *
 * The schema is defined only by the numbered migrations (migrations/, applied
 * by scripts/db/migrate.mjs). Both endpoints require Admin or Developer role.
 */

import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { pool } from "../../db";
import { requireAuth } from "../../auth";

// ── Columns the application expects (defined by the schema migrations) ───────
const EXPECTED_COLUMNS: {
  table: string;
  column: string;
}[] = [
  // ── vouchers ────────────────────────────────────────────────────────────────
  { table: "vouchers", column: "currency" },
  { table: "vouchers", column: "supplier_id" },

  // ── voucher_entries (multi-currency) ─────────────────────────────────────────
  { table: "voucher_entries", column: "transaction_currency" },
  { table: "voucher_entries", column: "transaction_debit_amount" },
  { table: "voucher_entries", column: "transaction_credit_amount" },
  { table: "voucher_entries", column: "base_debit_amount" },
  { table: "voucher_entries", column: "base_credit_amount" },
  { table: "voucher_entries", column: "historical_exchange_rate" },
  { table: "voucher_entries", column: "rate_convention" },
  { table: "voucher_entries", column: "factory_supplier_id" },
  { table: "voucher_entries", column: "supplier_id" },

  // ── ledger_accounts ──────────────────────────────────────────────────────────
  { table: "ledger_accounts", column: "opening_balance_currency" },
  { table: "ledger_accounts", column: "opening_balance_historical_rate" },
  { table: "ledger_accounts", column: "opening_balance_base_amount" },
  { table: "ledger_accounts", column: "opening_balance_native_amount" },
  { table: "ledger_accounts", column: "category" },
  { table: "ledger_accounts", column: "sub_type" },

  // ── Supplier Partner container linkage ───────────────────────────────────────
  { table: "sp_containers", column: "supplier_id" },
  { table: "sp_containers", column: "goods_otw_voucher_id" },

  // ── bank_accounts ────────────────────────────────────────────────────────────
  { table: "bank_accounts", column: "opening_balance_currency" },
  { table: "bank_accounts", column: "opening_balance_historical_rate" },
  { table: "bank_accounts", column: "opening_balance_base_amount" },
  { table: "bank_accounts", column: "opening_balance_native_amount" },

  // ── customers ────────────────────────────────────────────────────────────────
  { table: "customers", column: "opening_balance_currency" },
  { table: "customers", column: "opening_balance_historical_rate" },
  { table: "customers", column: "opening_balance_base_amount" },
  { table: "customers", column: "opening_balance_native_amount" },

  // ── suppliers ────────────────────────────────────────────────────────────────
  { table: "suppliers", column: "opening_balance_side" },
  { table: "suppliers", column: "opening_balance_currency" },
  { table: "suppliers", column: "opening_balance_historical_rate" },
  { table: "suppliers", column: "opening_balance_base_amount" },
  { table: "suppliers", column: "opening_balance_native_amount" },

  // ── employees ────────────────────────────────────────────────────────────────
  { table: "employees", column: "opening_balance_side" },
  { table: "employees", column: "opening_balance_currency" },
  { table: "employees", column: "opening_balance_historical_rate" },
  { table: "employees", column: "opening_balance_base_amount" },
  { table: "employees", column: "opening_balance_native_amount" },
  { table: "employees", column: "sales_bonus_pct" },
  { table: "employees", column: "bales_bonus_rate" },

  // ── fixed_assets ─────────────────────────────────────────────────────────────
  { table: "fixed_assets", column: "purchase_currency" },
  { table: "fixed_assets", column: "purchase_historical_rate" },
  { table: "fixed_assets", column: "purchase_base_amount" },
  { table: "fixed_assets", column: "purchase_native_amount" },

  // ── salary_advances ──────────────────────────────────────────────────────────
  { table: "salary_advances", column: "remaining_balance" },
  { table: "salary_advances", column: "fully_paid" },

  // ── user preferences / roles ─────────────────────────────────────────────────
  { table: "user_preferences", column: "preferred_currency" },
  { table: "user_preferences", column: "show_profit_comparison_on_pos" },
  { table: "user_preferences", column: "hidden_transaction_journal_voucher_ids" },
  { table: "user_company_roles", column: "can_sell_negative_stock" },
  { table: "user_company_roles", column: "daybook_edit_days" },
  { table: "user_company_roles", column: "can_access_customers" },
  { table: "user_company_roles", column: "can_delete_records" },
  { table: "user_company_roles", column: "cash_account_id" },
  { table: "user_company_roles", column: "pos_station" },
  { table: "user_company_roles", column: "pos_view_only" },
  { table: "users", column: "hidden_erp_cost_fields" },
  { table: "users", column: "chatbot_enabled" },

  // ── companies ────────────────────────────────────────────────────────────────
  { table: "companies", column: "base_currency" },
  { table: "companies", column: "display_currency" },
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
         WHERE table_schema = 'public'`
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
        params
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
          : "Apply the pending schema migrations (scripts/db/migrate.mjs); the server does not change the schema.",
      });
    } catch (err: unknown) {
      return res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── POST /api/admin/schema-fix (retired) ────────────────────────────────────
  app.post("/api/admin/schema-fix", requireAuth, async (req, res) => {
    const session = req.session;
    const role = session?.currentRole ?? session?.role;
    if (!["Admin", "Developer"].includes(role ?? "")) {
      return res.status(403).json({ message: "Admin or Developer role required." });
    }
    return res.status(410).json({
      ok: false,
      // Schema changes are applied only by scripts/db/migrate.mjs (docs/database-migrations.md).
      code: "SCHEMA_MANAGED_BY_MIGRATIONS",
    });
  });
}

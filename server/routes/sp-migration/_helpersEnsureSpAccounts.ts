// Extracted from ./_helpers.ts to keep that module under the source-size cap.
import { db } from "../../db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { ledgerAccounts } from "@shared/schema";
import { firstRow } from "../../lib/queryResult";
import { parseMoneyInput } from "../../lib/money";

export const pn = (v: unknown) => {
  const n = parseMoneyInput(String(v ?? "0"))?.toNumber() ?? NaN;
  return isNaN(n) ? 0 : n;
};

// ── SP chart of accounts (same list as spRoutes.ts) ──────────────────────────
export const SP_ACCOUNTS = [
  { code: "SP-OTW", name: "Goods On The Way", accountType: "Asset", subType: "sp_goods_otw" },
  { code: "SP-OTWCLR", name: "Goods OTW Clearing", accountType: "Liability", subType: "sp_otw_clearing" },
  { code: "SP-PREPAID", name: "Prepaid Charges", accountType: "Asset", subType: "sp_prepaid" },
  { code: "SP-STOCK", name: "Stock on Floor", accountType: "Asset", subType: "sp_stock" },
  { code: "SP-COSTCLR", name: "Stock Cost Payable Clearing", accountType: "Liability", subType: "sp_cost_clearing" },
  { code: "SP-PAYDED", name: "Pay Deduction Clearing", accountType: "Liability", subType: "sp_pay_deduction_clearing" },
  { code: "SP-PAY", name: "Supplier Cash Payable", accountType: "Liability", subType: "sp_payable" },
  { code: "SP-SALES", name: "Sales", accountType: "Income", subType: "sp_sales" },
  { code: "SP-COGS", name: "Cost of Goods Sold", accountType: "Direct Expense", subType: "sp_cogs" },
  { code: "SP-SHARED", name: "Shared Charges", accountType: "Direct Expense", subType: "sp_shared_charges" },
  { code: "SP-OPNBAL", name: "Opening Balance Clearing", accountType: "Equity", subType: "sp_opnbal" },
  { code: "SP-PREPEXP", name: "Prepaid Expenses", accountType: "Asset", subType: "sp_prepaid_expenses" },
  { code: "SP-HADIIC", name: "HADI Intercompany", accountType: "Intercompany", subType: "sp_hadi_intercompany" },
];

// GC-specific profit-share accounts (created during the GC migration, not the base SP set)
export const GC_PROFIT_ACCOUNTS = [
  { code: "GC-OURPFT", name: "GC Our Profit Share", accountType: "Equity", subType: "gc_our_profit_share" },
  { code: "GC-SUPPFT", name: "GC Supplier Profit Share", accountType: "Equity", subType: "gc_supplier_profit_share" },
  {
    code: "GC-PROFCLR",
    name: "GC Accumulated Profit Clearing",
    accountType: "Equity",
    subType: "gc_accumulated_profit_clearing",
  },
];

// Legacy subTypes created by earlier versions of this tool — kept for account-mapping
// backward compatibility only; no longer created by default.
export const LEGACY_GC_PROFIT_SUBTYPES = ["gc_owner_profit", "gc_supplier_profit"];

// Whitelist of subTypes the rename/create-accounts endpoint is allowed to create.
export const ALL_ACCOUNT_DEFS = [...SP_ACCOUNTS, ...GC_PROFIT_ACCOUNTS];

// ── Helpers ───────────────────────────────────────────────────────────────────

export async function getCompanyRow(companyId: number) {
  const rows = await db.execute(
    sql`SELECT id, code, name, company_type FROM companies WHERE id = ${companyId} LIMIT 1`
  );
  return firstRow(rows) ?? (rows as unknown as { [key: string]: Record<string, unknown> | undefined })[0] ?? null;
}

export async function logRun(
  sourceId: number,
  targetId: number,
  action: string,
  status: string,
  rowsCreated: number,
  errorMessage: string | null,
  notes: string | null
): Promise<string> {
  const [row] = (
    await db.execute<{ id: string }>(sql`
    INSERT INTO sp_migration_rehearsal_runs
      (source_company_id, target_company_id, action, status, rows_created, error_message, notes)
    VALUES
      (${sourceId}, ${targetId}, ${action}, ${status}, ${rowsCreated}, ${errorMessage}, ${notes})
    RETURNING id
  `)
  ).rows;
  return row.id;
}

export async function trackRow(runId: string, tableName: string, rowId: number) {
  await db.execute(sql`
    INSERT INTO sp_migration_run_rows (run_id, table_name, row_id)
    VALUES (${runId}, ${tableName}, ${rowId})
  `);
}

// Map of dependent action -> action(s) that must have a 'completed' run for this
// target company before the dependent action is allowed to run.
export const MIGRATION_ACTION_DEPENDENCIES: Record<string, string[]> = {
  gc_stock_opening: ["gc_stock_master"],
  gc_sales_readonly: ["gc_stock_opening"],
  gc_containers: ["gc_stock_opening"],
};

// Enforced server-side (not just UI) staged-dependency guard. Returns null if the
// dependency is satisfied, or an error message string describing what must run first.
export async function requireCompletedMigrationAction(
  sourceCompanyId: number,
  targetCompanyId: number,
  actionName: string
): Promise<string | null> {
  const deps = MIGRATION_ACTION_DEPENDENCIES[actionName];
  if (!deps || !deps.length) return null;
  const ACTION_LABELS: Record<string, string> = {
    gc_stock_master: "Step 4 — Stock Master",
    gc_stock_opening: "Step 5 — Stock Opening by Location",
    gc_sales_readonly: "Step 6 — Historical Sales",
    gc_containers: "Step 7 — Containers",
  };
  for (const dep of deps) {
    // Scoped to the exact (source, target) pair — a completed run for a different
    // source company into the same target must NOT satisfy this dependency.
    const row = (
      await db.execute(sql`
      SELECT id FROM sp_migration_rehearsal_runs
      WHERE source_company_id = ${sourceCompanyId} AND target_company_id = ${targetCompanyId}
        AND action = ${dep} AND status = 'completed'
      ORDER BY id DESC LIMIT 1
    `)
    ).rows?.[0];
    if (!row) {
      return `Run ${ACTION_LABELS[dep] ?? dep} successfully before running ${ACTION_LABELS[actionName] ?? actionName}.`;
    }
  }
  return null;
}

export async function ensureSpAccounts(
  targetId: number,
  overrides?: Record<string, { code?: string; name?: string }>
): Promise<{ names: string[]; newIds: number[] }> {
  const names: string[] = [];
  const newIds: number[] = [];
  for (const acct of SP_ACCOUNTS) {
    const existing = await db
      .select()
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.companyId, targetId),
          eq(ledgerAccounts.subType, acct.subType),
          isNull(ledgerAccounts.deletedAt)
        )
      );
    if (!existing.length) {
      const code = overrides?.[acct.subType]?.code?.trim() || acct.code;
      const name = overrides?.[acct.subType]?.name?.trim() || acct.name;
      const [row] = (
        await db.execute(sql`
        INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, is_hidden, active)
        VALUES (${targetId}, ${code}, ${name}, ${acct.accountType}, ${acct.subType},
                ${acct.subType.includes("clearing") || acct.subType === "sp_opnbal"}, true)
        RETURNING id
      `)
      ).rows;
      names.push(name);
      newIds.push(pn(row.id));
    }
  }
  return { names, newIds };
}

// Create the GC profit-share accounts (or reuse existing ones), honoring user renames.
export async function ensureGcProfitAccounts(
  targetId: number,
  overrides?: Record<string, { code?: string; name?: string }>
): Promise<{ names: string[]; newIds: number[] }> {
  const names: string[] = [];
  const newIds: number[] = [];
  for (const acct of GC_PROFIT_ACCOUNTS) {
    const existing = (
      await db.execute(sql`
      SELECT id FROM ledger_accounts
      WHERE company_id = ${targetId} AND sub_type = ${acct.subType} AND deleted_at IS NULL LIMIT 1
    `)
    ).rows[0];
    if (!existing) {
      const code = overrides?.[acct.subType]?.code?.trim() || acct.code;
      const name = overrides?.[acct.subType]?.name?.trim() || acct.name;
      const [row] = (
        await db.execute(sql`
        INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, active)
        VALUES (${targetId}, ${code}, ${name}, ${acct.accountType}, ${acct.subType}, true)
        RETURNING id
      `)
      ).rows;
      names.push(name);
      newIds.push(pn(row.id));
    }
  }
  return { names, newIds };
}

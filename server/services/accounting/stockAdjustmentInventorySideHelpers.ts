// Extracted from ./stockAdjustmentInventorySide.ts
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { MoneyDecimal } from "../../lib/money";

/** The accounts the stock adjustment writers post to, now and in older versions. */
const ADJUSTMENT_CODES = ["STOCK_ADJUSTMENT", "PRODUCTION_ADJUSTMENT", "CONSUMPTION_EXPENSE"];

const STOCK_ADJUSTMENT_TYPES = ["Production", "Consumption", "Mixed", "Stock Adjustment"];

export type StockAdjustmentInventorySkipReason = "PERIOD_CLOSED" | "PERPETUAL_ACTIVE" | "NON_USD_VOUCHER";

export type StockAdjustmentInventoryBlocker = "SUPPLIER_PARTNER_COMPANY" | "INVENTORY_ACCOUNT_NEEDS_REVIEW";

export interface StockAdjustmentInventoryPlan {
  companyId: number;
  inventoryAccount: { id: number | null; action: "use" | "create" };
  vouchers: {
    voucherId: number;
    voucherNumber: string;
    voucherType: string;
    voucherDate: string;
    effectiveDate: string | null;
    debit: string;
    credit: string;
    inventoryLine: { side: "debit" | "credit"; amount: string };
  }[];
  skipped: { voucherId: number; voucherNumber: string; reason: StockAdjustmentInventorySkipReason }[];
  blockers: { code: StockAdjustmentInventoryBlocker; message: string }[];
  total: { debit: string; credit: string };
  planHash: string;
}

type CandidateRow = {
  id: number;
  voucher_number: string;
  voucher_type: string;
  voucher_date: string;
  effective_date: string | null;
  voucher_currency: string;
  foreign_lines: boolean;
  perpetual: boolean;
  debit: string;
  credit: string;
};

async function lockedThrough(client: PoolClient, companyId: number): Promise<string | null> {
  const result = await client.query<{ locked: string | null }>(
    `SELECT max(period_end_date)::text AS locked FROM fiscal_period_closures WHERE company_id = $1 AND status = 'CLOSED'`,
    [companyId]
  );
  return result.rows[0]?.locked ?? null;
}

export async function derivePlan(client: PoolClient, companyId: number): Promise<StockAdjustmentInventoryPlan> {
  const blockers: StockAdjustmentInventoryPlan["blockers"] = [];
  const company = await client.query<{ company_type: string | null }>(
    `SELECT company_type FROM companies WHERE id = $1`,
    [companyId]
  );
  if (company.rows[0]?.company_type === "supplier_partner") {
    blockers.push({
      code: "SUPPLIER_PARTNER_COMPANY",
      message: "A supplier-partner company keeps its stock in sp_stock; its stock adjustments carry no Inventory line",
    });
  }

  const account = await client.query<{
    id: number;
    name: string;
    account_type: string | null;
    active: boolean | null;
    deleted: boolean;
  }>(
    `SELECT id, name, account_type, active, deleted_at IS NOT NULL AS deleted
       FROM ledger_accounts WHERE company_id = $1 AND code = 'INVENTORY' ORDER BY id LIMIT 1`,
    [companyId]
  );
  const existing = account.rows[0];
  let inventoryAccount: StockAdjustmentInventoryPlan["inventoryAccount"] = { id: null, action: "create" };
  if (existing) {
    inventoryAccount = { id: existing.id, action: "use" };
    const usable =
      !existing.deleted &&
      existing.active !== false &&
      ["Asset", "Current Asset"].includes(existing.account_type ?? "") &&
      existing.name.trim().toLowerCase() !== "credit note - customer return";
    if (!usable) {
      blockers.push({
        code: "INVENTORY_ACCOUNT_NEEDS_REVIEW",
        message:
          "The INVENTORY account is deleted, inactive, not an asset or still named as the credit-note expense; it is not renamed, retyped or restored here",
      });
    }
  }

  const locked = await lockedThrough(client, companyId);
  const candidates = await client.query<CandidateRow>(
    `SELECT v.id, v.voucher_number, v.voucher_type,
            v.voucher_date::text AS voucher_date, v.effective_date::text AS effective_date,
            upper(COALESCE(NULLIF(btrim(v.currency), ''), 'USD')) AS voucher_currency,
            COALESCE(bool_or(ve.transaction_currency IS NOT NULL AND upper(ve.transaction_currency) <> 'USD'), false)
              AS foreign_lines,
            EXISTS (SELECT 1 FROM gl_inventory_cutovers c
                     WHERE c.company_id = v.company_id AND c.effective_from <= v.voucher_date) AS perpetual,
            COALESCE(SUM(ve.debit_amount), 0)::text AS debit,
            COALESCE(SUM(ve.credit_amount), 0)::text AS credit
       FROM vouchers v
       JOIN voucher_entries ve ON ve.voucher_id = v.id
       LEFT JOIN ledger_accounts la ON la.id = ve.ledger_account_id AND la.company_id = v.company_id
      WHERE v.company_id = $1
        AND v.deleted_at IS NULL
        AND COALESCE(v.optional, false) = false
        AND v.voucher_type = ANY($2::text[])
        AND EXISTS (SELECT 1 FROM stock_adjustment_vouchers sav WHERE sav.voucher_id = v.id)
      GROUP BY v.id
     HAVING bool_and(COALESCE(la.code = ANY($3::text[]), false))
        AND round(COALESCE(SUM(ve.debit_amount), 0), 2) <> round(COALESCE(SUM(ve.credit_amount), 0), 2)
      ORDER BY v.id`,
    [companyId, STOCK_ADJUSTMENT_TYPES, ADJUSTMENT_CODES]
  );

  const vouchers: StockAdjustmentInventoryPlan["vouchers"] = [];
  const skipped: StockAdjustmentInventoryPlan["skipped"] = [];
  let totalDebit = new MoneyDecimal(0);
  let totalCredit = new MoneyDecimal(0);
  for (const row of candidates.rows) {
    const skip = (reason: StockAdjustmentInventorySkipReason) =>
      skipped.push({ voucherId: row.id, voucherNumber: row.voucher_number, reason });
    if (locked && (row.voucher_date <= locked || (row.effective_date ?? row.voucher_date) <= locked)) {
      skip("PERIOD_CLOSED");
      continue;
    }
    if (row.perpetual) {
      skip("PERPETUAL_ACTIVE");
      continue;
    }
    if (row.voucher_currency !== "USD" || row.foreign_lines) {
      skip("NON_USD_VOUCHER");
      continue;
    }
    const debit = new MoneyDecimal(row.debit).toDecimalPlaces(2);
    const credit = new MoneyDecimal(row.credit).toDecimalPlaces(2);
    // The Inventory line takes the side the adjustment lines leave open.
    const net = credit.minus(debit);
    const amount = net.abs();
    if (net.isPositive()) totalDebit = totalDebit.plus(amount);
    else totalCredit = totalCredit.plus(amount);
    vouchers.push({
      voucherId: row.id,
      voucherNumber: row.voucher_number,
      voucherType: row.voucher_type,
      voucherDate: row.voucher_date,
      effectiveDate: row.effective_date,
      debit: debit.toFixed(2),
      credit: credit.toFixed(2),
      inventoryLine: { side: net.isPositive() ? "debit" : "credit", amount: amount.toFixed(2) },
    });
  }

  const plan = {
    companyId,
    inventoryAccount,
    vouchers,
    skipped,
    blockers,
    total: { debit: totalDebit.toFixed(2), credit: totalCredit.toFixed(2) },
  };
  return { ...plan, planHash: createHash("sha256").update(JSON.stringify(plan)).digest("hex") };
}

// Extracted from ./phase3HistoricalRepairDerivePlan.ts
import type { PoolClient } from "pg";
import { MoneyDecimal } from "../../lib/money";

export interface Phase3RepairVoucherRef {
  voucherId: number;
  voucherNumber: string;
  voucherDate: string;
  effectiveDate: string | null;
}

export interface Phase3HistoricalRepairPlan {
  companyId: number;
  /** Legacy USD POs posted with no debit: a Purchases debit of the total is added. */
  purchaseDebits: (Phase3RepairVoucherRef & { amount: string })[];
  /** Company 1, voucher 3000: the four duplicate POS import lines removed. */
  duplicatePosEntries: { voucherId: number; entryIds: number[]; amount: string } | null;
  /** Credit/debit notes posted one-sided: the Inventory leg of their items' value is added. */
  noteInventoryLegs: (Phase3RepairVoucherRef & { voucherType: string; side: "debit" | "credit"; amount: string })[];
  /** Unbalanced PAYROLL-GEN periods rebuilt from their payrolls; duplicates retired. */
  payrollPeriods: { periodStart: string; periodEnd: string; survivorId: number; duplicateIds: number[] }[];
  /** Company 10's empty JOURNAL-ICB-ADJ header, soft-deleted. */
  legacyMarker: { voucherId: number } | null;
  skipped: { voucherId: number; voucherNumber: string; reason: "PERIOD_CLOSED" }[];
  planHash: string;
}

export const money = (value: string | number | null | undefined) => new MoneyDecimal(value ?? 0).toFixed(2);

export type LedgerOptions = {
  subType?: string | null;
  parentId?: number | null;
};

export async function assertVoucherBalanced(client: PoolClient, companyId: number, voucherId: number): Promise<void> {
  const checked = await client.query<{ debit: string; credit: string }>(
    `SELECT
       COALESCE(SUM(COALESCE(ve.base_debit_amount, ve.debit_amount, 0)),0)::text AS debit,
       COALESCE(SUM(COALESCE(ve.base_credit_amount, ve.credit_amount, 0)),0)::text AS credit
     FROM vouchers v
     LEFT JOIN voucher_entries ve ON ve.voucher_id = v.id
     WHERE v.company_id = $1 AND v.id = $2
     GROUP BY v.id`,
    [companyId, voucherId]
  );
  const row = checked.rows[0];
  if (!row || row.debit !== row.credit) {
    throw new Error(
      `Phase 3 repair left voucher ${voucherId} unbalanced (${row?.debit ?? "missing"}/${row?.credit ?? "missing"})`
    );
  }
}

export type VoucherRow = {
  id: number;
  voucher_number: string;
  voucher_date: string;
  effective_date: string | null;
};

/** The company's closed-books date, if any. */
export async function lockedThrough(client: PoolClient, companyId: number): Promise<string | null> {
  const result = await client.query<{ locked: string | null }>(
    `SELECT max(period_end_date)::text AS locked FROM fiscal_period_closures WHERE company_id = $1 AND status = 'CLOSED'`,
    [companyId]
  );
  return result.rows[0]?.locked ?? null;
}

/** In a closed period by its voucher date or COALESCE(effective_date, voucher_date). */
export function inClosedPeriod(
  locked: string | null,
  row: { voucher_date: string; effective_date: string | null }
): boolean {
  if (!locked) return false;
  return row.voucher_date <= locked || (row.effective_date ?? row.voucher_date) <= locked;
}

export const ref = (row: VoucherRow): Phase3RepairVoucherRef => ({
  voucherId: row.id,
  voucherNumber: row.voucher_number,
  voucherDate: row.voucher_date,
  effectiveDate: row.effective_date,
});

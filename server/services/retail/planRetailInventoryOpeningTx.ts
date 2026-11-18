// Extracted from ./retailInventoryJournal.ts to keep that module under the source-size cap.
import { createHash } from "node:crypto";
import type Decimal from "decimal.js";
import { eq, sql } from "drizzle-orm";
import { retailAccountingSettings, retailInventoryOpenings } from "@shared/schema";
import type { DatabaseOrTransaction, DbTransaction } from "../../db";
import { HttpError } from "../../lib/httpHandlers";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { companyBusinessDate } from "../accounting/companyBusinessDate";
import { ensureRetailAccountingSettingsTx } from "./retailFinancialService";
import { cents, retailSystemAccountIdTx } from "./retailLedgerPosting";

export const RETAIL_INVENTORY_ADJUSTMENT_ACCOUNT = "RETAIL-INVENTORY-ADJUSTMENT";

export const RETAIL_GRNI_ACCOUNT = "RETAIL-GRNI";

export const RETAIL_IN_TRANSIT_ACCOUNT = "RETAIL-IN-TRANSIT";

export const OPENING_EQUITY_ACCOUNT = "OPENING_BALANCE_EQUITY";

export const retailInventoryOpeningVoucherNumber = (companyId: number) => `RETAIL-INV-OPEN-${companyId}`;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function rows<T>(executor: DatabaseOrTransaction, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await executor.execute(query)).rows as unknown as T[];
}

// ---------------------------------------------------------------------------
// Opening

export const RETAIL_INVENTORY_OPENING_REFUSAL_MESSAGES = {
  RETAIL_INVENTORY_OPENING_ALREADY_APPLIED: "The Retail inventory opening has already been applied for this company.",
  RETAIL_INVENTORY_OPENING_PLAN_CHANGED:
    "The Retail inventory opening changed since it was reviewed; review it again before applying.",
  RETAIL_INVENTORY_OPENING_LATER_DOCUMENTS:
    "Retail stock documents are dated after the chosen opening date. Choose a later opening date.",
  RETAIL_INVENTORY_OPENING_FUTURE_DATE: "The Retail inventory opening date cannot be in the future.",
  RETAIL_IN_TRANSIT_TRANSFERS_PENDING: "Receive all dispatched Retail transfers before applying an inventory opening.",
} as const;

export type RetailInventoryOpeningRefusalCode = keyof typeof RETAIL_INVENTORY_OPENING_REFUSAL_MESSAGES;

export class RetailInventoryOpeningRefusal extends HttpError {
  constructor(readonly code: RetailInventoryOpeningRefusalCode) {
    super(code === "RETAIL_INVENTORY_OPENING_FUTURE_DATE" ? 400 : 409, RETAIL_INVENTORY_OPENING_REFUSAL_MESSAGES[code]);
    this.name = "RetailInventoryOpeningRefusal";
  }
  get body() {
    return { code: this.code, message: this.message };
  }
}

export async function retailInventoryOpeningTx(executor: DatabaseOrTransaction, companyId: number) {
  const [opening] = await executor
    .select()
    .from(retailInventoryOpenings)
    .where(eq(retailInventoryOpenings.companyId, companyId))
    .limit(1);
  return opening ?? null;
}

/** Exact Σ quantity × average_cost of the company's Retail stock rows. */
export async function retailStockSubLedgerValue(executor: DatabaseOrTransaction, companyId: number) {
  const [row] = await rows<{ value: string; rows: number; negative_rows: number }>(
    executor,
    sql`SELECT COALESCE(SUM(quantity * average_cost), 0)::text AS value, COUNT(*)::int AS rows,
               COUNT(*) FILTER (WHERE quantity < 0)::int AS negative_rows
          FROM retail_variant_inventory WHERE company_id = ${companyId}`
  );
  return { value: toMoney(row?.value ?? 0), rows: row?.rows ?? 0, negativeRows: row?.negative_rows ?? 0 };
}

/** The Retail inventory accounts of the company: every account its Retail settings rows name. */
export async function retailInventoryAccountIds(executor: DatabaseOrTransaction, companyId: number): Promise<number[]> {
  const found = await executor
    .selectDistinct({ id: retailAccountingSettings.inventoryAssetLedgerAccountId })
    .from(retailAccountingSettings)
    .where(eq(retailAccountingSettings.companyId, companyId));
  return found.map((row) => row.id).filter((id): id is number => typeof id === "number");
}

/** Σ signed opening + debit − credit of live, non-optional lines on the accounts (voucher date ≤ asOf when given). */
export async function ledgerBalanceOf(
  executor: DatabaseOrTransaction,
  companyId: number,
  accountIds: number[],
  asOf?: string
): Promise<Decimal> {
  if (!accountIds.length) return new MoneyDecimal(0);
  const ids = sql.join(
    accountIds.map((id) => sql`${id}`),
    sql`, `
  );
  const [lines] = await rows<{ net: string }>(
    executor,
    sql`SELECT COALESCE(SUM(ve.debit_amount - ve.credit_amount), 0)::text AS net
          FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
         WHERE v.company_id = ${companyId} AND v.deleted_at IS NULL AND COALESCE(v.optional, false) = false
           AND ve.ledger_account_id IN (${ids})
           ${asOf ? sql`AND COALESCE(v.effective_date, v.voucher_date) <= ${asOf}` : sql``}`
  );
  const [opening] = await rows<{ net: string }>(
    executor,
    sql`SELECT COALESCE(SUM(CASE WHEN opening_balance_side = 'Cr' THEN -opening_balance ELSE opening_balance END), 0)::text AS net
          FROM ledger_accounts WHERE company_id = ${companyId} AND id IN (${ids})`
  );
  return toMoney(lines?.net ?? 0).plus(toMoney(opening?.net ?? 0));
}

/** Retail stock movements dated after `dateISO` in the company's timezone. */
async function movementsAfter(executor: DatabaseOrTransaction, companyId: number, dateISO: string): Promise<number> {
  const [row] = await rows<{ count: number }>(
    executor,
    sql`SELECT COUNT(*)::int AS count
          FROM retail_stock_movements m
          LEFT JOIN company_settings cs ON cs.company_id = m.company_id
         WHERE m.company_id = ${companyId}
           AND (m.created_at AT TIME ZONE 'UTC' AT TIME ZONE COALESCE(NULLIF(cs.timezone, ''), 'UTC'))::date > ${dateISO}::date`
  );
  return row?.count ?? 0;
}

export interface RetailInventoryOpeningPlan {
  companyId: number;
  openingDate: string;
  subLedgerValue: string;
  stockRows: number;
  negativeRows: number;
  inventoryAccountId: number;
  inventoryAccountIds: number[];
  equityAccountId: number;
  ledgerBalance: string;
  /** Sub-ledger value less ledger balance: posted Dr inventory / Cr equity when positive. */
  amount: string;
  laterDocuments: number;
  alreadyApplied: { openingDate: string; voucherId: number | null } | null;
  blockers: RetailInventoryOpeningRefusalCode[];
  planHash: string;
}

/** The opening plan, in the caller's transaction (it resolves the Retail default accounts). */
export async function planRetailInventoryOpeningTx(
  tx: DbTransaction,
  companyId: number,
  openingDate: string
): Promise<RetailInventoryOpeningPlan> {
  if (!ISO_DATE.test(openingDate)) throw new HttpError(400, "Invalid date");
  const settings = await ensureRetailAccountingSettingsTx(tx, companyId, null);
  const inventoryAccountIds = [
    ...new Set([settings.inventoryAssetLedgerAccountId, ...(await retailInventoryAccountIds(tx, companyId))]),
  ].sort((a, b) => a - b);
  const equityAccountId = await retailSystemAccountIdTx(tx, companyId, OPENING_EQUITY_ACCOUNT);
  const stock = await retailStockSubLedgerValue(tx, companyId);
  const ledger = await ledgerBalanceOf(tx, companyId, inventoryAccountIds);
  const subLedgerValue = cents(stock.value);
  const ledgerBalance = cents(ledger);
  const amount = subLedgerValue.minus(ledgerBalance);
  const laterDocuments = await movementsAfter(tx, companyId, openingDate);
  const existing = await retailInventoryOpeningTx(tx, companyId);
  // Without an opening there are intentionally no live Retail stock journals.
  // Forbid cut-over while stock is travelling: otherwise dispatch would be
  // pre-opening and receipt post-opening, creating an unpaired inventory debit.
  const [pendingTransit] = await rows<{ pending: number }>(
    tx,
    sql`SELECT COUNT(*)::int AS pending FROM retail_stock_operations
        WHERE company_id = ${companyId} AND operation_type = 'transfer_dispatch'
          AND metadata->>'status' = 'otw'`
  );
  const today = await companyBusinessDate(companyId, tx);
  const blockers: RetailInventoryOpeningRefusalCode[] = [];
  if (existing) blockers.push("RETAIL_INVENTORY_OPENING_ALREADY_APPLIED");
  if (openingDate > today) blockers.push("RETAIL_INVENTORY_OPENING_FUTURE_DATE");
  if (laterDocuments > 0) blockers.push("RETAIL_INVENTORY_OPENING_LATER_DOCUMENTS");
  if ((pendingTransit?.pending ?? 0) > 0) blockers.push("RETAIL_IN_TRANSIT_TRANSFERS_PENDING");
  const [last] = await rows<{ id: number | null }>(
    tx,
    sql`SELECT MAX(id) AS id FROM retail_stock_movements WHERE company_id = ${companyId}`
  );
  const planHash = createHash("sha256")
    .update(
      JSON.stringify({
        companyId,
        openingDate,
        subLedgerValue: subLedgerValue.toFixed(2),
        ledgerBalance: ledgerBalance.toFixed(2),
        amount: amount.toFixed(2),
        inventoryAccountId: settings.inventoryAssetLedgerAccountId,
        inventoryAccountIds,
        equityAccountId,
        lastMovementId: last?.id ?? null,
      })
    )
    .digest("hex");
  return {
    companyId,
    openingDate,
    subLedgerValue: subLedgerValue.toFixed(2),
    stockRows: stock.rows,
    negativeRows: stock.negativeRows,
    inventoryAccountId: settings.inventoryAssetLedgerAccountId,
    inventoryAccountIds,
    equityAccountId,
    ledgerBalance: ledgerBalance.toFixed(2),
    amount: amount.toFixed(2),
    laterDocuments,
    alreadyApplied: existing ? { openingDate: String(existing.openingDate), voucherId: existing.voucherId } : null,
    blockers,
    planHash,
  };
}

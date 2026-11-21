// Extracted from ./stockAdjustmentBackfillReversal.ts
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { type DatabaseOrTransaction } from "../../db";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { companyBusinessDate } from "./companyBusinessDate";
import {
  STOCK_ADJUSTMENT_BACKFILL_NARRATION_PATTERN,
  stockAdjustmentBackfillReversalNumber,
} from "./perpetualInventory/stockAdjustments";
import { diagnoseSystemAccounts } from "./systemAccounts";

export const BACKFILL_REVERSAL_OFFSET_CODES = ["OPENING_BALANCE_EQUITY", "INVENTORY_ADJUSTMENT"] as const;

export type BackfillReversalOffsetCode = (typeof BACKFILL_REVERSAL_OFFSET_CODES)[number];

/** The shortest reason accepted for reversing a company that is not a supplier partner. */
export const BACKFILL_REVERSAL_MIN_REASON = 10;

export const BACKFILL_REVERSAL_MESSAGES = {
  NOT_SUPPLIER_PARTNER:
    "This company is not a supplier partner: the opening inventory journal absorbs its backfill lines. Reverse them only with an explicit request and a reason.",
  REASON_REQUIRED: "A reason of at least 10 characters is required to reverse the backfill of this company.",
  OFFSET_ACCOUNT_UNAVAILABLE: "The contra account of the reversal is deleted; restore it before applying.",
  PERIOD_CLOSED: "The reversal date is in a closed fiscal period.",
  NOTHING_TO_APPLY: "There is no backfill line left to reverse.",
  PLAN_CHANGED: "The backfill reversal changed since it was reviewed; review it again before applying.",
} as const;

export type BackfillReversalBlocker = Exclude<keyof typeof BACKFILL_REVERSAL_MESSAGES, "PLAN_CHANGED">;

export interface BackfillReversalOptions {
  offset?: BackfillReversalOffsetCode;
  allowNonSupplierPartner?: boolean;
  reason?: string | null;
}

type Side = { debit: string; credit: string };

export interface BackfillReversalPlan {
  companyId: number;
  supplierPartner: boolean;
  override: { allowNonSupplierPartner: boolean; reason: string | null };
  voucherDate: string;
  offsetAccount: { code: BackfillReversalOffsetCode; id: number | null; action: "use" | "create" };
  vouchers: {
    voucherId: number;
    voucherNumber: string;
    voucherType: string;
    voucherDate: string;
    reversalVoucherNumber: string;
    backfillLines: ({ entryId: number } & Side)[];
    /** The reversing journal: each backfill line swapped, then the contra for their net. */
    journal: {
      account: "INVENTORY" | BackfillReversalOffsetCode;
      /** The ledger account (null: the contra account the apply creates). */
      ledgerAccountId: number | null;
      /** The backfill line it reverses (null: the contra line). */
      entryId: number | null;
      debit: string;
      credit: string;
    }[];
  }[];
  alreadyReversed: { voucherId: number; voucherNumber: string; reversalVoucherId: number; lines: number }[];
  skipped: { voucherId: number; voucherNumber: string; reason: "NON_USD_VOUCHER" }[];
  total: { vouchers: number; lines: number; inventoryDebit: string; inventoryCredit: string };
  blockers: BackfillReversalBlocker[];
  planHash: string;
}

type LineRow = {
  entry_id: number;
  voucher_id: number;
  voucher_number: string;
  voucher_type: string;
  voucher_date: string;
  inventory_account_id: number;
  debit: string;
  credit: string;
  is_foreign: boolean;
  reversal_id: number | null;
} & Record<string, unknown>;

export const ZERO = new MoneyDecimal(0);

export const money = (value: Decimal) => value.toFixed(2);

function normalizeOptions(options: BackfillReversalOptions) {
  const offset: BackfillReversalOffsetCode = options.offset ?? "OPENING_BALANCE_EQUITY";
  if (!BACKFILL_REVERSAL_OFFSET_CODES.includes(offset)) throw new Error("Unknown reversal contra account");
  const allowNonSupplierPartner = options.allowNonSupplierPartner === true;
  const reason = typeof options.reason === "string" && options.reason.trim() ? options.reason.trim() : null;
  return { offset, allowNonSupplierPartner, reason };
}

export async function derivePlanPart1(
  executor: DatabaseOrTransaction,
  companyId: number,
  options: BackfillReversalOptions
) {
  const { offset, allowNonSupplierPartner, reason } = normalizeOptions(options);
  const company = await executor.execute<{ company_type: string | null } & Record<string, unknown>>(
    sql`SELECT company_type FROM companies WHERE id = ${companyId}`
  );
  const supplierPartner = company.rows[0]?.company_type === "supplier_partner";

  const offsetStatus = (await diagnoseSystemAccounts(executor, companyId)).find((status) => status.code === offset);
  const offsetDeleted = offsetStatus?.state === "deleted";
  const offsetAccount: BackfillReversalPlan["offsetAccount"] =
    offsetStatus && offsetStatus.state !== "missing" && offsetStatus.state !== "deleted"
      ? { code: offset, id: offsetStatus.accountId, action: "use" }
      : { code: offset, id: null, action: "create" };

  const voucherDate = await companyBusinessDate(companyId, executor);
  const closed = await executor.execute<{ closed: boolean } & Record<string, unknown>>(sql`
    SELECT COALESCE(MAX(period_end_date) >= ${voucherDate}::date, false) AS closed
      FROM fiscal_period_closures WHERE company_id = ${companyId} AND status = 'CLOSED'`);
  const periodClosed = Boolean(closed.rows[0]?.closed);

  const lines = await executor.execute<LineRow>(sql`
    SELECT ve.id AS entry_id, v.id AS voucher_id, v.voucher_number, v.voucher_type,
           v.voucher_date::text AS voucher_date, la.id AS inventory_account_id,
           COALESCE(ve.debit_amount, 0)::text AS debit, COALESCE(ve.credit_amount, 0)::text AS credit,
           (upper(COALESCE(NULLIF(btrim(v.currency), ''), 'USD')) <> 'USD'
             OR upper(COALESCE(ve.transaction_currency, 'USD')) <> 'USD') AS is_foreign,
           (SELECT r.id FROM vouchers r
             WHERE r.company_id = v.company_id
               AND r.voucher_number = 'STOCKADJ-BACKFILL-REV-' || v.id::text
               AND r.deleted_at IS NULL AND COALESCE(r.optional, false) = false
             ORDER BY r.id LIMIT 1) AS reversal_id
      FROM voucher_entries ve
      JOIN vouchers v ON v.id = ve.voucher_id
      JOIN ledger_accounts la ON la.id = ve.ledger_account_id AND la.company_id = v.company_id
     WHERE v.company_id = ${companyId}
       AND v.deleted_at IS NULL AND COALESCE(v.optional, false) = false
       AND la.code = 'INVENTORY'
       AND ve.narration LIKE ${STOCK_ADJUSTMENT_BACKFILL_NARRATION_PATTERN}
       AND EXISTS (SELECT 1 FROM stock_adjustment_vouchers sav WHERE sav.voucher_id = v.id)
     ORDER BY v.id, ve.id`);

  const byVoucher = new Map<number, LineRow[]>();
  for (const row of lines.rows) {
    const group = byVoucher.get(row.voucher_id) ?? [];
    group.push(row);
    byVoucher.set(row.voucher_id, group);
  }

  const vouchers: BackfillReversalPlan["vouchers"] = [];
  const alreadyReversed: BackfillReversalPlan["alreadyReversed"] = [];
  const skipped: BackfillReversalPlan["skipped"] = [];
  let inventoryDebit = ZERO;
  let inventoryCredit = ZERO;
  let lineCount = 0;
  for (const [voucherId, group] of byVoucher) {
    const head = group[0];
    if (head.reversal_id !== null) {
      alreadyReversed.push({
        voucherId,
        voucherNumber: head.voucher_number,
        reversalVoucherId: Number(head.reversal_id),
        lines: group.length,
      });
      continue;
    }
    if (group.some((row) => row.is_foreign)) {
      skipped.push({ voucherId, voucherNumber: head.voucher_number, reason: "NON_USD_VOUCHER" });
      continue;
    }
    const journal: BackfillReversalPlan["vouchers"][number]["journal"] = [];
    let net = ZERO;
    for (const row of group) {
      // The reversal swaps the backfill line's sides.
      const debit = toMoney(row.credit).toDecimalPlaces(2);
      const credit = toMoney(row.debit).toDecimalPlaces(2);
      journal.push({
        account: "INVENTORY",
        ledgerAccountId: row.inventory_account_id,
        entryId: row.entry_id,
        debit: money(debit),
        credit: money(credit),
      });
      inventoryDebit = inventoryDebit.plus(debit);
      inventoryCredit = inventoryCredit.plus(credit);
      net = net.plus(debit).minus(credit);
    }
    if (!net.isZero()) {
      journal.push({
        account: offset,
        ledgerAccountId: offsetAccount.id,
        entryId: null,
        debit: money(net.isNegative() ? net.negated() : ZERO),
        credit: money(net.isPositive() ? net : ZERO),
      });
    }
    lineCount += group.length;
    vouchers.push({
      voucherId,
      voucherNumber: head.voucher_number,
      voucherType: head.voucher_type,
      voucherDate: head.voucher_date,
      reversalVoucherNumber: stockAdjustmentBackfillReversalNumber(voucherId),
      backfillLines: group.map((row) => ({
        entryId: row.entry_id,
        debit: money(toMoney(row.debit)),
        credit: money(toMoney(row.credit)),
      })),
      journal,
    });
  }

  const blockers: BackfillReversalBlocker[] = [];
  if (!supplierPartner && !allowNonSupplierPartner) blockers.push("NOT_SUPPLIER_PARTNER");
  if (!supplierPartner && allowNonSupplierPartner && (reason?.length ?? 0) < BACKFILL_REVERSAL_MIN_REASON) {
    blockers.push("REASON_REQUIRED");
  }
  if (offsetDeleted) blockers.push("OFFSET_ACCOUNT_UNAVAILABLE");
  if (vouchers.length > 0 && periodClosed) blockers.push("PERIOD_CLOSED");
  if (vouchers.length === 0) blockers.push("NOTHING_TO_APPLY");

  const body = {
    companyId,
    supplierPartner,
    override: { allowNonSupplierPartner, reason },
    voucherDate,
    offsetAccount,
    vouchers,
    alreadyReversed,
    skipped,
    total: {
      vouchers: vouchers.length,
      lines: lineCount,
      inventoryDebit: money(inventoryDebit),
      inventoryCredit: money(inventoryCredit),
    },
    blockers,
  };
  return { body };
}

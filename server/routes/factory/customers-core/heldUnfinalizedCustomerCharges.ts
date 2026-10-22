/**
 * Ledger debits from customer-order charges created BEFORE finalization.
 *
 * The original CHARGE-PRE vouchers were real ledger postings even though the
 * invoice had not been finalized. Factory customer statements already hold
 * these debits out of the visible balance. Parties and Net Position must do
 * the same until the vouchers are retired through an audited reconciliation.
 *
 * Only positive, customer-owned Journal debits explicitly attributable to a
 * non-finalized order are held. Payments, credits, unconnected journals,
 * and finalized invoices are never suppressed. This is a display projection;
 * the general ledger / trial balance remains unchanged for audit.
 */
import { sql } from "drizzle-orm";
import type Decimal from "decimal.js";
import { db } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import type { FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";
import {
  netPositionKnownTransactionThrough,
  netPositionRecordedThrough,
  netPositionVoucherEntryKnown,
} from "../../../services/factory/netPositionAsOf";

const ZERO = new MoneyDecimal(0);

export interface HeldChargeSnapshot {
  byCustomer: Map<number, Decimal>;
  voucherIds: Set<number>;
}

export async function loadHeldChargeSnapshot(
  companyId: number,
  customerIds: readonly number[],
  asOf?: string | null,
  knownAt?: FactoryNetPositionAsOf
): Promise<HeldChargeSnapshot> {
  const ids = [...new Set(customerIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) return { byCustomer: new Map(), voucherIds: new Set() };
  const idList = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `
  );
  const dateCut = knownAt
    ? sql`AND ${netPositionKnownTransactionThrough(
        sql`COALESCE(v.effective_date, v.voucher_date)`,
        sql`v.created_at`,
        knownAt,
        "utc-naive-timestamp"
      )}`
    : asOf
      ? sql`AND COALESCE(v.effective_date, v.voucher_date) <= ${asOf}::date`
      : sql``;
  const visibleVoucher = knownAt
    ? sql`(v.deleted_at IS NULL OR NOT ${netPositionRecordedThrough(sql`v.deleted_at`, knownAt, "utc-naive-timestamp")})`
    : sql`v.deleted_at IS NULL`;
  const orderRecorded = knownAt
    ? sql`AND ${netPositionRecordedThrough(sql`created_at`, knownAt, "utc-naive-timestamp")}`
    : sql``;
  const unfinishedThen = knownAt
    ? sql`(status <> 'FINALIZED' OR finalized_at IS NULL OR NOT ${netPositionRecordedThrough(sql`finalized_at`, knownAt, "utc-naive-timestamp")})`
    : sql`status <> 'FINALIZED'`;
  const entryRecorded = knownAt
    ? sql`AND ${netPositionVoucherEntryKnown(sql`ve.created_at`, sql`ve.voucher_id`, knownAt)}`
    : sql``;

  const result = await db.execute(sql`
    WITH unfinalized_orders AS (
      SELECT id, customer_id, UPPER(BTRIM(COALESCE(container_number, ''))) AS container_number
        FROM customer_orders
       WHERE company_id = ${companyId} AND ${unfinishedThen}
         ${orderRecorded}
         AND customer_id IN (${idList})
    ), eligible_vouchers AS (
      SELECT v.id, v.voucher_number, v.description
        FROM vouchers v
       WHERE v.company_id = ${companyId} AND ${visibleVoucher}
         AND v.optional = false AND LOWER(v.voucher_type) = 'journal'
         ${dateCut}
    ), matched AS (
      -- Charges linked to their voucher, including legacy invoices using a
      -- non-PRE voucher number (one voucher counts once, not once per charge).
      SELECT o.customer_id, v.id AS voucher_id
        FROM unfinalized_orders o
        JOIN customer_order_charges ch ON ch.order_id = o.id
        JOIN eligible_vouchers v
          ON v.id = ch.voucher_id
          OR v.voucher_number = 'CHARGE-PRE-' || o.id::text || '-' || ch.id::text
      UNION
      -- Older PRE vouchers can lack their charge FK or charge record.
      SELECT o.customer_id, v.id
        FROM unfinalized_orders o
        JOIN eligible_vouchers v
          ON v.voucher_number ~ ('^CHARGE-PRE-' || o.id::text || '-[0-9]+$')
      UNION
      -- Legacy manual freight/clearance vouchers: only a uniquely identified
      -- container qualifies. Do not guess where the container is ambiguous.
      SELECT o.customer_id, m.voucher_id
        FROM unfinalized_orders o
        JOIN (
          SELECT v.id AS voucher_id,
                 UPPER((regexp_match(
                   BTRIM(COALESCE(NULLIF(ve.narration, ''), v.description, '')),
                   '^(?:freight|clearance|customs|handling|port charges?|document charges?|other charges?)[[:space:]]+for[[:space:]]+(?:offloaded[[:space:]]+)?container[[:space:]]*[-:][[:space:]]*([A-Z]{4}[0-9]{7})[[:space:]]*$',
                   'i'
                 ))[1]) AS container_number
            FROM eligible_vouchers v
            JOIN voucher_entries ve ON ve.voucher_id = v.id
           WHERE COALESCE(ve.debit_amount, 0) > 0
             AND COALESCE(ve.credit_amount, 0) = 0
             AND (ve.narration ILIKE '%container%' OR v.description ILIKE '%container%')
        ) m ON m.container_number = o.container_number
       WHERE o.container_number <> ''
         AND (SELECT COUNT(*) FROM customer_orders all_orders
               WHERE all_orders.company_id = ${companyId}
                 AND UPPER(BTRIM(COALESCE(all_orders.container_number, ''))) = o.container_number) = 1
    )
    SELECT m.customer_id, m.voucher_id,
           COALESCE(SUM(COALESCE(ve.debit_amount,0) - COALESCE(ve.credit_amount,0)), 0)::text AS amount
      FROM (SELECT DISTINCT customer_id, voucher_id FROM matched) m
      JOIN customers c ON c.id = m.customer_id AND c.company_id = ${companyId}
      JOIN voucher_entries ve ON ve.voucher_id = m.voucher_id
     WHERE COALESCE(ve.debit_amount, 0) > 0
       AND COALESCE(ve.credit_amount, 0) = 0
       ${entryRecorded}
       AND (
         (c.ledger_account_id IS NOT NULL AND ve.ledger_account_id = c.ledger_account_id)
         OR (
           ve.customer_id = c.id
           AND ve.ledger_account_id IS NULL
           AND ve.bank_account_id IS NULL AND ve.fixed_asset_id IS NULL
           AND ve.supplier_id IS NULL AND ve.employee_id IS NULL
           AND ve.factory_supplier_id IS NULL
         )
       )
     GROUP BY m.customer_id, m.voucher_id
  `);

  const held = new Map<number, Decimal>();
  const voucherIds = new Set<number>();
  for (const row of result.rows as Array<{
    customer_id: number | string;
    voucher_id: number | string;
    amount: string;
  }>) {
    const customerId = Number(row.customer_id);
    const voucherId = Number(row.voucher_id);
    const value = toMoney(row.amount);
    if (!Number.isSafeInteger(customerId) || value.isZero()) continue;
    held.set(customerId, (held.get(customerId) ?? ZERO).plus(value));
    if (Number.isSafeInteger(voucherId)) voucherIds.add(voucherId);
  }
  return { byCustomer: held, voucherIds };
}

export async function heldUnfinalizedCustomerCharges(
  companyId: number,
  customerIds: readonly number[],
  asOf?: string | null,
  knownAt?: FactoryNetPositionAsOf
): Promise<Map<number, Decimal>> {
  return (await loadHeldChargeSnapshot(companyId, customerIds, asOf, knownAt)).byCustomer;
}

/**
 * Display-only projection for the generic Accounts/Agents customer statements.
 * Factory Parties and the dedicated customer statement already hold these
 * legacy debits; linked-ledger statements must not show a different balance.
 * Vouchers, voucher entries and the trial balance are never changed here.
 */
export async function projectCustomerStatementLines<T extends { voucherId: number | null }>(
  companyId: number,
  customerId: number,
  rows: readonly T[],
  from: string | null | undefined,
  to: string | null | undefined
): Promise<{ rows: T[]; heldBefore: Decimal }> {
  const snapshot = await loadHeldChargeSnapshot(companyId, [customerId], to);
  const visibleRows = rows.filter((row) => !snapshot.voucherIds.has(Number(row.voucherId)));
  let heldBefore = ZERO;
  if (from) {
    // The statement brought-forward amount covers dates strictly before from.
    // Use a date-only UTC predecessor rather than subtracting from the time of day.
    const date = Date.parse(`${from}T00:00:00Z`);
    if (!Number.isFinite(date)) throw new Error("invalid_factory_statement_start_date");
    const before = new Date(date - 86400000).toISOString().slice(0, 10);
    const earlier = await loadHeldChargeSnapshot(companyId, [customerId], before);
    heldBefore = earlier.byCustomer.get(customerId) ?? ZERO;
  }
  return { rows: visibleRows, heldBefore };
}

export function customerStatementLedgerBalance(
  generalLedger: Decimal,
  heldPreFinalizationCharges: Decimal = ZERO
): Decimal {
  return generalLedger.minus(heldPreFinalizationCharges);
}

// Extracted from ./unpostedMemo.ts to keep that module under the source-size cap.
import { lte, sql } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../../../db";
import type { FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";
import { netPositionKnownTransactionThrough, netPositionRecordedThrough } from "../../factory/netPositionAsOf";

export type MemoPartyKind = "customer" | "factorySupplier";

export type MemoSource =
  | "factoryInvoice"
  | "factoryPosCreditSale"
  | "factoryPosDeposit"
  | "customerBalanceCache"
  | "factoryContainerGoods"
  | "factoryContainerFreight"
  | "factoryContainerCommission"
  | "factoryRawStockCommission"
  | "factoryCommissionRecord";

/** What each source is, as shown next to a balance (the reference names the document). */
export const MEMO_SOURCE_LABELS: Record<MemoSource, string> = {
  factoryInvoice: "Factory invoices not yet in the ledger",
  factoryPosCreditSale: "Factory POS credit sales not yet in the ledger",
  factoryPosDeposit: "Deposits on factory POS credit sales not yet in the ledger",
  customerBalanceCache: "Other customer balance records not in the ledger",
  factoryContainerGoods: "Container goods not yet in the ledger (legacy containers)",
  factoryContainerFreight: "Supplier-paid container freight not yet in the ledger",
  factoryContainerCommission: "Container commission not yet in the ledger",
  factoryRawStockCommission: "Opening-balance raw stock commission not yet in the ledger",
  factoryCommissionRecord: "Offload commission record not carried by its container, not in the ledger",
};

/** A container amount in a currency with no confirmed rate (listed, not totalled). */
export const MEMO_NO_RATE_LABEL = "Container amount not yet in the ledger, in a currency without a confirmed rate";

/** An amount that belongs next to a party's balance but is not in the ledger. */
export interface PartyBalanceMemoLine {
  source: MemoSource;
  /** The operational document: invoice number, cache reference, container number. */
  reference: string | null;
  /** The row it comes from (order, customer_balances row, container id). */
  sourceId: number;
  /** YYYY-MM-DD. */
  date: string;
  /** USD, debit positive (owed to us positive); null when no rate is stored for its currency. */
  amount: string | null;
  /** The amount in its own currency, debit positive. */
  nativeAmount: string;
  currency: string;
  /** Human-readable label: what the amount is and why it is not in the ledger. */
  label: string;
  /** Always true: the line is outside the ledger balance. */
  notInLedger: true;
}

export interface MemoQuery {
  knownAt?: FactoryNetPositionAsOf;
  companyId: number;
  kind: MemoPartyKind;
  ids: readonly number[];
  asOf?: string | null;
}

export type Executor = DatabaseOrTransaction;

export async function rowsOf<T>(executor: Executor, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await executor.execute(query)).rows as unknown as T[];
}

export function idList(ids: readonly number[]) {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `
  );
}

export function dateCut(column: ReturnType<typeof sql>, asOf: string | null | undefined) {
  return asOf ? sql` AND ${column} <= ${asOf}::date` : sql``;
}

/**
 * The voucher alias is booked (COALESCE(effective_date, voucher_date)) on or
 * before `asOf` — in the ledger at that date (wave 17 A). Without `asOf`,
 * every posted voucher counts.
 */
export function bookedBy(alias: "mv" | "cv" | "rv", asOf: string | null | undefined, knownAt?: FactoryNetPositionAsOf) {
  if (knownAt)
    return sql` AND ${netPositionKnownTransactionThrough(
      sql.raw(`COALESCE(${alias}.effective_date, ${alias}.voucher_date)`),
      sql.raw(`${alias}.created_at`),
      knownAt,
      "utc-naive-timestamp"
    )}`;
  if (!asOf) return sql``;
  return sql` AND ${lte(sql.raw(`COALESCE(${alias}.effective_date, ${alias}.voucher_date)`), asOf)}`;
}

type NumberCondition = (voucherNumber: ReturnType<typeof sql>) => ReturnType<typeof sql>;

/**
 * The voucher's number matches. A voucher retired after the cutoff was renamed
 * `{number}~DEL{id}` then, so as of the cutoff it still carried the number in
 * original_voucher_number; today's report only sees live numbers. Kept as two
 * separate conditions: one OR across both columns defeats the number index.
 */
function numberMatches(alias: "mv" | "cv", matches: NumberCondition, retired: boolean) {
  return retired
    ? sql`${sql.raw(`${alias}.voucher_number`)} LIKE '%~DEL%' AND ${matches(sql.raw(`${alias}.original_voucher_number`))}`
    : matches(sql.raw(`${alias}.voucher_number`));
}

/**
 * A live voucher of the company whose number matches `pattern` (SQL LIKE or
 * equality), booked on or before `asOf` (wave 17 A): an invoice whose voucher
 * is dated after the as-of date is not yet in the ledger at that date, so it
 * is a memo line of that date's balance.
 */
export function liveVoucherExists(
  matches: NumberCondition,
  companyColumn: ReturnType<typeof sql>,
  asOf: string | null | undefined,
  knownAt?: FactoryNetPositionAsOf
) {
  const deleted = knownAt
    ? sql`(mv.deleted_at IS NULL OR NOT ${netPositionRecordedThrough(sql`mv.deleted_at`, knownAt, "utc-naive-timestamp")})`
    : sql`mv.deleted_at IS NULL`;
  const exists = (retired: boolean) => sql`EXISTS (
    SELECT 1 FROM vouchers mv
     WHERE mv.company_id = ${companyColumn} AND ${deleted} AND mv.optional = false
       AND ${numberMatches("mv", matches, retired)}${bookedBy("mv", asOf, knownAt)}
  )`;
  return knownAt ? sql`(${exists(false)} OR ${exists(true)})` : exists(false);
}

interface CustomerMemoRow {
  party_id: number;
  source: MemoSource;
  reference: string | null;
  source_id: number;
  date: string;
  native: string;
  currency: string | null;
  extra: string | null;
}

export async function customerMemoRows(executor: Executor, query: MemoQuery): Promise<CustomerMemoRow[]> {
  const { companyId, ids, asOf, knownAt } = query;
  // The invoice exists from its finalization, by the company-local cutoff
  // (the business-date cut below uses the UTC date of the same timestamp).
  const invoiceCreated = knownAt
    ? sql`AND ${netPositionRecordedThrough(sql`co.created_at`, knownAt, "utc-naive-timestamp")}
          AND (co.finalized_at IS NULL OR ${netPositionRecordedThrough(sql`co.finalized_at`, knownAt, "utc-naive-timestamp")})`
    : sql``;
  const cacheCreated = knownAt
    ? sql`AND ${netPositionRecordedThrough(sql`cb.created_at`, knownAt, "utc-naive-timestamp")}`
    : sql``;
  const invoiceNotDeleted = knownAt
    ? sql`(co.deleted_at IS NULL OR NOT ${netPositionRecordedThrough(sql`co.deleted_at`, knownAt, "utc-naive-timestamp")})`
    : sql`co.deleted_at IS NULL`;
  const cvNotDeleted = knownAt
    ? sql`(cv.deleted_at IS NULL OR NOT ${netPositionRecordedThrough(sql`cv.deleted_at`, knownAt, "utc-naive-timestamp")})`
    : sql`cv.deleted_at IS NULL`;
  const chargeNumber: NumberCondition = (n) => sql`(${n} = 'CHARGE-PRE-' || co.id::text || '-' || ch.id::text
    OR ${n} LIKE 'CHARGE-' || co.invoice_number || '-' || ch.id::text || '-%')`;
  const chargeNumberMatches = knownAt
    ? sql`(${numberMatches("cv", chargeNumber, false)} OR (${numberMatches("cv", chargeNumber, true)}))`
    : numberMatches("cv", chargeNumber, false);
  const invoiceDate = sql`COALESCE(co.finalized_at, co.created_at)::date`;
  // A finalized Factory multi-truck invoice ALREADY reached the ledger through
  // the original FDTR receivables and the FDINV clearing transfer. It does NOT
  // create a second INV-GL journal. Exclude it from "not yet posted" memos
  // instead of incorrectly reporting the full invoice amount a second time.
  const [dispatchSchema] = await rowsOf<{ present: boolean }>(
    executor,
    sql`
    SELECT to_regclass('public.factory_dispatch_order_consolidations') IS NOT NULL AS present
  `
  );
  const consolidatedAlreadyPosted = dispatchSchema?.present
    ? sql`
    AND NOT EXISTS (
      SELECT 1 FROM factory_dispatch_order_consolidations dc
       WHERE dc.company_id=co.company_id AND dc.order_id=co.id
         AND dc.status='FINALIZED' AND dc.invoice_number=co.invoice_number
    )
  `
    : sql``;
  const invoices = rowsOf<CustomerMemoRow>(
    executor,
    sql`
      SELECT co.customer_id AS party_id, 'factoryInvoice' AS source,
             COALESCE(co.invoice_number, 'Order #' || co.id::text) AS reference, co.id AS source_id,
             ${invoiceDate}::text AS date,
             (COALESCE(co.grand_total, 0) - COALESCE((
                SELECT SUM(ch.amount) FROM customer_order_charges ch
                  JOIN vouchers cv ON cv.company_id = co.company_id
                                  AND ${cvNotDeleted} AND cv.optional = false${bookedBy("cv", asOf, knownAt)}
                                  AND (
                                    cv.id = ch.voucher_id
                                    OR (
                                      ch.voucher_id IS NULL
                                      AND (
                                        ${chargeNumberMatches}
                                      )
                                      AND EXISTS (
                                        SELECT 1 FROM voucher_entries ve
                                         WHERE ve.voucher_id = cv.id
                                           AND ve.customer_id = co.customer_id
                                           AND ABS(COALESCE(ve.debit_amount, 0) - COALESCE(ve.credit_amount, 0) - ch.amount) < 0.005
                                      )
                                    )
                                  )
                 WHERE ch.order_id = co.id
             ), 0))::text AS native,
             UPPER(COALESCE(b.currency, 'USD')) AS currency,
             co.grand_total::text AS extra
        FROM customer_orders co
        LEFT JOIN customer_dispatch_batches b ON b.id = co.dispatch_batch_id AND b.company_id = co.company_id
       WHERE co.company_id = ${companyId} AND co.status = 'FINALIZED' AND ${invoiceNotDeleted}
         ${consolidatedAlreadyPosted}
         AND co.customer_id IN (${idList(ids)})
         ${invoiceCreated}
         AND NOT ${liveVoucherExists(
           (n) => sql`${n} = 'INV-GL-' || co.company_id::text || '-' || co.id::text`,
           sql`co.company_id`,
           asOf,
           knownAt
         )}
         ${dateCut(invoiceDate, asOf)}
    `
  );
  const cache = rowsOf<CustomerMemoRow>(
    executor,
    sql`
      SELECT cb.customer_id AS party_id,
             CASE cb.reference_type
               WHEN 'FACTORY_POS_SALE' THEN 'factoryPosCreditSale'
               WHEN 'FACTORY_POS_DEPOSIT' THEN 'factoryPosDeposit'
               ELSE 'customerBalanceCache'
             END AS source,
             CASE WHEN cb.reference_type IS NOT NULL
                  THEN cb.reference_type || '-' || COALESCE(cb.reference_id, cb.id)::text
                  ELSE 'CB-' || cb.id::text END AS reference,
             cb.id AS source_id,
             cb.transaction_date::date::text AS date,
             (COALESCE(cb.debit_amount, 0) - COALESCE(cb.credit_amount, 0))::text AS native,
             UPPER(COALESCE(cb.currency, 'USD')) AS currency,
             cb.description AS extra
        FROM customer_balances cb
       WHERE cb.company_id = ${companyId} AND cb.customer_id IN (${idList(ids)})
         ${cacheCreated}
         -- NULL-safe: a legacy row with no reference type is still a cache-only row.
         AND NOT (cb.reference_type IS NOT DISTINCT FROM 'INVOICE' AND cb.transaction_type IS NOT DISTINCT FROM 'SALE')
         AND cb.reference_type IS DISTINCT FROM 'CONTAINER_SALE'
         AND NOT (cb.reference_type IN ('FACTORY_POS_SALE', 'FACTORY_POS_DEPOSIT') AND EXISTS (
               SELECT 1 FROM factory_pos_sales ps
                WHERE ps.id = cb.reference_id AND ps.company_id = cb.company_id
                  AND (ps.status = 'VOIDED' OR ${liveVoucherExists(
                    (n) => sql`${n} = 'FPOS-RCPT-' || ps.id::text`,
                    sql`ps.company_id`,
                    asOf,
                    knownAt
                  )})))
         AND NOT (cb.reference_type = 'voucher' AND EXISTS (
               SELECT 1 FROM vouchers rv
                WHERE rv.id = cb.reference_id AND rv.company_id = cb.company_id
                  AND ${knownAt ? sql`(rv.deleted_at IS NULL OR NOT ${netPositionRecordedThrough(sql`rv.deleted_at`, knownAt, "utc-naive-timestamp")})` : sql`rv.deleted_at IS NULL`} AND rv.optional = false${bookedBy("rv", asOf, knownAt)}))
         ${dateCut(sql`cb.transaction_date::date`, asOf)}
    `
  );
  return [...(await invoices), ...(await cache)];
}

export function customerLabel(row: CustomerMemoRow): string {
  const currency = row.currency ?? "USD";
  switch (row.source) {
    case "factoryInvoice":
      return currency !== "USD"
        ? `Factory invoice ${row.reference}: not yet in the ledger (${currency} invoice, no exchange rate to post at)`
        : `Factory invoice ${row.reference}: not yet in the ledger (finalized before the perpetual-inventory cut-over)`;
    case "factoryPosCreditSale":
      return `Factory POS credit sale ${row.extra ?? row.reference}: not yet in the ledger`;
    case "factoryPosDeposit":
      return `Deposit on a factory POS credit sale (${row.extra ?? row.reference}): not yet in the ledger`;
    default:
      return `${row.extra || row.reference}: customer balance record not in the ledger`;
  }
}

export interface ContainerMemoRow {
  id: number;
  container_number: string;
  supplier_id: number | null;
  /** The party the commission is owed to: the commission supplier, else the container's supplier. */
  commission_party_id: number | null;
  date: string;
  status: string | null;
  currency_code: string | null;
  fx_rate_to_usd: string | null;
  fx_rate_confirmed: boolean | null;
  goods: string | null;
  goods_posted: boolean;
  opening_already_in_supplier_master: boolean;
  freight: string | null;
  freight_currency_code: string | null;
  freight_fx_rate_to_usd: string | null;
  freight_fx_rate_confirmed: boolean | null;
  freight_paid_by: string | null;
  freight_supplier_id: number | null;
  freight_posted: boolean;
  commission_amount: string | null;
  commission_currency_code: string | null;
  commission_fx_rate_to_usd: string | null;
  commission_fx_rate_confirmed: boolean | null;
  commission_posted: boolean;
}

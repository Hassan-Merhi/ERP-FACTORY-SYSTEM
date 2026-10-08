/**
 * "Not yet in the ledger" memo lines (accounting audit wave 10, owner rule 3).
 *
 * Balances come from the ledger only. Some amounts a party owes or is owed
 * never reached the ledger; they are listed here, next to the party's ledger
 * balance, clearly labelled, and never added into it:
 *
 * Customers
 *   - factoryInvoice: a FINALIZED factory invoice (customer order, including a
 *     dispatch-batch invoice) with no live INV-GL-{company}-{order} journal:
 *     invoices finalized before the company's perpetual-inventory cut-over and
 *     invoices in a currency other than USD (no rate to post at). The amount
 *     is the grand total less the charges that already have their own live
 *     CHARGE- voucher (those debit the customer ledger), which is exactly the
 *     receivable the INV-GL journal would post (perpetualInventory/factoryInvoice.ts).
 *   - factoryPosCreditSale / factoryPosDeposit: factory POS credit sales and
 *     their deposits, written only to the customer_balances cache (the POS
 *     receipt voucher debits cash and credits sales income for the deposit; it
 *     never touches the customer).
 *   - customerBalanceCache: any other customer_balances row with no ledger
 *     counterpart, e.g. a legacy payment recorded against an invoice, or a
 *     credit-sale import row whose voucher was deleted.
 *   Not listed, because the ledger already carries them: the INVOICE/SALE
 *   cache row of a factory invoice (the order above is its source), a
 *   'voucher' row whose voucher is live (credit-sales import), and legacy
 *   CONTAINER_SALE rows (ERP container sales were posted as vouchers on the
 *   customer's ledger).
 *
 * Factory suppliers (amounts we owe are negative, debit positive)
 *   - factoryContainerGoods: a container's goods value with no live
 *     FACTORY-IMPORT-{container}- journal (legacy containers);
 *   - factoryContainerFreight: supplier-paid freight with no live
 *     FACTORY-FREIGHT-{container} journal;
 *   - factoryContainerCommission: container commission with no live
 *     FACTORY-COMM-{container}- journal (commission is not journalled today),
 *     listed under the container's supplier.
 *   Amounts in another currency are converted at the container's stored,
 *   confirmed rate; with no such rate `amount` is null (the line is listed
 *   with its native amount and left out of the memo total).
 *
 * Every line carries its own date and is listed when dated on or before the
 * as-of date.
 */
import { sql } from "drizzle-orm";
import type Decimal from "decimal.js";

import type { DatabaseOrTransaction } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";

export type MemoPartyKind = "customer" | "factorySupplier";

export type MemoSource =
  | "factoryInvoice"
  | "factoryPosCreditSale"
  | "factoryPosDeposit"
  | "customerBalanceCache"
  | "factoryContainerGoods"
  | "factoryContainerFreight"
  | "factoryContainerCommission";

/** What each source is, as shown next to a balance (the reference names the document). */
export const MEMO_SOURCE_LABELS: Record<MemoSource, string> = {
  factoryInvoice: "Factory invoices not yet in the ledger",
  factoryPosCreditSale: "Factory POS credit sales not yet in the ledger",
  factoryPosDeposit: "Deposits on factory POS credit sales not yet in the ledger",
  customerBalanceCache: "Other customer balance records not in the ledger",
  factoryContainerGoods: "Container goods not yet in the ledger (legacy containers)",
  factoryContainerFreight: "Supplier-paid container freight not yet in the ledger",
  factoryContainerCommission: "Container commission not yet in the ledger",
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
  companyId: number;
  kind: MemoPartyKind;
  ids: readonly number[];
  asOf?: string | null;
}

type Executor = DatabaseOrTransaction;

async function rowsOf<T>(executor: Executor, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await executor.execute(query)).rows as unknown as T[];
}

function idList(ids: readonly number[]) {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `
  );
}

function dateCut(column: ReturnType<typeof sql>, asOf: string | null | undefined) {
  return asOf ? sql` AND ${column} <= ${asOf}::date` : sql``;
}

/** A live voucher of the company whose number matches `pattern` (SQL LIKE or equality). */
function liveVoucherExists(numberCondition: ReturnType<typeof sql>, companyColumn: ReturnType<typeof sql>) {
  return sql`EXISTS (
    SELECT 1 FROM vouchers mv
     WHERE mv.company_id = ${companyColumn} AND mv.deleted_at IS NULL AND mv.optional = false
       AND ${numberCondition}
  )`;
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

async function customerMemoRows(executor: Executor, query: MemoQuery): Promise<CustomerMemoRow[]> {
  const { companyId, ids, asOf } = query;
  const invoiceDate = sql`COALESCE(co.finalized_at, co.created_at)::date`;
  const invoices = rowsOf<CustomerMemoRow>(
    executor,
    sql`
      SELECT co.customer_id AS party_id, 'factoryInvoice' AS source,
             COALESCE(co.invoice_number, 'Order #' || co.id::text) AS reference, co.id AS source_id,
             ${invoiceDate}::text AS date,
             (COALESCE(co.grand_total, 0) - COALESCE((
                SELECT SUM(ch.amount) FROM customer_order_charges ch
                  JOIN vouchers cv ON cv.id = ch.voucher_id AND cv.company_id = co.company_id
                                  AND cv.deleted_at IS NULL AND cv.optional = false
                 WHERE ch.order_id = co.id
             ), 0))::text AS native,
             UPPER(COALESCE(b.currency, 'USD')) AS currency,
             co.grand_total::text AS extra
        FROM customer_orders co
        LEFT JOIN customer_dispatch_batches b ON b.id = co.dispatch_batch_id AND b.company_id = co.company_id
       WHERE co.company_id = ${companyId} AND co.status = 'FINALIZED' AND co.deleted_at IS NULL
         AND co.customer_id IN (${idList(ids)})
         AND NOT ${liveVoucherExists(
           sql`mv.voucher_number = 'INV-GL-' || co.company_id::text || '-' || co.id::text`,
           sql`co.company_id`
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
         AND NOT (cb.reference_type = 'INVOICE' AND cb.transaction_type = 'SALE')
         AND cb.reference_type IS DISTINCT FROM 'CONTAINER_SALE'
         AND NOT (cb.reference_type = 'voucher' AND EXISTS (
               SELECT 1 FROM vouchers rv
                WHERE rv.id = cb.reference_id AND rv.company_id = cb.company_id
                  AND rv.deleted_at IS NULL AND rv.optional = false))
         ${dateCut(sql`cb.transaction_date::date`, asOf)}
    `
  );
  return [...(await invoices), ...(await cache)];
}

function customerLabel(row: CustomerMemoRow): string {
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

interface ContainerMemoRow {
  id: number;
  container_number: string;
  supplier_id: number | null;
  date: string;
  status: string | null;
  currency_code: string | null;
  fx_rate_to_usd: string | null;
  fx_rate_confirmed: boolean | null;
  goods: string | null;
  goods_posted: boolean;
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

/** USD per unit of `currency` when known: 1 for USD, a confirmed positive stored rate otherwise. */
function confirmedRate(currency: string, rate: string | null, confirmed: boolean | null): Decimal | null {
  if (currency === "USD") return new MoneyDecimal(1);
  if (!confirmed || rate === null) return null;
  const value = toMoney(rate);
  return value.greaterThan(0) ? value : null;
}

/** Same freight rule as isSupplierPaidFreight (factory/suppliers/_supplierStatementHelpers.ts). */
function supplierPaidFreight(row: ContainerMemoRow): boolean {
  if (row.freight_paid_by === "own") return false;
  if (row.freight_paid_by === "supplier") return true;
  const offloaded = ["OFFLOADED", "RECEIVED", "PARTIALLY_RECEIVED"].includes(String(row.status ?? "").toUpperCase());
  return offloaded ? row.freight_supplier_id !== null : true;
}

async function factorySupplierMemoLines(executor: Executor, query: MemoQuery) {
  const { companyId, ids, asOf } = query;
  const day = sql`COALESCE(fc.arrival_date, fc.created_at::date)`;
  const containers = await rowsOf<ContainerMemoRow>(
    executor,
    sql`
      SELECT fc.id, fc.container_number, fc.supplier_id, ${day}::text AS date, fc.status,
             fc.currency_code, fc.fx_rate_to_usd::text AS fx_rate_to_usd, fc.fx_rate_confirmed,
             (COALESCE(fc.total_kg, 0) * COALESCE(fc.rate_per_kg, 0))::text AS goods,
             ${liveVoucherExists(sql`mv.voucher_number LIKE 'FACTORY-IMPORT-' || fc.id::text || '-%'`, sql`fc.company_id`)} AS goods_posted,
             fc.freight::text AS freight, fc.freight_currency_code, fc.freight_fx_rate_to_usd::text AS freight_fx_rate_to_usd,
             fc.freight_fx_rate_confirmed, fc.freight_paid_by, fc.freight_supplier_id,
             ${liveVoucherExists(
               sql`(mv.voucher_number = 'FACTORY-FREIGHT-' || fc.id::text OR mv.voucher_number LIKE 'FACTORY-FREIGHT-' || fc.id::text || '-%')`,
               sql`fc.company_id`
             )} AS freight_posted,
             fc.commission_amount::text AS commission_amount, fc.commission_currency_code,
             fc.commission_fx_rate_to_usd::text AS commission_fx_rate_to_usd, fc.commission_fx_rate_confirmed,
             ${liveVoucherExists(sql`mv.voucher_number LIKE 'FACTORY-COMM-' || fc.id::text || '-%'`, sql`fc.company_id`)} AS commission_posted
        FROM factory_containers fc
       WHERE fc.company_id = ${companyId} AND fc.deleted_at IS NULL AND fc.supplier_id IN (${idList(ids)})
         ${dateCut(day, asOf)}
    `
  );

  const out: { partyId: number; line: PartyBalanceMemoLine }[] = [];
  const push = (row: ContainerMemoRow, source: MemoSource, native: Decimal, currency: string, rate: Decimal | null) => {
    if (!row.supplier_id || !native.greaterThan(0)) return;
    const owed = native.negated();
    out.push({
      partyId: row.supplier_id,
      line: {
        source,
        reference: row.container_number,
        sourceId: row.id,
        date: row.date,
        amount: rate ? owed.times(rate).toFixed(2) : null,
        nativeAmount: owed.toFixed(2),
        currency,
        label: rate ? MEMO_SOURCE_LABELS[source] : MEMO_NO_RATE_LABEL,
        notInLedger: true,
      },
    });
  };

  for (const row of containers) {
    const ccy = (row.currency_code || "USD").toUpperCase();
    const containerRate = confirmedRate(ccy, row.fx_rate_to_usd, row.fx_rate_confirmed);
    if (!row.goods_posted) push(row, "factoryContainerGoods", toMoney(row.goods), ccy, containerRate);
    if (!row.freight_posted && supplierPaidFreight(row)) {
      const fccy = (row.freight_currency_code || ccy).toUpperCase();
      const rate =
        fccy === ccy ? containerRate : confirmedRate(fccy, row.freight_fx_rate_to_usd, row.freight_fx_rate_confirmed);
      push(row, "factoryContainerFreight", toMoney(row.freight), fccy, rate);
    }
    if (!row.commission_posted) {
      const cccy = (row.commission_currency_code || ccy).toUpperCase();
      const rate =
        confirmedRate(cccy, row.commission_fx_rate_to_usd, row.commission_fx_rate_confirmed) ??
        (cccy === ccy ? containerRate : null);
      push(row, "factoryContainerCommission", toMoney(row.commission_amount), cccy, rate);
    }
  }
  return out;
}

/** Memo lines per party id, sorted by date. */
export async function loadPartyMemoLines(
  executor: Executor,
  query: MemoQuery
): Promise<Map<number, PartyBalanceMemoLine[]>> {
  const byParty = new Map<number, PartyBalanceMemoLine[]>();
  if (query.ids.length === 0) return byParty;
  const add = (partyId: number, line: PartyBalanceMemoLine) => {
    const list = byParty.get(partyId) ?? [];
    list.push(line);
    byParty.set(partyId, list);
  };

  if (query.kind === "customer") {
    for (const row of await customerMemoRows(executor, query)) {
      const native = toMoney(row.native);
      if (native.isZero()) continue;
      const currency = row.currency ?? "USD";
      add(row.party_id, {
        source: row.source,
        reference: row.reference,
        sourceId: row.source_id,
        date: row.date,
        amount: currency === "USD" ? native.toFixed(2) : null,
        nativeAmount: native.toFixed(2),
        currency,
        label: customerLabel(row),
        notInLedger: true,
      });
    }
  } else {
    for (const { partyId, line } of await factorySupplierMemoLines(executor, query)) add(partyId, line);
  }

  for (const list of byParty.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date) || a.source.localeCompare(b.source) || a.sourceId - b.sourceId);
  }
  return byParty;
}

/** Sum of the USD amounts of memo lines (lines without a rate are left out), optionally only those before a day. */
export function memoTotal(lines: readonly PartyBalanceMemoLine[], before?: string | null): Decimal {
  return lines
    .filter((line) => line.amount !== null && (!before || line.date < before))
    .reduce((sum, line) => sum.plus(toMoney(line.amount)), new MoneyDecimal(0));
}

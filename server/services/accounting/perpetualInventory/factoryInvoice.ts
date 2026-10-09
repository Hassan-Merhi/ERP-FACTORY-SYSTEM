/**
 * Factory invoices in the ledger (wave 8.4).
 *
 * A finalized factory order (and a dispatch-batch invoice, which is stored as
 * a finalized order) has always reached only customer_balances and the
 * readers that rebuild the receivable from customer_orders.grand_total. Once
 * the company's cut-over applies, the invoice also posts a linked journal,
 * INV-GL-{company}-{order}:
 *
 *   Dr customer ledger        grand total less the charges that already have
 *                             their own CHARGE- voucher (Dr customer / Cr
 *                             charge account)
 *      Cr Factory Bale Sales Income   the same amount
 *   Dr Cost of Goods Sold     the recorded cost of the order's bales
 *      Cr Factory Finished Goods      the same amount
 *
 * The factory customer readers that rebuild the invoice from grand_total skip
 * INV-% vouchers, so the receivable is not counted twice there; the ledger
 * readers (trial balance, net position, the generic customer balance) now see
 * the invoice they were missing.
 *
 * The journal is derived from the order's current state and replaced whole by
 * syncFactoryInvoiceTx, which finalize, dispatch invoicing, the V3 load
 * finalize, un-finalize and every path that re-prices a finalized order call.
 *
 * An invoice in a currency other than USD (a dispatch batch can carry one)
 * posts at the company's confirmed factory rate dated on or before the invoice
 * date (wave 17 B, owner decision 3): the latest manual rate, else the latest
 * recorded (auto) rate, never a later one (findFactoryFxRateOnOrBefore, the
 * factory POS rule). Its lines are normalized like the factory POS receipt:
 * USD base in debit/credit, the native amounts in transaction_*, the factory
 * rate (USD per unit) as the historical rate. The receivable and the revenue
 * are in the invoice currency; the cost of the bales is USD (bale cost is USD
 * material cost), so the COGS lines are USD lines of the same voucher. An
 * invoice with no such rate is refused (409 FACTORY_INVOICE_RATE_UNCONFIRMED)
 * before anything is posted, and one already finalized without a journal is
 * listed by listUnpostedFactoryInvoices. Before: such an invoice posted
 * nothing and was only listed.
 */
import { sql } from "drizzle-orm";

import type Decimal from "decimal.js";
import { voucherEntries } from "@shared/schema";

import type { DatabaseOrTransaction, DbTransaction } from "../../../db";
import { HttpError } from "../../../lib/httpHandlers";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { findFactoryFxRateOnOrBefore, normalizeFactoryCurrency } from "../../factory/factoryFxRateOnDate";
import { normFactoryEntry } from "../../factory/factoryVoucherEntryAmounts";
import { infrastructurePostingIdentity, insertInfrastructureVoucherTx } from "../infrastructureVoucherIdentity";
import { getInventoryCutover, isPerpetualInventoryActive } from "./cutover";
import {
  isSupplierPartnerCompany,
  ledgerAccountByCodeTx,
  postLinkedJournalTx,
  removeLinkedJournalTx,
  systemAccountIdsTx,
  type LinkedJournalLine,
} from "./linkedJournal";

export const FACTORY_INVOICE_SOURCE = "perpetual-factory-invoice";

export const FACTORY_INVOICE_RATE_UNCONFIRMED = "FACTORY_INVOICE_RATE_UNCONFIRMED" as const;
export const FACTORY_INVOICE_RATE_UNCONFIRMED_MESSAGE =
  "This invoice is in a currency with no confirmed exchange rate on or before its date. Enter the factory exchange rate for that currency first.";

/** A factory invoice the ledger cannot carry (no confirmed rate): refused before anything is posted. */
export class FactoryInvoiceRateRefusalError extends HttpError {
  readonly code = FACTORY_INVOICE_RATE_UNCONFIRMED;
  constructor(
    readonly currency: string,
    readonly invoiceDate: string
  ) {
    super(409, FACTORY_INVOICE_RATE_UNCONFIRMED_MESSAGE);
    this.name = "FactoryInvoiceRateRefusalError";
  }

  get body() {
    return { code: this.code, message: this.message, currency: this.currency, invoiceDate: this.invoiceDate };
  }
}

/**
 * Voucher numbers are unique across companies while each company runs its own
 * invoice sequence, so the journal is numbered by company and order; the INV-
 * prefix is what the factory customer readers skip. The invoice number is in
 * the description.
 */
export const factoryInvoiceVoucherNumber = (companyId: number, orderId: number) => `INV-GL-${companyId}-${orderId}`;

async function rows<T>(executor: DatabaseOrTransaction, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await executor.execute(query)).rows as unknown as T[];
}

interface InvoiceRow {
  status: string;
  invoice_number: string | null;
  customer_id: number;
  grand_total: string | null;
  invoice_date: string | null;
  deleted_at: string | null;
  currency: string | null;
}

/** The customer's ledger account, created and linked as the charge vouchers do when missing. */
export async function customerLedgerAccountTx(
  tx: DbTransaction,
  companyId: number,
  customerId: number
): Promise<number> {
  const [customer] = await rows<{ ledger_account_id: number | null; legal_name: string | null }>(
    tx,
    sql`SELECT ledger_account_id, legal_name FROM customers WHERE id = ${customerId} AND company_id = ${companyId}`
  );
  if (customer?.ledger_account_id) return customer.ledger_account_id;
  const accountId = await ledgerAccountByCodeTx(
    tx,
    companyId,
    `CUST-${customerId}`,
    customer?.legal_name || `Customer ${customerId}`,
    "Asset"
  );
  await tx.execute(
    sql`UPDATE customers SET ledger_account_id = ${accountId} WHERE id = ${customerId} AND company_id = ${companyId}`
  );
  return accountId;
}

/**
 * Posts (replacing any earlier one) the ledger journal of a factory invoice.
 * Returns the journal's id, or null when nothing is posted.
 */
export async function syncFactoryInvoiceTx(
  tx: DbTransaction,
  companyId: number,
  orderId: number
): Promise<number | null> {
  await removeLinkedJournalTx(tx, companyId, factoryInvoiceVoucherNumber(companyId, orderId));

  const [order] = await rows<InvoiceRow>(
    tx,
    sql`
      SELECT co.status, co.invoice_number, co.customer_id, co.grand_total::text AS grand_total,
             COALESCE(co.finalized_at, co.created_at)::date::text AS invoice_date,
             co.deleted_at::text AS deleted_at, b.currency
        FROM customer_orders co
        LEFT JOIN customer_dispatch_batches b ON b.id = co.dispatch_batch_id AND b.company_id = co.company_id
       WHERE co.id = ${orderId} AND co.company_id = ${companyId}
    `
  );
  if (!order || order.status !== "FINALIZED" || order.deleted_at !== null || !order.invoice_number) return null;
  if (!order.invoice_date || !(await isPerpetualInventoryActive(tx, companyId, order.invoice_date))) return null;
  if (await isSupplierPartnerCompany(tx, companyId)) return null;

  // Charges with their own CHARGE- voucher already debit the customer.
  const [vouchered] = await rows<{ amount: string }>(
    tx,
    sql`
      SELECT COALESCE(SUM(c.amount), 0)::text AS amount
        FROM customer_order_charges c
        JOIN vouchers v ON v.id = c.voucher_id AND v.company_id = ${companyId} AND v.deleted_at IS NULL
                       AND COALESCE(v.optional, false) = false
       WHERE c.order_id = ${orderId}
    `
  );
  const receivable = toMoney(order.grand_total ?? 0)
    .minus(toMoney(vouchered?.amount ?? 0))
    .toDecimalPlaces(2);
  const [cost] = await rows<{ cost: string }>(
    tx,
    sql`
      SELECT COALESCE(SUM(b.total_cost), 0)::text AS cost
        FROM customer_order_bales cob
        JOIN factory_bales b ON b.id = cob.bale_id AND b.company_id = ${companyId}
       WHERE cob.order_id = ${orderId}
    `
  );
  const cogs = toMoney(cost?.cost ?? 0).toDecimalPlaces(2);
  if (receivable.isZero() && cogs.isZero()) return null;
  const currency = normalizeFactoryCurrency(order.currency);
  const rate = await findFactoryFxRateOnOrBefore(tx, companyId, currency, order.invoice_date);
  if (!rate) throw new FactoryInvoiceRateRefusalError(currency, order.invoice_date);

  const zero = new MoneyDecimal(0);
  const accounts = await systemAccountIdsTx(tx, companyId, ["COGS", "FACTORY_FINISHED_GOODS"]);
  const revenueAccountId = await ledgerAccountByCodeTx(
    tx,
    companyId,
    "FACTORY_BALE_SALES_INCOME",
    "Factory Bale Sales Income",
    "Income"
  );
  const customerAccountId = await customerLedgerAccountTx(tx, companyId, order.customer_id);
  const number = factoryInvoiceVoucherNumber(companyId, orderId);
  const invoice = order.invoice_number;
  const debitReceivable = receivable.isNegative() ? zero : receivable;
  const creditReceivable = receivable.isNegative() ? receivable.negated() : zero;
  const invoiceLines: LinkedJournalLine[] = [
    {
      ledgerAccountId: customerAccountId,
      customerId: order.customer_id,
      debit: debitReceivable,
      credit: creditReceivable,
      narration: ["Factory invoice", invoice].join(" - "),
    },
    {
      ledgerAccountId: revenueAccountId,
      debit: creditReceivable,
      credit: debitReceivable,
      narration: ["Factory bale sales", invoice].join(" - "),
    },
  ];
  const costLines: LinkedJournalLine[] = [
    {
      ledgerAccountId: accounts.get("COGS")!,
      debit: cogs,
      credit: zero,
      narration: ["Cost of bales sold", invoice].join(" - "),
    },
    {
      ledgerAccountId: accounts.get("FACTORY_FINISHED_GOODS")!,
      debit: zero,
      credit: cogs,
      narration: ["Bales invoiced", invoice].join(" - "),
    },
  ];
  const description = ["Factory invoice", invoice].join(" - ");
  const identity = { sourceType: FACTORY_INVOICE_SOURCE, sourceId: orderId };
  if (currency === "USD") {
    return postLinkedJournalTx(tx, {
      companyId,
      voucherNumber: number,
      voucherDate: order.invoice_date,
      description,
      identity,
      lines: [...invoiceLines, ...costLines],
    });
  }
  return postForeignCurrencyInvoiceTx(tx, {
    companyId,
    voucherNumber: number,
    voucherDate: order.invoice_date,
    description,
    identity,
    currency,
    rate: rate.rate,
    nativeLines: invoiceLines,
    usdLines: costLines,
  });
}

/**
 * A non-USD invoice's journal (decision 3): the receivable and revenue lines in
 * the invoice currency at the factory rate, the cost lines in USD, every line
 * normalized (USD base in debit/credit, native amounts in transaction_*).
 * The receivable and the revenue are the same native amount at the same rate,
 * and the cost lines are equal USD amounts, so the voucher balances exactly.
 */
async function postForeignCurrencyInvoiceTx(
  tx: DbTransaction,
  params: {
    companyId: number;
    voucherNumber: string;
    voucherDate: string;
    description: string;
    identity: { sourceType: string; sourceId: number };
    currency: string;
    rate: string;
    nativeLines: LinkedJournalLine[];
    usdLines: LinkedJournalLine[];
  }
): Promise<number | null> {
  const nonZero = (line: LinkedJournalLine) => !line.debit.isZero() || !line.credit.isZero();
  const rows = [
    ...params.nativeLines.filter(nonZero).map((line) => ({ line, currency: params.currency, rate: params.rate })),
    ...params.usdLines.filter(nonZero).map((line) => ({ line, currency: "USD", rate: "1" })),
  ].map(({ line, currency, rate }) => ({
    line,
    amounts: normFactoryEntry(currency, line.debit.toFixed(2), line.credit.toFixed(2), rate),
  }));
  if (rows.length === 0) return null;
  const sum = (pick: (amounts: (typeof rows)[number]["amounts"]) => string): Decimal =>
    rows.reduce((total, row) => total.plus(pick(row.amounts)), new MoneyDecimal(0));
  const debits = sum((amounts) => amounts.debitAmount);
  if (!debits.eq(sum((amounts) => amounts.creditAmount)))
    throw new Error("A perpetual-inventory journal does not balance");

  const { voucher } = await insertInfrastructureVoucherTx(
    tx,
    {
      companyId: params.companyId,
      voucherNumber: params.voucherNumber,
      voucherType: "Journal",
      voucherDate: params.voucherDate,
      description: params.description,
      totalAmount: debits.toDecimalPlaces(2).toFixed(2),
      currency: params.currency,
      exchangeRate: params.rate,
    },
    infrastructurePostingIdentity(params.identity.sourceType, params.identity.sourceId)
  );
  await tx.insert(voucherEntries).values(
    rows.map(({ line, amounts }) => ({
      voucherId: voucher.id,
      ledgerAccountId: line.ledgerAccountId,
      ...(line.customerId ? { customerId: line.customerId } : {}),
      ...amounts,
      narration: line.narration,
    }))
  );
  return voucher.id;
}

export interface UnpostedFactoryInvoice {
  orderId: number;
  invoiceNumber: string;
  invoiceDate: string;
  currency: string;
  grandTotal: string;
  reason: string;
}

/**
 * Finalized invoices dated on or after the company's cut-over that carry no
 * ledger journal: an invoice in a currency with no confirmed factory rate on
 * or before its date (finalized before wave 17 B, when such an invoice was
 * not refused), or any other invoice left unposted.
 */
export async function listUnpostedFactoryInvoices(
  executor: DatabaseOrTransaction,
  companyId: number
): Promise<UnpostedFactoryInvoice[]> {
  const cutover = await getInventoryCutover(executor, companyId);
  if (!cutover) return [];
  const result = await rows<{
    id: number;
    invoice_number: string;
    invoice_date: string;
    currency: string | null;
    grand_total: string;
  }>(
    executor,
    sql`
      SELECT co.id, co.invoice_number, COALESCE(co.finalized_at, co.created_at)::date::text AS invoice_date,
             b.currency, co.grand_total::text AS grand_total
        FROM customer_orders co
        LEFT JOIN customer_dispatch_batches b ON b.id = co.dispatch_batch_id AND b.company_id = co.company_id
       WHERE co.company_id = ${companyId} AND co.status = 'FINALIZED' AND co.deleted_at IS NULL
         AND co.invoice_number IS NOT NULL
         AND COALESCE(co.finalized_at, co.created_at)::date >= ${cutover.effectiveFrom}::date
         AND NOT EXISTS (
           SELECT 1 FROM vouchers v
            WHERE v.company_id = ${companyId} AND v.deleted_at IS NULL
              AND v.voucher_number = 'INV-GL-' || ${companyId}::text || '-' || co.id::text
         )
       ORDER BY co.id
    `
  );
  const unposted: UnpostedFactoryInvoice[] = [];
  for (const row of result) {
    if (toMoney(row.grand_total).isZero()) continue;
    const currency = normalizeFactoryCurrency(row.currency);
    const rated = await findFactoryFxRateOnOrBefore(executor, companyId, currency, row.invoice_date);
    unposted.push({
      orderId: row.id,
      invoiceNumber: row.invoice_number,
      invoiceDate: row.invoice_date,
      currency,
      grandTotal: toMoney(row.grand_total).toFixed(2),
      reason: rated ? "not posted" : "no confirmed exchange rate on or before the invoice date",
    });
  }
  return unposted;
}

/** Re-syncs the invoice journal of every order whose charge a voucher carries (the voucher changed). */
export async function syncFactoryInvoiceForChargeVoucherTx(
  tx: DbTransaction,
  companyId: number,
  voucherId: number
): Promise<void> {
  const orders = await rows<{ order_id: number }>(
    tx,
    sql`
      SELECT DISTINCT c.order_id FROM customer_order_charges c
        JOIN customer_orders co ON co.id = c.order_id AND co.company_id = ${companyId}
       WHERE c.voucher_id = ${voucherId}
    `
  );
  for (const { order_id } of orders) await syncFactoryInvoiceTx(tx, companyId, order_id);
}

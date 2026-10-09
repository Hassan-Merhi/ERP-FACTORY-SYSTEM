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
 * syncFactoryInvoiceTx, which finalize, dispatch invoicing, un-finalize and
 * every path that re-prices a finalized order call. An invoice in a currency
 * other than USD (a dispatch batch can carry one, with no rate stored) posts
 * nothing and is listed by listUnpostedFactoryInvoices.
 */
import { sql } from "drizzle-orm";

import type { DatabaseOrTransaction, DbTransaction } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { getInventoryCutover, isPerpetualInventoryActive } from "./cutover";
import {
  isSupplierPartnerCompany,
  ledgerAccountByCodeTx,
  postLinkedJournalTx,
  removeLinkedJournalTx,
  systemAccountIdsTx,
} from "./linkedJournal";

export const FACTORY_INVOICE_SOURCE = "perpetual-factory-invoice";

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
  if ((order.currency ?? "USD").toUpperCase() !== "USD") return null;
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
  return postLinkedJournalTx(tx, {
    companyId,
    voucherNumber: number,
    voucherDate: order.invoice_date,
    description: ["Factory invoice", invoice].join(" - "),
    identity: { sourceType: FACTORY_INVOICE_SOURCE, sourceId: orderId },
    lines: [
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
    ],
  });
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
 * ledger journal: today only invoices in a currency other than USD, which have
 * no exchange rate to post at.
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
            WHERE v.company_id = ${companyId} AND v.voucher_number = 'INV-GL-' || ${companyId}::text || '-' || co.id::text
         )
       ORDER BY co.id
    `
  );
  return result
    .filter((row) => !toMoney(row.grand_total).isZero())
    .map((row) => ({
      orderId: row.id,
      invoiceNumber: row.invoice_number,
      invoiceDate: row.invoice_date,
      currency: (row.currency ?? "USD").toUpperCase(),
      grandTotal: toMoney(row.grand_total).toFixed(2),
      reason: (row.currency ?? "USD").toUpperCase() !== "USD" ? "currency without an exchange rate" : "not posted",
    }));
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

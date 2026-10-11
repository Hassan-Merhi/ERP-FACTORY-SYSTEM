/**
 * Factory revenue and receivables independent of the inventory switch, and
 * the opening receivable at the factory cut-over (accounting audit phase 28,
 * F1; owner decision 2026-10-11: "opening AR at the cut-over, no back-post").
 *
 * Before: a finalized factory invoice posted its journal INV-GL (receivable,
 * revenue and cost of sales) only once the company's perpetual-inventory
 * cut-over applied to the invoice date, and that cut-over cannot be applied
 * while PERPETUAL_INVENTORY_POSTING_READY is false. Earlier invoices reached
 * customer_balances only, while the customer's payments were in the ledger:
 * the ledger showed customers with payments and no invoices.
 *
 * Now (factoryInvoice.ts): the receivable and revenue lines post for an
 * invoice dated on or after the company's FACTORY RECEIVABLE cut-over (this
 * module, table factory_ar_cutovers) or its inventory cut-over, whichever
 * comes first; the cost-of-sales lines still post only under perpetual
 * inventory (before it, cost of sales stays periodic).
 *
 * The history is carried by an opening receivable, not by back-posting each
 * invoice (decision):
 *
 *   GET  plan  (Admin/Owner): for the chosen cut-over date, every finalized
 *        invoice dated before it with no live INV-GL journal and a non-zero
 *        receivable (grand total less the charges that have their own CHARGE-
 *        voucher, exactly what INV-GL would debit), at the confirmed factory
 *        rate on or before the invoice date for a non-USD invoice; the
 *        invoices dated on or after the date still to post; blockers; hash.
 *   POST apply (Owner, confirm + plan hash): one transaction under an advisory
 *        lock; the plan recomputed and applied only when the hash matches; the
 *        cut-over row recorded first (so the invoices dated on or after it
 *        post), then per currency one journal INV-OPEN-AR-{company}-{CUR},
 *        dated the eve of the cut-over, through the engine:
 *          Dr each invoice's customer ledger (customer_id on the line)
 *             Cr Opening Balance Equity         the total
 *        then INV-GL for every invoice dated on or after the cut-over that
 *        has none, and one audit row, all in the same transaction. Refused in
 *        a closed period (the engine's period check), for a future date, a
 *        second time, for a supplier-partner company and while an invoice has
 *        no confirmed rate.
 *
 * The opening is numbered INV-…, so the factory customer readers that rebuild
 * invoices from customer_orders.grand_total (and skip INV-% vouchers) do not
 * count it a second time; the ledger readers see it. One line per invoice
 * keeps each receivable an open item.
 */
import crypto from "node:crypto";

import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import { db, type DatabaseOrTransaction, type DbTransaction } from "../../db";
import { HttpError } from "../../lib/httpHandlers";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { writeAuditEvent } from "../audit";
import { companyBusinessDate } from "../accounting/companyBusinessDate";
import { isPerpetualInventoryActive } from "../accounting/perpetualInventory/cutover";
import { isSupplierPartnerCompany, systemAccountIdsTx } from "../accounting/perpetualInventory/linkedJournal";
import { findFactoryFxRateOnOrBefore, normalizeFactoryCurrency } from "./factoryFxRateOnDate";
import { postFactoryVoucherTx, type FactoryVoucherLine } from "./factoryVoucherPosting";

type Executor = DatabaseOrTransaction;

export const FACTORY_OPENING_RECEIVABLE_SOURCE = "factory-opening-receivable";
export const factoryOpeningReceivableVoucherNumber = (companyId: number, currency: string) =>
  `INV-OPEN-AR-${companyId}-${currency}`;

export const FACTORY_OPENING_RECEIVABLE_MESSAGES = {
  ALREADY_APPLIED: "The factory opening receivable has already been applied for this company.",
  CUTOVER_IN_FUTURE: "The factory receivable cut-over can be applied on or after its date.",
  SUPPLIER_PARTNER: "A supplier-partner company carries no factory receivable.",
  INVOICES_WITHOUT_RATE:
    "Some invoices are in a currency with no confirmed exchange rate on or before their date. Enter the factory rates first.",
  PLAN_CHANGED: "The opening receivable changed since it was reviewed. Preview it again and confirm the new plan.",
  NOTHING_TO_APPLY: "There is no factory receivable to open.",
} as const;
export type FactoryOpeningReceivableCode = keyof typeof FACTORY_OPENING_RECEIVABLE_MESSAGES;

export class FactoryOpeningReceivableRefusal extends HttpError {
  constructor(readonly code: FactoryOpeningReceivableCode) {
    super(code === "CUTOVER_IN_FUTURE" ? 400 : 409, FACTORY_OPENING_RECEIVABLE_MESSAGES[code]);
    this.name = "FactoryOpeningReceivableRefusal";
  }
  get body() {
    return { code: this.code, message: this.message };
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

async function rows<T>(executor: Executor, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await executor.execute(query)).rows as unknown as T[];
}

function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export interface FactoryArCutover {
  companyId: number;
  effectiveFrom: string;
  openingVoucherIds: number[];
}

export async function getFactoryArCutover(executor: Executor, companyId: number): Promise<FactoryArCutover | null> {
  const [row] = await rows<{ effective_from: string; opening_voucher_ids: unknown }>(
    executor,
    sql`SELECT effective_from::text AS effective_from, opening_voucher_ids
          FROM factory_ar_cutovers WHERE company_id = ${companyId}`
  );
  if (!row) return null;
  const ids = Array.isArray(row.opening_voucher_ids) ? row.opening_voucher_ids.map(Number) : [];
  return { companyId, effectiveFrom: row.effective_from, openingVoucherIds: ids };
}

/**
 * Whether a factory invoice of this company dated `date` posts its receivable
 * and revenue: on or after the factory receivable cut-over, or under perpetual
 * inventory (an inventory cut-over applied before this one existed already
 * posted its invoices).
 */
export async function isFactoryRevenuePostingActive(executor: Executor, companyId: number, date: string) {
  const cutover = await getFactoryArCutover(executor, companyId);
  if (cutover && date >= cutover.effectiveFrom) return true;
  return isPerpetualInventoryActive(executor, companyId, date);
}

/** The first date from which factory invoices post (the earlier of the two cut-overs), or null. */
export async function factoryRevenuePostingFrom(executor: Executor, companyId: number): Promise<string | null> {
  const [row] = await rows<{ from: string | null }>(
    executor,
    sql`SELECT LEAST(
          (SELECT effective_from FROM factory_ar_cutovers WHERE company_id = ${companyId}),
          (SELECT effective_from FROM gl_inventory_cutovers WHERE company_id = ${companyId})
        )::text AS from`
  );
  return row?.from ?? null;
}

export interface OpeningReceivableLine {
  orderId: number;
  invoiceNumber: string;
  invoiceDate: string;
  customerId: number;
  currency: string;
  /** Receivable in the invoice currency (grand total less vouchered charges), 2dp. */
  amount: string;
  /** USD per unit, the confirmed factory rate on or before the invoice date; null when none. */
  rate: string | null;
}

export interface OpeningReceivablePlan {
  companyId: number;
  effectiveFrom: string;
  journalDate: string;
  lines: OpeningReceivableLine[];
  totals: Array<{ currency: string; amount: string; invoices: number }>;
  /** Finalized invoices dated on or after the cut-over with no journal: posted by the apply. */
  toPost: Array<{ orderId: number; invoiceNumber: string; invoiceDate: string }>;
  withoutRate: Array<{ orderId: number; invoiceNumber: string; currency: string; invoiceDate: string }>;
  alreadyApplied: FactoryArCutover | null;
  blockers: FactoryOpeningReceivableCode[];
  planHash: string;
}

interface InvoiceRow {
  id: number;
  invoice_number: string;
  invoice_date: string;
  customer_id: number;
  grand_total: string;
  vouchered: string;
  currency: string | null;
  posted: boolean;
}

/** Read-only: the opening receivable plan for one company (see the module comment). */
export async function planFactoryOpeningReceivable(
  companyId: number,
  effectiveFrom: string,
  executor: Executor = db
): Promise<OpeningReceivablePlan> {
  if (!ISO_DATE.test(effectiveFrom)) throw new HttpError(400, "Invalid date");
  const invoices = await rows<InvoiceRow>(
    executor,
    sql`
      SELECT co.id, co.invoice_number, COALESCE(co.finalized_at, co.created_at)::date::text AS invoice_date,
             co.customer_id, COALESCE(co.grand_total, 0)::text AS grand_total, b.currency,
             COALESCE((SELECT SUM(c.amount) FROM customer_order_charges c
                         JOIN vouchers v ON v.id = c.voucher_id AND v.company_id = ${companyId}
                                        AND v.deleted_at IS NULL AND COALESCE(v.optional, false) = false
                        WHERE c.order_id = co.id), 0)::text AS vouchered,
             EXISTS (SELECT 1 FROM vouchers v WHERE v.company_id = ${companyId} AND v.deleted_at IS NULL
                        AND v.voucher_number = 'INV-GL-' || ${companyId}::text || '-' || co.id::text) AS posted
        FROM customer_orders co
        LEFT JOIN customer_dispatch_batches b ON b.id = co.dispatch_batch_id AND b.company_id = co.company_id
       WHERE co.company_id = ${companyId} AND co.status = 'FINALIZED' AND co.deleted_at IS NULL
         AND co.invoice_number IS NOT NULL
       ORDER BY co.id
    `
  );
  const lines: OpeningReceivableLine[] = [];
  const toPost: OpeningReceivablePlan["toPost"] = [];
  const withoutRate: OpeningReceivablePlan["withoutRate"] = [];
  for (const invoice of invoices) {
    if (invoice.posted) continue;
    const receivable = toMoney(invoice.grand_total).minus(toMoney(invoice.vouchered)).toDecimalPlaces(2);
    if (invoice.invoice_date >= effectiveFrom) {
      toPost.push({ orderId: invoice.id, invoiceNumber: invoice.invoice_number, invoiceDate: invoice.invoice_date });
      continue;
    }
    if (receivable.isZero()) continue;
    const currency = normalizeFactoryCurrency(invoice.currency);
    const rate = await findFactoryFxRateOnOrBefore(executor, companyId, currency, invoice.invoice_date);
    if (!rate) {
      withoutRate.push({
        orderId: invoice.id,
        invoiceNumber: invoice.invoice_number,
        currency,
        invoiceDate: invoice.invoice_date,
      });
    }
    lines.push({
      orderId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      invoiceDate: invoice.invoice_date,
      customerId: Number(invoice.customer_id),
      currency,
      amount: receivable.toFixed(2),
      rate: rate ? rate.rate : null,
    });
  }
  const byCurrency = new Map<string, { amount: Decimal; invoices: number }>();
  for (const line of lines) {
    const total = byCurrency.get(line.currency) ?? { amount: new MoneyDecimal(0), invoices: 0 };
    byCurrency.set(line.currency, { amount: total.amount.plus(line.amount), invoices: total.invoices + 1 });
  }
  const totals = [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, total]) => ({ currency, amount: total.amount.toFixed(2), invoices: total.invoices }));
  const alreadyApplied = await getFactoryArCutover(executor, companyId);
  const blockers: FactoryOpeningReceivableCode[] = [];
  if (alreadyApplied) blockers.push("ALREADY_APPLIED");
  if (await isSupplierPartnerCompany(executor, companyId)) blockers.push("SUPPLIER_PARTNER");
  if (effectiveFrom > (await companyBusinessDate(companyId, executor))) blockers.push("CUTOVER_IN_FUTURE");
  if (withoutRate.length > 0) blockers.push("INVOICES_WITHOUT_RATE");
  const planHash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ companyId, effectiveFrom, lines, toPost }))
    .digest("hex");
  return {
    companyId,
    effectiveFrom,
    journalDate: dayBefore(effectiveFrom),
    lines,
    totals,
    toPost,
    withoutRate,
    alreadyApplied,
    blockers,
    planHash,
  };
}

export interface OpeningReceivableResult {
  plan: OpeningReceivablePlan;
  voucherIds: number[];
  postedInvoices: Array<{ orderId: number; voucherId: number | null }>;
}

/** Applies the reviewed plan (see the module comment). */
export async function applyFactoryOpeningReceivable(
  companyId: number,
  params: { effectiveFrom: string; planHash: string; actor: { userId: string; username: string } }
): Promise<OpeningReceivableResult> {
  // Imported here: factoryInvoice.ts imports this module for the posting gate.
  const { customerLedgerAccountTx, syncFactoryInvoiceTx } =
    await import("../accounting/perpetualInventory/factoryInvoice");
  return db.transaction(async (tx: DbTransaction) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('factory_ar_cutover'), ${companyId})`);
    const plan = await planFactoryOpeningReceivable(companyId, params.effectiveFrom, tx);
    if (plan.blockers.length > 0) throw new FactoryOpeningReceivableRefusal(plan.blockers[0]);
    if (plan.planHash !== params.planHash) throw new FactoryOpeningReceivableRefusal("PLAN_CHANGED");
    if (plan.lines.length === 0 && plan.toPost.length === 0) {
      throw new FactoryOpeningReceivableRefusal("NOTHING_TO_APPLY");
    }
    // The cut-over first: the invoices dated on or after it post below.
    await tx.execute(sql`
      INSERT INTO factory_ar_cutovers (company_id, effective_from, opening_voucher_ids, plan_hash, opening_plan, applied_by)
      VALUES (${companyId}, ${plan.effectiveFrom}, '[]'::jsonb, ${plan.planHash}, ${JSON.stringify(plan)}::jsonb,
              ${params.actor.username})
    `);
    const equityId = (await systemAccountIdsTx(tx, companyId, ["OPENING_BALANCE_EQUITY"])).get(
      "OPENING_BALANCE_EQUITY"
    )!;
    const voucherIds: number[] = [];
    for (const total of plan.totals) {
      const currencyLines = plan.lines.filter((line) => line.currency === total.currency);
      // Each invoice line carries its own invoice-date rate; the equity side is
      // one credit per rate, so every line stays at a recorded rate.
      const lines: FactoryVoucherLine[] = [];
      const equityByRate = new Map<string, Decimal>();
      for (const line of currencyLines) {
        const amount = toMoney(line.amount);
        const accountId = await customerLedgerAccountTx(tx, companyId, line.customerId);
        const rate = line.rate ?? "1";
        equityByRate.set(rate, (equityByRate.get(rate) ?? new MoneyDecimal(0)).plus(amount));
        lines.push({
          ledgerAccountId: accountId,
          customerId: line.customerId,
          debit: amount.isNegative() ? 0 : amount,
          credit: amount.isNegative() ? amount.negated() : 0,
          currency: line.currency,
          fxRateToUsd: rate,
          narration: `Opening receivable - invoice ${line.invoiceNumber} (${line.invoiceDate})`,
        });
      }
      for (const [rate, equity] of equityByRate) {
        if (equity.isZero()) continue;
        lines.push({
          ledgerAccountId: equityId,
          debit: equity.isNegative() ? equity.negated() : 0,
          credit: equity.isNegative() ? 0 : equity,
          currency: total.currency,
          fxRateToUsd: rate,
          narration: "Factory receivables of invoices before the cut-over",
        });
      }
      const headerRate = currencyLines[0]?.rate ?? "1";
      const { voucher } = await postFactoryVoucherTx(tx, {
        companyId,
        voucherType: "Journal",
        voucherNumber: factoryOpeningReceivableVoucherNumber(companyId, total.currency),
        voucherDate: plan.journalDate,
        description: `Factory opening receivable at the cut-over ${plan.effectiveFrom} (${total.invoices} invoices)`,
        currency: total.currency,
        fxRateToUsd: total.currency === "USD" ? "1" : headerRate,
        sourceModule: "FACTORY",
        source: { sourceType: FACTORY_OPENING_RECEIVABLE_SOURCE, sourceId: companyId, phase: total.currency },
        lines,
      });
      voucherIds.push(voucher.id);
    }
    await tx.execute(sql`
      UPDATE factory_ar_cutovers SET opening_voucher_ids = ${JSON.stringify(voucherIds)}::jsonb
       WHERE company_id = ${companyId}
    `);
    const postedInvoices: OpeningReceivableResult["postedInvoices"] = [];
    for (const invoice of plan.toPost) {
      postedInvoices.push({
        orderId: invoice.orderId,
        voucherId: await syncFactoryInvoiceTx(tx, companyId, invoice.orderId),
      });
    }
    await writeAuditEvent(
      {
        userId: params.actor.userId,
        username: params.actor.username,
        companyId,
        action: "create",
        tableName: "factory_ar_cutovers",
        recordId: companyId,
        recordIdentifier: `factory-opening-receivable:${plan.effectiveFrom}`,
        changes: {
          cutover: { old: null, new: { effectiveFrom: plan.effectiveFrom, planHash: plan.planHash } },
          openingReceivable: { old: null, new: { totals: plan.totals, voucherIds, invoices: plan.lines.length } },
          invoicesPosted: { old: null, new: postedInvoices },
        },
      },
      tx
    );
    return { plan, voucherIds, postedInvoices };
  });
}

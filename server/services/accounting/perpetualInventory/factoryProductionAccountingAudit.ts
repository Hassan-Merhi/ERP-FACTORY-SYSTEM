/**
 * Unified Accounting — Phase 7, Factory production and container accounting.
 *
 * READ ONLY. Existing authoritative writers:
 * - factoryStockValuation / GL-FACTORY-STOCK (current raw, WIP, bales)
 * - factoryInvoice / INV-GL (only finalized customer invoices)
 * - orderChargeLedger / CHARGE (only finalized order charges)
 * - factoryContainerReceipts (immutable receipts with fixed native/USD cost)
 *
 * Historical factory raw, WIP and bale costs are overwritten by subsequent
 * production/cost cascades. Never pretend current costing is an as-of snapshot.
 */
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../../db";
import { resultRows } from "../../../lib/queryResult";
import { assertTransactionCompanyScope } from "../../security/transactionCompanyScope";
import { companyBusinessDate } from "../companyBusinessDate";
import { fxDay } from "../monetaryFxRates";
import { getInventoryCutover, PERPETUAL_INVENTORY_POSTING_READY } from "./cutover";
import { factoryStockValuation } from "./factoryValuation";
import { factoryGoodsInTransitHeld, factoryStockJournalNumber } from "./factoryStockJournal";
import { ledgerBalancesByCode, isSupplierPartnerCompany } from "./linkedJournal";

type Money = string | null;
interface ContainerRow extends Record<string, unknown> {
  id: number;
  number: string;
  status: string;
  currency: string;
  rate_confirmed: boolean;
  receipt_count: number;
  receipt_kg: string;
  receipt_value_usd: Money;
  missing_receipt_values: number;
  raw_received_kg: string;
  raw_used_kg: string;
  raw_value_usd: Money;
  raw_missing_rate: number;
  declared_kg: Money;
  master_received_kg: Money;
  last_receipt_date: string | null;
  first_receipt_date: string | null;
  fx_rate: string | null;
}
interface InvoiceRow extends Record<string, unknown> {
  id: number;
  status: string;
  invoice_number: string | null;
  container_number: string | null;
  invoice_date: string;
  grand_total: string;
  customer_id: number;
  charges: string;
  verified_charges: string;
  unverified_charges: number;
  journal_id: number | null;
  journal_date: string | null;
  posted_receivable_native: Money;
  posted_receivable_base: Money;
  posted_cogs: Money;
  posted_finished_credit: Money;
  cost: string;
  unvalued_bales: number;
  bales: number;
  premature_charge_vouchers: number;
}
interface JournalRow extends Record<string, unknown> {
  id: number;
  voucher_number: string;
  date: string;
}
interface UnvaluedRow {
  source: string;
  id: number;
  reason: string;
}
export type FactoryAuditSeverity = "clear" | "review" | "critical" | "expected";
export interface FactoryContainerAudit {
  id: number;
  number: string;
  status: string;
  currency: string;
  rateConfirmed: boolean;
  receiptCount: number;
  receiptKg: string;
  receiptsUsd: Money;
  rawReceivedKg: string;
  rawUsedKg: string;
  rawRemainingUsd: Money;
  originalReceivedKg: Money;
  declaredKg: Money;
  firstReceiptDate: string | null;
  lastReceiptDate: string | null;
  issues: string[];
  severity: FactoryAuditSeverity;
}
export interface FactoryInvoiceAudit {
  orderId: number;
  invoiceNumber: string | null;
  containerNumber: string | null;
  status: string;
  invoiceDate: string;
  grandTotal: string;
  customerId: number;
  postedVoucherId: number | null;
  postedVoucherDate: string | null;
  expectedReceivableNative: Money;
  postedReceivableNative: Money;
  postedReceivableUsd: Money;
  costOfBalesUsd: string;
  postedCogsUsd: Money;
  postedFinishedGoodsCreditUsd: Money;
  bales: number;
  issues: string[];
  severity: FactoryAuditSeverity;
}
export interface FactoryProductionAccountingAudit {
  companyId: number;
  asOfDate: string;
  reportCurrency: "USD";
  postingReady: boolean;
  cutover: { effectiveFrom: string; openingVoucherId: number | null } | null;
  supplierPartner: boolean;
  valuation: {
    basis: "CURRENT_COSTING" | "CURRENT_COSTING_NOT_HISTORICAL";
    asOfDate: string;
    rawUsd: string;
    wipUsd: string;
    finishedUsd: string;
    totalUsd: string;
    goodsInTransitUsd: string;
    reservedForOpenOrders: { bales: number; cost: string };
    soldNotInvoiced: { bales: number; cost: string };
    unvalued: UnvaluedRow[];
    ledger: Record<string, { amount: string; difference: Money }>;
    journal: { number: string; id: number | null; date: string | null };
  };
  containers: FactoryContainerAudit[];
  invoices: FactoryInvoiceAudit[];
  summary: {
    containers: number;
    invoices: number;
    unfinalized: number;
    missingFinalizedInvoices: number;
    prematureCustomerPostings: number;
    unverifiedContainerCosts: number;
    unvaluedStock: number;
    critical: number;
    review: number;
    truncated: boolean;
  };
  warnings: string[];
  policy: {
    draftAndVerifiedOrders: string;
    invoiceDate: string;
    freight: string;
    costValuation: string;
    productionVariance: string;
    factoryReceipts: string;
    transfers: string;
    cutover: string;
    historical: string;
  };
}
const value = (x: unknown) => new Decimal(String(x ?? "0"));
const money = (x: Decimal) => x.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
const absDiff = (a: unknown, b: unknown) => value(a).minus(value(b)).abs();
const limit = 201;
function severity(issues: string[], critical: string[]): FactoryAuditSeverity {
  if (issues.some((x) => critical.includes(x))) return "critical";
  if (issues.length) return "review";
  return "clear";
}
async function containersTx(
  tx: DbTransaction,
  companyId: number,
  asOf: string,
  historical: boolean
): Promise<FactoryContainerAudit[]> {
  const rows = resultRows<ContainerRow>(
    await tx.execute(sql`
  SELECT c.id,c.container_number AS number,c.status,
   COALESCE(c.currency_code,'USD') AS currency,c.fx_rate_confirmed AS rate_confirmed,
   c.fx_rate_to_usd::text AS fx_rate,
   c.declared_kg::text AS declared_kg,c.actual_received_kg::text AS master_received_kg,
   COALESCE(rr.receipt_count,0)::int AS receipt_count,
   COALESCE(rr.receipt_kg,0)::text AS receipt_kg,
   rr.receipt_value_usd::text AS receipt_value_usd,
   COALESCE(rr.missing_receipt_values,0)::int AS missing_receipt_values,
   rr.first_receipt_date::text,rr.last_receipt_date::text,
   COALESCE(raw.received_kg,0)::text AS raw_received_kg,
   COALESCE(raw.used_kg,0)::text AS raw_used_kg,
   raw.raw_value_usd::text,COALESCE(raw.missing_rate,0)::int AS raw_missing_rate
  FROM factory_containers c
  LEFT JOIN LATERAL (
   SELECT COUNT(*)::int AS receipt_count,
    COALESCE(SUM(r.received_kg),0) AS receipt_kg,
    SUM(r.receipt_value_usd) AS receipt_value_usd,
    COUNT(*) FILTER (WHERE r.receipt_value_usd IS NULL)::int AS missing_receipt_values,
    MIN(r.receipt_date) AS first_receipt_date,MAX(r.receipt_date) AS last_receipt_date
   FROM factory_container_receipts r
   WHERE r.company_id=c.company_id AND r.container_id=c.id
    AND r.deleted_at IS NULL AND r.receipt_date<=${asOf}::date
  ) rr ON true
  LEFT JOIN LATERAL (
   SELECT COALESCE(SUM(s.received_kg),0) AS received_kg,
    COALESCE(SUM(s.used_kg),0) AS used_kg,
    SUM((s.received_kg-s.used_kg)*s.cost_per_kg_usd) AS raw_value_usd,
    COUNT(*) FILTER (WHERE s.cost_per_kg_usd IS NULL AND s.received_kg>s.used_kg)::int AS missing_rate
   FROM factory_raw_stock s
   WHERE s.company_id=c.company_id AND s.container_id=c.id AND s.deleted_at IS NULL
  ) raw ON true
  WHERE c.company_id=${companyId} AND c.deleted_at IS NULL
  ORDER BY c.id DESC LIMIT ${limit}
 `)
  );
  return rows.map((r) => {
    const issues: string[] = [];
    const critical = [
      "Foreign container rate not confirmed",
      "Received raw stock lacks a confirmed USD cost",
      "A receipt has no recorded USD value",
    ];
    const native = String(r.currency).toUpperCase();
    if (native !== "USD" && !r.rate_confirmed && (r.receipt_count > 0 || value(r.raw_received_kg).gt(0)))
      issues.push("Foreign container rate not confirmed");
    if (r.raw_missing_rate > 0) issues.push("Received raw stock lacks a confirmed USD cost");
    if (r.missing_receipt_values > 0) issues.push("A receipt has no recorded USD value");
    // Receipt events can predate introduction of the receipt journal. Never
    // mistake a missing historical event for proof of no goods received.
    if (!historical && r.receipt_count === 0 && value(r.raw_received_kg).gt(0))
      issues.push("Raw stock exists but no live receipt events appear in this period");
    if (!historical && r.receipt_count > 0 && value(r.raw_received_kg).eq(0))
      issues.push("Receipt evidence exists but the current raw-stock source is absent");
    // The raw table is current state, not an as-of aggregate. Mismatches
    // against a historical cutoff are intentionally not financial errors.
    return {
      id: Number(r.id),
      number: String(r.number),
      status: String(r.status),
      currency: native,
      rateConfirmed: native === "USD" || Boolean(r.rate_confirmed),
      receiptCount: Number(r.receipt_count),
      receiptKg: money(value(r.receipt_kg)),
      receiptsUsd:
        r.missing_receipt_values > 0 ? null : r.receipt_value_usd === null ? null : money(value(r.receipt_value_usd)),
      rawReceivedKg: money(value(r.raw_received_kg)),
      rawUsedKg: money(value(r.raw_used_kg)),
      rawRemainingUsd: r.raw_missing_rate > 0 ? null : r.raw_value_usd === null ? null : money(value(r.raw_value_usd)),
      originalReceivedKg: r.master_received_kg,
      declaredKg: r.declared_kg,
      firstReceiptDate: r.first_receipt_date,
      lastReceiptDate: r.last_receipt_date,
      issues,
      severity: severity(issues, critical),
    };
  });
}
async function invoicesTx(
  tx: DbTransaction,
  companyId: number,
  asOf: string,
  cutover: string | null,
  historical: boolean
): Promise<FactoryInvoiceAudit[]> {
  const rows = resultRows<InvoiceRow>(
    await tx.execute(sql`
  SELECT co.id,co.status,co.invoice_number,co.container_number,
   COALESCE(co.finalized_at,co.created_at)::date::text AS invoice_date,
   co.grand_total::text,co.customer_id,
   COALESCE(ch.charge_total,0)::text AS charges,
   COALESCE(ch.verified_total,0)::text AS verified_charges,
   COALESCE(ch.unverified,0)::int AS unverified_charges,
   COALESCE(ch.premature,0)::int AS premature_charge_vouchers,
   iv.id AS journal_id,COALESCE(iv.effective_date,iv.voucher_date)::text AS journal_date,
   (CASE WHEN COALESCE(UPPER(b.currency),'USD')='USD' THEN gl.receivable_base
         ELSE gl.receivable_native END)::text AS posted_receivable_native,
   gl.receivable_base::text AS posted_receivable_base,
   gl.cogs::text AS posted_cogs,gl.finished_credit::text AS posted_finished_credit,
   COALESCE(ba.cost,0)::text AS cost,COALESCE(ba.unvalued,0)::int AS unvalued_bales,
   COALESCE(ba.bales,0)::int AS bales
  FROM customer_orders co
  LEFT JOIN customer_dispatch_batches b ON b.id=co.dispatch_batch_id AND b.company_id=co.company_id
  LEFT JOIN vouchers iv ON iv.company_id=co.company_id
    AND iv.voucher_number='INV-GL-' || co.company_id::text || '-' || co.id::text
    AND iv.deleted_at IS NULL AND iv.optional=false
  LEFT JOIN LATERAL (
   SELECT COALESCE(SUM(b.total_cost),0) AS cost,
    COUNT(*)::int AS bales,COUNT(*) FILTER (
      WHERE b.total_cost IS NULL OR (b.total_cost=0 AND b.weight_kg>0))::int AS unvalued
   FROM customer_order_bales cob
    JOIN factory_bales b ON b.id=cob.bale_id AND b.company_id=co.company_id
   WHERE cob.order_id=co.id
  ) ba ON true
  LEFT JOIN LATERAL (
   SELECT COALESCE(SUM(c.amount),0) AS charge_total,
    COALESCE(SUM(c.amount) FILTER(WHERE v.id IS NOT NULL),0) AS verified_total,
    COUNT(*) FILTER(WHERE c.voucher_id IS NOT NULL AND v.id IS NULL)::int AS unverified,
    COUNT(*) FILTER(WHERE v.id IS NOT NULL AND co.status<>'FINALIZED')::int AS premature
   FROM customer_order_charges c
   LEFT JOIN LATERAL (
     SELECT p.id FROM vouchers p
     WHERE p.company_id=co.company_id AND p.deleted_at IS NULL
       AND p.optional=false AND
       (p.id=c.voucher_id
         OR (c.voucher_id IS NULL AND (
             p.voucher_number='CHARGE-PRE-'||co.id::text||'-'||c.id::text
             OR (co.invoice_number IS NOT NULL AND p.voucher_number LIKE
               'CHARGE-'||co.invoice_number||'-'||c.id::text||'-%')
            ) AND EXISTS (
              SELECT 1 FROM voucher_entries ve
              WHERE ve.voucher_id=p.id AND ve.customer_id=co.customer_id
               AND ABS(COALESCE(ve.debit_amount,0)-COALESCE(ve.credit_amount,0)-c.amount)<0.005
            )))
     ORDER BY p.id DESC LIMIT 1
   ) v ON true
   WHERE c.order_id=co.id
  ) ch ON true
  LEFT JOIN LATERAL(
   SELECT CASE WHEN COUNT(*) FILTER (WHERE ve.customer_id=co.customer_id
       AND (ve.debit_amount>0 OR ve.credit_amount>0)
       AND (ve.transaction_debit_amount IS NULL OR ve.transaction_credit_amount IS NULL))>0
      THEN NULL
      ELSE SUM(CASE WHEN ve.customer_id=co.customer_id THEN
        COALESCE(ve.transaction_debit_amount,0)-COALESCE(ve.transaction_credit_amount,0)
      ELSE 0 END) END AS receivable_native,
     SUM(CASE WHEN ve.customer_id=co.customer_id
                    THEN ve.debit_amount-ve.credit_amount ELSE 0 END) AS receivable_base,
     SUM(CASE WHEN la.code='COGS' THEN ve.debit_amount-ve.credit_amount ELSE 0 END) AS cogs,
     SUM(CASE WHEN la.code='FACTORY_FINISHED_GOODS'
                    THEN ve.credit_amount-ve.debit_amount ELSE 0 END) AS finished_credit
    FROM voucher_entries ve
     LEFT JOIN ledger_accounts la ON la.id=ve.ledger_account_id AND la.company_id=co.company_id
    WHERE ve.voucher_id=iv.id
  ) gl ON true
  WHERE co.company_id=${companyId} AND co.deleted_at IS NULL
    AND co.order_date<=${asOf}::date
  ORDER BY co.id DESC LIMIT ${limit}
 `)
  );
  return rows.map((r) => {
    const issues: string[] = [];
    const isFinal = r.status === "FINALIZED";
    const hasInvoice = r.journal_id !== null;
    const dated = String(r.invoice_date);
    const cutoverCost = isFinal && !!cutover && dated >= cutover;
    const nativeExpected = value(r.grand_total).minus(r.verified_charges);
    const cost = value(r.cost);
    if (historical)
      issues.push("Historical order status, postings and bale cost are not reconstructed; inspect current state only");
    if (!historical && !isFinal && hasInvoice) issues.push("Unfinalized order has an active customer invoice voucher");
    if (!historical && !isFinal && r.premature_charge_vouchers > 0)
      issues.push("Unfinalized order has posted customer charge voucher(s)");
    if (!historical && isFinal && !hasInvoice && (value(r.grand_total).abs().gt(0) || cost.gt(0)))
      issues.push("Finalized invoice is missing a live accounting voucher");
    if (!historical && isFinal && r.unverified_charges > 0)
      issues.push("Finalized charge voucher link is missing or inactive");
    if (!historical && isFinal && hasInvoice && r.journal_date !== dated)
      issues.push("Invoice journal date differs from finalization business date");
    if (!historical && cutoverCost && r.unvalued_bales > 0)
      issues.push("Finalized bales include unvalued material cost");
    if (
      !historical &&
      cutoverCost &&
      hasInvoice &&
      (absDiff(r.posted_cogs, cost).gt("0.01") || absDiff(r.posted_finished_credit, cost).gt("0.01"))
    )
      issues.push("COGS or Finished Goods credit differs from recorded bale cost");
    if (!historical && isFinal && hasInvoice && r.posted_receivable_native === null)
      issues.push("Invoice customer receivable has no original currency evidence");
    if (
      !historical &&
      isFinal &&
      hasInvoice &&
      r.posted_receivable_native !== null &&
      r.unverified_charges === 0 &&
      absDiff(r.posted_receivable_native, nativeExpected).gt("0.01")
    )
      issues.push("Invoice receivable differs from order less vouchered charges (verify native FX)");
    const critical = [
      "Unfinalized order has an active customer invoice voucher",
      "Unfinalized order has posted customer charge voucher(s)",
      "Finalized invoice is missing a live accounting voucher",
      "COGS or Finished Goods credit differs from recorded bale cost",
    ];
    return {
      orderId: Number(r.id),
      invoiceNumber: r.invoice_number,
      containerNumber: r.container_number,
      status: String(r.status),
      invoiceDate: dated,
      grandTotal: money(value(r.grand_total)),
      customerId: Number(r.customer_id),
      postedVoucherId: hasInvoice ? Number(r.journal_id) : null,
      postedVoucherDate: r.journal_date,
      expectedReceivableNative: isFinal ? money(nativeExpected) : null,
      postedReceivableNative: r.posted_receivable_native === null ? null : money(value(r.posted_receivable_native)),
      postedReceivableUsd: r.posted_receivable_base === null ? null : money(value(r.posted_receivable_base)),
      costOfBalesUsd: money(cost),
      postedCogsUsd: r.posted_cogs === null ? null : money(value(r.posted_cogs)),
      postedFinishedGoodsCreditUsd: r.posted_finished_credit === null ? null : money(value(r.posted_finished_credit)),
      bales: Number(r.bales),
      issues,
      severity: severity(issues, critical),
    };
  });
}
export async function factoryProductionAccountingAuditTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    asOfDate?: string;
  }
): Promise<FactoryProductionAccountingAudit> {
  const companyId = input.companyId;
  if (!Number.isSafeInteger(companyId) || companyId <= 0) throw new Error("FACTORY_ACCOUNTING_INVALID_COMPANY");
  await assertTransactionCompanyScope(tx, companyId);
  const now = await companyBusinessDate(companyId, tx);
  const day = fxDay(input.asOfDate ?? now);
  const cut = await getInventoryCutover(tx, companyId);
  const partner = await isSupplierPartnerCompany(tx, companyId);
  const val = await factoryStockValuation(tx, companyId);
  const codes = ["FACTORY_RAW_MATERIAL_STOCK", "FACTORY_WIP", "FACTORY_FINISHED_GOODS", "FACTORY_GOODS_IN_TRANSIT"];
  // Historical Factory costing CANNOT be reconstructed: only expose a same-day
  // comparison and always label the subledger as current costing.
  const canCompare = day === now && cut !== null && !partner;
  const ledger = canCompare ? await ledgerBalancesByCode(tx, companyId, codes, day) : new Map<string, Decimal>();
  const inTransit = await factoryGoodsInTransitHeld(tx, companyId, day);
  const targets = new Map<string, Decimal>([
    ["FACTORY_RAW_MATERIAL_STOCK", val.raw],
    ["FACTORY_WIP", val.wip],
    ["FACTORY_FINISHED_GOODS", val.finished],
    ["FACTORY_GOODS_IN_TRANSIT", inTransit],
  ]);
  const accounts: Record<string, { amount: string; difference: Money }> = {};
  for (const [code, target] of targets) {
    const got = ledger.get(code);
    accounts[code] = {
      amount: got === undefined ? "Not available" : money(got),
      difference: got === undefined ? null : money(got.minus(target)),
    };
  }
  const name = factoryStockJournalNumber(companyId, day);
  const journal = resultRows<JournalRow>(
    await tx.execute(sql`
   SELECT id,voucher_number,COALESCE(effective_date,voucher_date)::text AS date
    FROM vouchers WHERE company_id=${companyId} AND voucher_number=${name}
      AND deleted_at IS NULL AND optional=false LIMIT 1
 `)
  )[0];
  const [containers, invoices] = await Promise.all([
    containersTx(tx, companyId, day, day !== now),
    invoicesTx(tx, companyId, day, cut?.effectiveFrom ?? null, day !== now),
  ]);
  const warnings: string[] = [];
  if (day !== now)
    warnings.push(
      "Factory costs, order statuses and voucher lifecycle are current, NOT reconstructed as of the selected date. Financial discrepancies and historical GL-to-cost comparison are withheld."
    );
  if (!cut) warnings.push("Perpetual inventory cutover is not applied. Factory daily stock journal not required.");
  if (!PERPETUAL_INVENTORY_POSTING_READY)
    warnings.push("Perpetual inventory posting gate is disabled; no opening or daily journals were activated.");
  if (partner)
    warnings.push(
      "Supplier Partner inventory is accounted for separately; Factory journal comparison is not applicable."
    );
  if (invoices.some((i) => i.status !== "FINALIZED"))
    warnings.push("Unfinalized/verified/loading orders remain operational and do not create customer receivables.");
  if (containers.some((c) => c.receiptCount === 0 && value(c.rawReceivedKg).gt(0)))
    warnings.push(
      "Some older containers have raw stock without a complete incremental receipt log. Manual review, no backfill."
    );
  const allIssues = [...containers, ...invoices];
  return {
    companyId,
    asOfDate: day,
    reportCurrency: "USD",
    postingReady: PERPETUAL_INVENTORY_POSTING_READY,
    cutover: cut ? { effectiveFrom: cut.effectiveFrom, openingVoucherId: cut.openingVoucherId } : null,
    supplierPartner: partner,
    valuation: {
      basis: day === now ? "CURRENT_COSTING" : "CURRENT_COSTING_NOT_HISTORICAL",
      asOfDate: now,
      rawUsd: money(val.raw),
      wipUsd: money(val.wip),
      finishedUsd: money(val.finished),
      totalUsd: money(val.raw.plus(val.wip).plus(val.finished)),
      goodsInTransitUsd: money(inTransit),
      reservedForOpenOrders: val.reservedForOrders,
      soldNotInvoiced: val.soldNotInvoiced,
      unvalued: val.unvalued,
      ledger: accounts,
      journal: { number: name, id: journal?.id ?? null, date: journal?.date ?? null },
    },
    containers,
    invoices,
    summary: {
      containers: containers.length,
      invoices: invoices.length,
      unfinalized: invoices.filter((i) => i.status !== "FINALIZED").length,
      missingFinalizedInvoices: invoices.filter((i) =>
        i.issues.includes("Finalized invoice is missing a live accounting voucher")
      ).length,
      prematureCustomerPostings: invoices.filter((i) => i.issues.some((q) => q.startsWith("Unfinalized order has")))
        .length,
      unverifiedContainerCosts: containers.filter((c) => c.issues.some((x) => x.includes("USD") || x.includes("rate")))
        .length,
      unvaluedStock: val.unvalued.length,
      critical: allIssues.filter((r) => r.severity === "critical").length,
      review: allIssues.filter((r) => r.severity === "review").length,
      truncated: containers.length === limit || invoices.length === limit,
    },
    warnings,
    policy: {
      draftAndVerifiedOrders:
        "DRAFT/LOADING/PENDING_VERIFICATION/VERIFIED orders are not customer invoices or settled freight.",
      invoiceDate:
        "Invoice source date is COALESCE(finalized_at,created_at) in the existing Factory posting writer; do not use loading-start dates.",
      freight:
        "Freight/charges cannot reach customer statements until order FINALIZED; independently posted charge vouchers are counted once.",
      costValuation:
        "Factory raw = available kg × verified USD landed cost; WIP = unconsumed mix + pending pressing bales; Finished = bales at recorded USD cost.",
      productionVariance:
        "Existing per-company daily GL-FACTORY-STOCK is the only stock consolidation writer; waste, cascade and production differences keep distinct offset accounts.",
      factoryReceipts:
        "Incremental receipt events have native and USD frozen cost snapshots; missing USD values require review, never guessed rate.",
      transfers:
        "ERP bale mirrors are excluded from ERP Inventory to avoid double valuation of Factory finished goods.",
      cutover:
        "The existing perpetual activation gate remains false; this report never creates opening balances or vouchers.",
      historical:
        "Historical Factory raw/mix/bale cost reconstruction cannot be inferred from current overwritten cost rows.",
    },
  };
}

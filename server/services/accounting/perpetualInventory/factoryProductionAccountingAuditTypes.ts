// Extracted from ./factoryProductionAccountingAudit.ts to keep that module under the source-size cap.
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../../db";
import { resultRows } from "../../../lib/queryResult";

export type Money = string | null;

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

export interface InvoiceRow extends Record<string, unknown> {
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

export interface JournalRow extends Record<string, unknown> {
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

export const value = (x: unknown) => new Decimal(String(x ?? "0"));

export const money = (x: Decimal) => x.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

export const absDiff = (a: unknown, b: unknown) => value(a).minus(value(b)).abs();

export const limit = 201;

export function severity(issues: string[], critical: string[]): FactoryAuditSeverity {
  if (issues.some((x) => critical.includes(x))) return "critical";
  if (issues.length) return "review";
  return "clear";
}

export async function containersTx(
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

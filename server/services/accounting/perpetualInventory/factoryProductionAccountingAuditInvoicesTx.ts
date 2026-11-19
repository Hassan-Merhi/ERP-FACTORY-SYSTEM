// Extracted from ./factoryProductionAccountingAudit.ts
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../../db";
import { resultRows } from "../../../lib/queryResult";
import {
  absDiff,
  limit,
  money,
  severity,
  value,
  type FactoryInvoiceAudit,
  type InvoiceRow,
} from "./factoryProductionAccountingAuditTypes";

export async function invoicesTx(
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

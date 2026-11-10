/**
 * Phase 7: company-scoped read of original Pending Loading, all CLOSED trucks,
 * posted vouchers, frozen bale evidence and generated ERP PO files.
 * This never reads another company's Normal ERP receipts (RLS isolation).
 */
import { sql } from "drizzle-orm";
import { MoneyDecimal } from "../../../lib/money";
import type { DbTransaction } from "../../../db";
import { resultRows } from "../../../lib/queryResult";
import { loadFactoryLoadingDispatchComparisonSnapshot } from "./loadingDispatchComparisonRoutes";
import {
  calculateOrderDispatchReconciliation, OrderReconciliationError,
  type OrderFinancialTripEvidence, type OrderReconciliationResult,
} from "./loadingDispatchOrderReconciliationModel";

export interface OrderReconciliationScope {
  companyId: number; orderId: number; userId: string; username: string;
}
export interface ApprovedReconciliation {
  fingerprint: string;
  approvedAt: string;
  approvedByUserId: string;
  reason: string;
  includedPostingIds: string[];
  summary: Record<string, unknown>;
  customerTotal: string;
}
type RepoRead = {
  result: OrderReconciliationResult;
  stored: ApprovedReconciliation | null;
  orderStatus: string;
};
async function query(tx: DbTransaction, template: ReturnType<typeof sql>) {
  return resultRows(await tx.execute(template));
}
function str(raw: unknown): string { return String(raw ?? ""); }
function id(raw: unknown): number {
  const num = Number(raw);
  if (!Number.isSafeInteger(num) || num<=0) throw new OrderReconciliationError("RECONCILIATION_DATA_INVALID", "Invalid row identifier in reconciliation source");
  return num;
}
function approved(row: Record<string,unknown>|undefined): ApprovedReconciliation|null {
  if (!row || !row.reconciledAt) return null;
  if(!row.reconciliationSnapshot || typeof row.reconciliationSnapshot!=="object" ||
     Array.isArray(row.reconciliationSnapshot)) {
    throw new OrderReconciliationError("RECONCILIATION_SNAPSHOT_MISSING", "Signed reconciliation evidence is missing");
  }
  const snap=row.reconciliationSnapshot as Record<string,unknown>;
  return {
    fingerprint:str(row.reconciliationFingerprint),
    approvedAt:str(row.reconciledAt),
    approvedByUserId:str(row.reconciledByUserId), reason:str(row.reconciliationReason),
    includedPostingIds:Array.isArray(row.includedPostingIds)?row.includedPostingIds.map(str):[],
    summary:(snap.summary ?? {}) as Record<string,unknown>,
    customerTotal:str(row.customerTotal),
  };
}
export async function readOrderDispatchApprovalTx(
  tx:DbTransaction,scope:OrderReconciliationScope,lock=false
):Promise<ApprovedReconciliation|null>{
  const [row]=await query(tx,sql`
    SELECT reconciliation_fingerprint AS "reconciliationFingerprint",
           reconciliation_snapshot AS "reconciliationSnapshot",
           reconciled_at AS "reconciledAt",
           reconciled_by_user_id AS "reconciledByUserId",
           reconciliation_reason AS "reconciliationReason",
           included_posting_ids AS "includedPostingIds",
           customer_total::text AS "customerTotal"
      FROM factory_dispatch_order_consolidations
     WHERE company_id=${scope.companyId} AND order_id=${scope.orderId}
     ${lock?sql`FOR UPDATE`:sql``} LIMIT 1
  `);
  return approved(row);
}
export async function loadOrderDispatchReconciliationTx(
  tx:DbTransaction,scope:OrderReconciliationScope
):Promise<RepoRead>{
  const physical=await loadFactoryLoadingDispatchComparisonSnapshot(tx,scope.companyId,scope.orderId);
  if(!physical) throw new OrderReconciliationError("RECONCILIATION_ORDER_MISSING", "Pending Loading not found in the selected Factory company",404);
  if("notFoundTrip" in physical) throw new OrderReconciliationError("RECONCILIATION_ORDER_MISSING", "Pending Loading not found",404);
  const financialRows=await query(tx,sql`
    SELECT f.id::text AS "financialId",f.dispatch_id::text AS "dispatchId",
           f.status,f.posting_revision AS revision,
           f.source_fingerprint AS "sourceFingerprint",
           f.goods_subtotal::text AS "goodsSubtotal",
           f.billable_charges_total::text AS "billableChargesTotal",
           f.discount_total::text AS "discountTotal",
           f.customer_total::text AS "customerTotal",
           p.id::text AS "postingId",
           p.source_fingerprint AS "postedFingerprint",
           p.amount::text AS "postedAmount",
           p.voucher_ids AS "voucherIds",
           e.po_number AS "exportedPoNumber",
           e.exported_at AS "exportedAt"
      FROM factory_dispatch_trip_financials f
      LEFT JOIN factory_dispatch_trip_postings p ON p.financial_id=f.id
       AND p.company_id=f.company_id AND p.order_id=f.order_id
       AND p.dispatch_id=f.dispatch_id AND p.posting_revision=f.posting_revision
       AND p.kind='POST'
      LEFT JOIN factory_dispatch_trip_exports e ON e.financial_id=f.id
       AND e.company_id=f.company_id AND e.order_id=f.order_id
       AND e.dispatch_id=f.dispatch_id
     WHERE f.company_id=${scope.companyId} AND f.order_id=${scope.orderId}
     ORDER BY f.dispatch_id
  `);
  const mapped:OrderFinancialTripEvidence[]=financialRows.map(row=>({
    dispatchId:str(row.dispatchId),
    status:str(row.status) as OrderFinancialTripEvidence["status"],
    revision:Number(row.revision??0),
    financialId:str(row.financialId),
    postingId:row.postingId==null?null:str(row.postingId),
    postingVerified:false,
    sourceFingerprint:row.sourceFingerprint==null?null:str(row.sourceFingerprint),
    goodsSubtotal:str(row.goodsSubtotal),billableChargesTotal:str(row.billableChargesTotal),
    discountTotal:str(row.discountTotal),customerTotal:str(row.customerTotal),
    exportedPoNumber:row.exportedPoNumber==null?null:str(row.exportedPoNumber),
    exportedAt:row.exportedAt==null?null:str(row.exportedAt),
    financialBales:[],
  }));
  // Scope the posted voucher ledger check to the Factory order's actual
  // customer. A linked voucher existing with the right ID does not prove it
  // still carries the signed customer receivable or goods clearing.
  const [invoiceCustomer]=await query(tx,sql`
    SELECT customer_id AS "customerId" FROM customer_orders
    WHERE company_id=${scope.companyId} AND id=${scope.orderId}
  `);
  const customerId=id(invoiceCustomer?.customerId);

  // Verify every original POST record references live, non-optional
  // vouchers in the same Factory company. Never count a reversed, deleted or
  // unlinked voucher simply because the control row still says POSTED.
  for(let index=0;index<mapped.length;index++){
    const source=financialRows[index],financial=mapped[index];
    if(!["POSTED","CONSOLIDATED"].includes(financial.status)) continue;
    const vouchers=Array.isArray(source.voucherIds)?source.voucherIds.map(id):[];
    const countGoodIds=vouchers.length===new Set(vouchers).size;
    const sameSource=str(source.postedFingerprint)===financial.sourceFingerprint;
    const sameAmount=/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/.test(str(source.postedAmount)) &&
      new MoneyDecimal(str(source.postedAmount)).eq(new MoneyDecimal(financial.customerTotal));
    if(!source.postingId || !countGoodIds || !sameSource || !sameAmount ||
       (Number(financial.customerTotal)>0 && !vouchers.length)) continue;
    let liveCount=0;
    if(vouchers.length){
      const [row]=await query(tx,sql`
        SELECT COUNT(*)::integer AS count FROM vouchers
         WHERE company_id=${scope.companyId}
           AND id IN (${sql.join(vouchers.map(v=>sql`${v}`),sql`,`)})
           AND deleted_at IS NULL AND COALESCE(optional,FALSE)=FALSE
      `);
      liveCount=Number(row?.count??0);
    }
    if(liveCount!==vouchers.length)continue;
    // Original customer receivable MUST be tied to the exact FDTR voucher,
    // never merely an arbitrary voucher in the same company. Reversals or a
    // replaced sales voucher block the signed combined invoice.
    const [reversed]=await query(tx,sql`
      SELECT id FROM factory_dispatch_trip_postings
       WHERE company_id=${scope.companyId} AND order_id=${scope.orderId}
         AND dispatch_id=${financial.dispatchId} AND kind='REVERSAL'
         AND reverses_posting_id=${id(source.postingId)}
       LIMIT 1
    `);
    if(reversed)continue;
    const salesNumber=`FDTR-${scope.companyId}-${financial.dispatchId}-${financial.revision}`;
    const [actual]=await query(tx,sql`
      SELECT v.id,
        COALESCE(SUM(CASE WHEN ve.customer_id=${customerId}
          THEN ve.debit_amount-ve.credit_amount ELSE 0 END),0)::text AS "customerDebit",
        COALESCE(SUM(CASE WHEN la.code='FACTORY_DISPATCH_CLEARING'
          AND ve.customer_id IS NULL
          THEN ve.credit_amount-ve.debit_amount ELSE 0 END),0)::text AS "goodsClearingCredit"
      FROM vouchers v
      JOIN voucher_entries ve ON ve.voucher_id=v.id
      LEFT JOIN ledger_accounts la ON la.id=ve.ledger_account_id
        AND la.company_id=v.company_id
      WHERE v.company_id=${scope.companyId} AND v.voucher_number=${salesNumber}
        AND v.id IN (${sql.join(vouchers.map(v=>sql`${v}`),sql`,`)})
        AND v.deleted_at IS NULL AND COALESCE(v.optional,FALSE)=FALSE
      GROUP BY v.id
    `);
    const hasFinancialCustomer=Number(financial.customerTotal)>0;
    const hasGoods=Number(financial.goodsSubtotal)>0;
    if((hasGoods||hasFinancialCustomer) &&
       (!actual || !new MoneyDecimal(str(actual.customerDebit)).eq(financial.customerTotal) ||
         !new MoneyDecimal(str(actual.goodsClearingCredit)).eq(financial.goodsSubtotal))){
      continue;
    }
    // When a POST with no customer and no goods legitimately has only
    // internal expenses (zero-price dispatch), there need not be an FDTR
    // voucher. Such cases are still audited by their exact expense vouchers.
    if(!(hasGoods||hasFinancialCustomer) && actual &&
      (!new MoneyDecimal(str(actual.customerDebit)).isZero() ||
       !new MoneyDecimal(str(actual.goodsClearingCredit)).isZero()))continue;
    financial.postingVerified=true;
  }

  if(mapped.length){
    const baleRows=await query(tx,sql`
      SELECT f.id::text AS "financialId",b.bale_id AS "baleId",
             b.bale_reference AS "baleReference",b.article_code AS "articleCode",
             b.weight_kg::text AS "weightKg", b.line_total::text AS "lineTotal"
        FROM factory_dispatch_trip_financials f
        JOIN factory_dispatch_trip_financial_bales b
          ON b.financial_id=f.id AND b.company_id=f.company_id
         AND b.order_id=f.order_id AND b.dispatch_id=f.dispatch_id
         AND b.snapshot_revision=f.snapshot_revision
       WHERE f.company_id=${scope.companyId} AND f.order_id=${scope.orderId}
         AND f.status IN ('POSTED','CONSOLIDATED')
       ORDER BY f.dispatch_id,b.bale_id
    `);
    const byId=new Map(mapped.map(f=>[f.financialId,f]));
    for(const bale of baleRows){
      const financial=byId.get(str(bale.financialId));
      if(!financial) throw new OrderReconciliationError("RECONCILIATION_FINANCIAL_MISMATCH","Signed trip has a bale belonging to an unknown financial record");
      financial.financialBales.push({
        baleId:id(bale.baleId),baleReference:str(bale.baleReference),
        articleCode:str(bale.articleCode),weightKg:str(bale.weightKg),lineTotal:str(bale.lineTotal),
      });
    }
  }
  const chargeRows=await query(tx,sql`
    SELECT c.id, c.name,c.amount::text
      FROM customer_order_charges c
      JOIN customer_orders o ON o.id=c.order_id AND o.company_id=${scope.companyId}
     WHERE c.order_id=${scope.orderId}
     ORDER BY c.id
  `);
  const stored=await readOrderDispatchApprovalTx(tx,scope);
  const result=calculateOrderDispatchReconciliation({
    companyId:scope.companyId,orderId:scope.orderId,
    status:str(physical.order.status),deleted:Boolean(physical.order.deletedAt),
    invoiceNumber:physical.order.invoiceNumber==null?null:str(physical.order.invoiceNumber),
    loaded:physical.loaded,scans:physical.scans,trips:physical.trips,
    financials:mapped,orderCharges:chargeRows.map(c=>({
      id:id(c.id),name:str(c.name),amount:str(c.amount)
    })),
  });
  return {result,stored,orderStatus:str(physical.order.status)};
}

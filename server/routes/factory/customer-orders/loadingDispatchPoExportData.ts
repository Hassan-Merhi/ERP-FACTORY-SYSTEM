/** Phase 5: immutable POSTED-trip sources for manual ERP PO workbook export. */
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../../db";
import { resultRows } from "../../../lib/queryResult";
import { MoneyDecimal } from "../../../lib/money";
import {
  TripPoExportError, type FrozenTripPoBale, type FrozenTripPoCharge,
  type PostedTripPoSource,
} from "./loadingDispatchPoExportModel";

export interface TripPoScope {
  companyId: number;
  orderId: number;
  dispatchId: number;
  userId: string;
  username: string;
}
export interface PriorTripPoExport {
  id: number;
  revision: number;
  sourceFingerprint: string;
  exportFingerprint: string;
  supplierCode: string;
  poNumber: string;
  containerNumber: string;
  exportedAt: string;
  exportedByUserId: string;
  preview: Record<string, unknown>;
}
const query = async (tx: DbTransaction, value: ReturnType<typeof sql>) => resultRows(await tx.execute(value));
const idNumber = (input: unknown, label: string): number => {
  const n = Number(input);
  if (!Number.isSafeInteger(n) || n < 1) throw new TripPoExportError("PO_RECORD_INVALID", label + " is invalid");
  return n;
};
export async function loadPostedTripPoSourceTx(
  tx: DbTransaction, scope: TripPoScope, lock = false
): Promise<PostedTripPoSource> {
  // Caller must acquire order -> dispatch -> financial locks in this order.
  // Physical source can subsequently be closed/finalized; the frozen snapshots
  // must not be reconstructed from mutable customer_order_bales or live scans.
  const [o] = await query(tx, sql`
    SELECT id, status, deleted_at AS "deletedAt" FROM customer_orders
     WHERE company_id=${scope.companyId} AND id=${scope.orderId}
     ${lock ? sql`FOR UPDATE` : sql``}
  `);
  if (!o || o.deletedAt || o.status === "CANCELLED") {
    throw new TripPoExportError("PO_ORDER_UNAVAILABLE", "Original Factory loading is unavailable");
  }
  const [trip] = await query(tx, sql`
    SELECT id, status FROM factory_loading_dispatches
     WHERE company_id=${scope.companyId} AND order_id=${scope.orderId}
       AND id=${scope.dispatchId}
     ${lock ? sql`FOR UPDATE` : sql``}
  `);
  if (!trip || trip.status !== "CLOSED") {
    throw new TripPoExportError("PO_TRIP_NOT_CLOSED", "Only a physically closed Factory truck can produce a PO file");
  }
  const [f] = await query(tx, sql`
    SELECT id, status, posting_revision AS "revision", snapshot_revision AS "snapshotRevision",
           source_fingerprint AS "sourceFingerprint", currency,
           goods_subtotal::text AS "goodsSubtotal",
           billable_charges_total::text AS "billableChargesTotal",
           discount_total::text AS "discountTotal",
           customer_total::text AS "customerTotal"
      FROM factory_dispatch_trip_financials
     WHERE company_id=${scope.companyId} AND order_id=${scope.orderId}
       AND dispatch_id=${scope.dispatchId}
     ${lock ? sql`FOR UPDATE` : sql``}
  `);
  if (!f || (f.status !== "POSTED" && f.status !== "CONSOLIDATED")) {
    throw new TripPoExportError("PO_TRIP_NOT_FINANCIALLY_POSTED",
      "Financially finalize this trip before exporting its ERP purchase order");
  }
  const financialId = idNumber(f.id, "Trip financial record");
  const revision = idNumber(f.revision, "Trip financial revision");
  if (revision !== Number(f.snapshotRevision)) {
    throw new TripPoExportError("PO_SNAPSHOT_MISMATCH", "Financially posted revision has no matching frozen barcode evidence");
  }
  const [posted] = await query(tx, sql`
    SELECT source_fingerprint AS "sourceFingerprint",amount::text,voucher_ids AS "voucherIds"
      FROM factory_dispatch_trip_postings
     WHERE financial_id=${financialId} AND company_id=${scope.companyId}
       AND order_id=${scope.orderId} AND dispatch_id=${scope.dispatchId}
       AND kind='POST' AND posting_revision=${revision} LIMIT 1
  `);
  if (!posted || String(posted.sourceFingerprint) !== String(f.sourceFingerprint) ||
      new MoneyDecimal(String(posted.amount)).cmp(new MoneyDecimal(String(f.customerTotal))) !== 0 ||
      !Array.isArray(posted.voucherIds)) {
    throw new TripPoExportError("PO_POSTING_UNVERIFIED", "Original trip accounting posting evidence is incomplete");
  }
  // Do not export a trip whose recorded source voucher was removed: financial
  // status alone cannot establish a valid supplier invoice source.
  const ids = posted.voucherIds.map(v => idNumber(v, "Posted voucher ID"));
  if (ids.length) {
    const [voucherStatus] = await query(tx, sql`
      SELECT COUNT(*)::int AS count FROM vouchers
       WHERE company_id=${scope.companyId}
         AND id IN (${sql.join(ids.map(v => sql`${v}`), sql`,`)})
         AND deleted_at IS NULL AND COALESCE(optional, FALSE)=FALSE
    `);
    if (Number(voucherStatus?.count) !== ids.length) {
      throw new TripPoExportError("PO_POSTED_VOUCHER_MISSING", "Trip accounting vouchers are not all live");
    }
  }
  const bales = await query(tx, sql`
    SELECT bale_id AS "baleId",article_code AS "articleCode",product_name AS "productName",
           weight_kg::text AS "weightKg",line_total::text AS "lineTotal"
      FROM factory_dispatch_trip_financial_bales
     WHERE financial_id=${financialId} AND company_id=${scope.companyId}
       AND order_id=${scope.orderId} AND dispatch_id=${scope.dispatchId}
       AND snapshot_revision=${revision}
     ORDER BY bale_id
  `);
  const charges = await query(tx, sql`
    SELECT id,name,kind,amount::text,currency,erp_charge_type AS "erpChargeType",
           locked_at AS "lockedAt"
      FROM factory_dispatch_trip_charges
     WHERE financial_id=${financialId} AND company_id=${scope.companyId}
       AND order_id=${scope.orderId} AND dispatch_id=${scope.dispatchId}
       AND revision=${revision}
     ORDER BY id
  `);
  if (charges.some(c => c.lockedAt == null)) {
    throw new TripPoExportError("PO_CHARGES_NOT_FROZEN", "Financial charge revision has unlocked entries; posting must be reconciled");
  }
  const [duplicates] = await query(tx, sql`
    SELECT b.bale_id
      FROM factory_dispatch_trip_financial_bales b
      JOIN factory_dispatch_trip_financials f
        ON f.id=b.financial_id AND f.company_id=b.company_id
       AND f.order_id=b.order_id AND f.dispatch_id=b.dispatch_id
     WHERE b.company_id=${scope.companyId} AND b.order_id=${scope.orderId}
       AND b.snapshot_revision=f.snapshot_revision
       AND f.status IN ('POSTED','CONSOLIDATED')
     GROUP BY b.bale_id HAVING COUNT(DISTINCT f.dispatch_id) > 1 LIMIT 1
  `);
  if (duplicates) {
    throw new TripPoExportError("PO_OVERLAPPING_TRIP_BALES",
      "A bale is financially allocated to more than one trip; resolve this before exporting");
  }
  return {
    companyId: scope.companyId, orderId: scope.orderId, dispatchId: scope.dispatchId,
    financialId, revision,
    status: String(f.status) as "POSTED" | "CONSOLIDATED",
    sourceFingerprint: String(f.sourceFingerprint),
    currency: String(f.currency), goodsSubtotal: String(f.goodsSubtotal),
    billableChargesTotal: String(f.billableChargesTotal),
    discountTotal: String(f.discountTotal), customerTotal: String(f.customerTotal),
    bales: bales.map(v => ({
      baleId: idNumber(v.baleId, "Bale ID"),
      articleCode: String(v.articleCode), productName: String(v.productName),
      weightKg: String(v.weightKg), lineTotal: String(v.lineTotal),
    } satisfies FrozenTripPoBale)),
    charges: charges.map(c => ({
      id: idNumber(c.id, "Financial charge ID"), name: String(c.name),
      kind: String(c.kind) as "BILLABLE" | "INTERNAL" | "DISCOUNT",
      amount: String(c.amount), currency: String(c.currency),
      erpChargeType: c.erpChargeType == null ? null : String(c.erpChargeType) as FrozenTripPoCharge["erpChargeType"],
    } satisfies FrozenTripPoCharge)),
  };
}
export async function findTripPoExportTx(
  tx: DbTransaction, scope: TripPoScope, financialId: number
): Promise<PriorTripPoExport | null> {
  const found = await query(tx, sql`
    SELECT id,snapshot_revision AS "revision",source_fingerprint AS "sourceFingerprint",
           export_fingerprint AS "exportFingerprint",supplier_code AS "supplierCode",
           po_number AS "poNumber",erp_container_number AS "containerNumber",
           exported_at AS "exportedAt",exported_by_user_id AS "exportedByUserId",preview
      FROM factory_dispatch_trip_exports
     WHERE financial_id=${financialId} AND company_id=${scope.companyId}
       AND order_id=${scope.orderId} AND dispatch_id=${scope.dispatchId}
     ORDER BY id LIMIT 2
  `);
  if (found.length > 1) {
    throw new TripPoExportError("PO_MULTIPLE_EXPORTS", "Multiple exports already exist for one trip; accounting review required");
  }
  const e = found[0];
  return e ? {
    id: idNumber(e.id, "Export ID"), revision: Number(e.revision),
    sourceFingerprint: String(e.sourceFingerprint), exportFingerprint: String(e.exportFingerprint),
    supplierCode: String(e.supplierCode), poNumber: String(e.poNumber),
    containerNumber: String(e.containerNumber), exportedAt: String(e.exportedAt),
    exportedByUserId: String(e.exportedByUserId),
    preview: e.preview && typeof e.preview === "object" && !Array.isArray(e.preview)
      ? e.preview as Record<string, unknown> : {},
  } : null;
}

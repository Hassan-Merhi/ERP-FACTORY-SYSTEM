/**
 * Phase 6: Durable Normal ERP import identity for a manually uploaded Factory
 * Dispatch PO workbook. This is NOT automatic intercompany import.
 *
 * Reserve ONE canonical Factory trip into ONE ERP company before legacy
 * importer writes. A failed/partial legacy import remains PENDING_REVIEW and
 * is never auto-replayed: operations must inspect the resulting container and
 * vouchers before resolving it.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { MoneyDecimal } from "../../lib/money";
import type { FactoryTripPoIdentity } from "./factoryDispatchPoImportGuard";
import type { PoImportPreviewContainer } from "./po-import-preview";

export class FactoryTripPoReceiptError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message);
    this.name = "FactoryTripPoReceiptError";
  }
}
export interface FactoryTripPoReceiptScope {
  companyId: number;
  supplierId: number;
  supplierCode: string;
  identity: FactoryTripPoIdentity;
  fileHash: string;
  amount: string;
  fileName: string;
  userId: string;
}
export interface FactoryTripPoReceipt {
  id: number;
  status: string;
  erpCompanyId: number;
  containerId: number | null;
  importLogId: number | null;
  importedAt: string | null;
}
function numberId(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new FactoryTripPoReceiptError("FD_PO_RECEIPT_INTEGRITY", "Invalid saved ERP import receipt identifier");
  return n;
}
export function canonicalFactoryTripPayloadFingerprint(
  identity: FactoryTripPoIdentity, preview: PoImportPreviewContainer, supplierCode: string
): string {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    identity, supplierCode,
    articles: preview.items.map(i => ({
      code: i.barcode, quantity: i.quantity, rate: i.rate, total: i.lineTotal, currency: i.currency,
    })).sort((a,b) => a.code.localeCompare(b.code)),
    charges: preview.charges,
    itemsTotal: new MoneyDecimal(String(preview.itemsTotal)).toFixed(2),
    chargesTotal: new MoneyDecimal(String(preview.chargesTotal)).toFixed(2),
    grandTotal: new MoneyDecimal(String(preview.grandTotal)).toFixed(2),
  })).digest("hex");
}
async function schemaReady() {
  const [row] = resultRows(await db.execute(sql`
    SELECT to_regclass('public.factory_dispatch_erp_po_receipts') IS NOT NULL AS ready,
           (
             SELECT relforcerowsecurity
               FROM pg_class WHERE oid=to_regclass('public.factory_dispatch_erp_po_receipts')
           ) AS "forceRls",
           (
             SELECT relrowsecurity
               FROM pg_class WHERE oid=to_regclass('public.factory_dispatch_erp_po_receipts')
           ) AS "rlsEnabled",
           EXISTS (
             SELECT 1 FROM pg_indexes
              WHERE schemaname='public' AND tablename='factory_dispatch_erp_po_receipts'
                AND indexname='factory_dispatch_erp_po_receipts_origin_uq'
           ) AS "originUnique",
           EXISTS (
             SELECT 1 FROM pg_trigger
              WHERE tgrelid=to_regclass('public.factory_dispatch_erp_po_receipts')
                AND tgname='factory_dispatch_erp_po_receipt_guard'
                AND tgenabled <> 'D'
           ) AS "immutabilityGuard"
  `));
  if (!row?.ready || !row?.forceRls || !row?.rlsEnabled || !row?.originUnique || !row?.immutabilityGuard) {
    throw new FactoryTripPoReceiptError(
      "FD_PO_RECEIPT_SQL_PENDING",
      "Factory dispatch ERP import protection is disabled until the Phase 6 TablePlus SQL is installed.",
      503
    );
  }
}
/** For parse/validation: warn about already imported or unresolved receipts. */
export async function inspectFactoryTripPoReceipt(
  companyId: number, identity: FactoryTripPoIdentity
): Promise<FactoryTripPoReceipt | null> {
  await schemaReady();
  const [row] = resultRows(await db.execute(sql`
    SELECT id,status,erp_company_id AS "erpCompanyId",container_id AS "containerId",
           import_log_id AS "importLogId",imported_at AS "importedAt"
      FROM factory_dispatch_erp_po_receipts
     WHERE erp_company_id=${companyId}
       AND factory_company_id=${identity.factoryCompanyId}
       AND factory_order_id=${identity.factoryOrderId}
       AND factory_dispatch_id=${identity.factoryDispatchId}
     LIMIT 1
  `));
  if (!row) return null;
  return {
    id: numberId(row.id), status: String(row.status),
    erpCompanyId: numberId(row.erpCompanyId),
    containerId: row.containerId == null ? null : numberId(row.containerId),
    importLogId: row.importLogId == null ? null : numberId(row.importLogId),
    importedAt: row.importedAt == null ? null : String(row.importedAt),
  };
}
export async function reserveFactoryTripPoReceipt(
  scope: FactoryTripPoReceiptScope, payloadFingerprint: string
): Promise<number> {
  await schemaReady();
  const already = await inspectFactoryTripPoReceipt(scope.companyId, scope.identity);
  if (already) {
    throw new FactoryTripPoReceiptError("FD_PO_DUPLICATE",
      already.status === "IMPORTED"
        ? `Factory truck already imported into ERP (container #${already.containerId}). It cannot be imported again.`
        : "A previous import attempt is pending reconciliation. Review its container/vouchers before attempting again.");
  }
  const [existingPo] = resultRows(await db.execute(sql`
    SELECT id FROM purchase_orders WHERE company_id=${scope.companyId}
      AND po_number=${scope.identity.poNumber} LIMIT 1
  `));
  if (existingPo) {
    throw new FactoryTripPoReceiptError("FD_PO_ALREADY_EXISTS",
      "This Factory dispatch PO already exists in ERP. Reconcile the existing purchase order instead of importing another.");
  }
  const [existingContainer] = resultRows(await db.execute(sql`
    SELECT id,status FROM containers WHERE container_number=${scope.identity.containerNumber} LIMIT 1
  `));
  if (existingContainer) {
    throw new FactoryTripPoReceiptError("FD_PO_CONTAINER_ALREADY_EXISTS",
      "This Factory trip container already exists in ERP. Do not import it again, even if it is an empty OTW placeholder.");
  }
  const [inserted] = resultRows(await db.execute(sql`
    INSERT INTO factory_dispatch_erp_po_receipts
      (erp_company_id,factory_company_id,factory_order_id,factory_dispatch_id,
       po_number,container_number,supplier_id,supplier_code,file_hash,
       payload_fingerprint,invoice_total,file_name,status,created_by_user_id)
    VALUES (
      ${scope.companyId},${scope.identity.factoryCompanyId},
      ${scope.identity.factoryOrderId},${scope.identity.factoryDispatchId},
      ${scope.identity.poNumber},${scope.identity.containerNumber},
      ${scope.supplierId},${scope.supplierCode},${scope.fileHash},
      ${payloadFingerprint},${scope.amount},${scope.fileName},
      'PENDING_REVIEW',${scope.userId}
    )
    ON CONFLICT DO NOTHING
    RETURNING id
  `));
  if (!inserted) {
    throw new FactoryTripPoReceiptError("FD_PO_DUPLICATE",
      "A Factory truck with this original dispatch identity was already reserved or imported, possibly in another ERP company. Review receipt history before proceeding.");
  }
  return numberId(inserted.id);
}
export async function completeFactoryTripPoReceipt(
  companyId: number, receiptId: number, containerId: number, importLogId: number
): Promise<void> {
  const [row] = resultRows(await db.execute(sql`
    UPDATE factory_dispatch_erp_po_receipts
       SET status='IMPORTED',container_id=${containerId},import_log_id=${importLogId},
           imported_at=NOW()
     WHERE id=${receiptId} AND erp_company_id=${companyId}
       AND status='PENDING_REVIEW' AND imported_at IS NULL
     RETURNING id
  `));
  if (!row) {
    throw new FactoryTripPoReceiptError("FD_PO_RECEIPT_FINISH_FAILED",
      "ERP import was written but its origin receipt could not be completed; stop and reconcile before any retry.");
  }
}

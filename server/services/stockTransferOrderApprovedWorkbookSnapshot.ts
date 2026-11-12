/**
 * Freeze the final quantity-only Excel source *inside* the same transaction as
 * all Stock Transfer Order approvals. Any post-approval edits must never
 * change the file destined for the original approving group and destination.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../db";
import { StockTransferOrderApprovalError, stockTransferOrderIntegerIdArray } from "./stockTransferOrderWhatsAppApprovalBatch";

export type ApprovedOrderNoCostRow = {
  stockItemName: string;
  sourceLocationName: string;
  quantity: number;
};
export type ApprovedOrderNoCostSnapshot = {
  companyName: string;
  destinationName: string;
  transferDate: string;
  batchKey: string;
  orderNumbers: string[];
  items: ApprovedOrderNoCostRow[];
};

const MAX_ROWS = 5000;
const MAX_JSON_BYTES = 2_000_000;

export function validateApprovedOrderNoCostSnapshot(raw: unknown): ApprovedOrderNoCostSnapshot {
  const s = raw as Partial<ApprovedOrderNoCostSnapshot> | null;
  if (!s || typeof s !== "object" ||
      !s.companyName || typeof s.companyName !== "string" ||
      !s.destinationName || typeof s.destinationName !== "string" ||
      typeof s.transferDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s.transferDate) ||
      typeof s.batchKey !== "string" || !/^[a-f0-9-]{36}$/i.test(s.batchKey) ||
      !Array.isArray(s.orderNumbers) || s.orderNumbers.length < 1 || s.orderNumbers.length > 100 ||
      s.orderNumbers.some(v => typeof v !== "string" || !v || v.length > 100) ||
      !Array.isArray(s.items) || s.items.length < 1 || s.items.length > MAX_ROWS) {
    throw new StockTransferOrderApprovalError("STO_WA_EXPORT_INVALID",
      "The approved Stock Transfer Order workbook snapshot is missing required information.");
  }
  for (const item of s.items) {
    if (!item || typeof item.stockItemName !== "string" || !item.stockItemName ||
        typeof item.sourceLocationName !== "string" || !item.sourceLocationName ||
        !Number.isFinite(item.quantity) || item.quantity <= 0 || item.quantity > 1_000_000_000) {
      throw new StockTransferOrderApprovalError("STO_WA_EXPORT_INVALID",
        "The approved Stock Transfer Order workbook contains invalid quantity data.");
    }
  }
  return s as ApprovedOrderNoCostSnapshot;
}

/** PostgreSQL jsonb reorders object keys: hash canonical object keys, not JS insertion order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    const entry = value as Record<string, unknown>;
    return "{" + Object.keys(entry).sort().map(key =>
      JSON.stringify(key) + ":" + canonical(entry[key])
    ).join(",") + "}";
  }
  return JSON.stringify(value);
}
export function snapshotSha256(snapshot: ApprovedOrderNoCostSnapshot): string {
  return createHash("sha256").update(canonical(snapshot)).digest("hex");
}

export async function freezeApprovedStockTransferOrderWorkbookTx(
  tx: DbTransaction,
  companyId: number,
  batchId: number,
  batchKey: string,
  destinationLocationId: number,
  transferIds: number[],
): Promise<ApprovedOrderNoCostSnapshot> {
  const headers = await tx.execute(sql`
    SELECT c.name AS company_name, d.name AS destination_name
      FROM companies c JOIN locations d ON d.company_id=c.id
     WHERE c.id=${companyId} AND d.id=${destinationLocationId}
  `);
  const header = headers.rows[0] as { company_name: string; destination_name: string } | undefined;
  if (!header) {
    throw new StockTransferOrderApprovalError("STO_WA_EXPORT_INVALID", "Company or destination no longer exists.");
  }
  const orders = await tx.execute(sql`
    SELECT bi.voucher_number_snapshot
      FROM stock_transfer_order_approval_batch_items bi
     WHERE bi.company_id=${companyId} AND bi.batch_id=${batchId}
       AND bi.transfer_id=ANY(${stockTransferOrderIntegerIdArray(transferIds)})
     ORDER BY bi.transfer_id
  `);
  if (orders.rows.length !== transferIds.length) {
    throw new StockTransferOrderApprovalError("STO_WA_EXPORT_INVALID", "Approved orders do not match the selected batch.");
  }

  // Deliberately select ONLY names, source locations and stock quantities.
  // No price, rate, total, cost, value_moved or journal data is passed through.
  const rows = await tx.execute(sql`
    SELECT i.name AS stock_item_name,
           COALESCE(src.name,'Unknown') AS source_location_name,
           SUM(ti.quantity)::text AS quantity
      FROM stock_transfer_order_approval_batch_items bi
      JOIN stock_transfer_vouchers t ON t.id=bi.transfer_id
      JOIN vouchers v ON v.id=t.voucher_id AND v.company_id=bi.company_id
      JOIN stock_transfer_items ti ON ti.transfer_id=t.id
      JOIN stock_items i ON i.id=ti.stock_item_id AND i.company_id=bi.company_id
      LEFT JOIN locations src ON src.id=ti.source_location_id AND src.company_id=bi.company_id
     WHERE bi.company_id=${companyId} AND bi.batch_id=${batchId}
       AND bi.transfer_id=ANY(${stockTransferOrderIntegerIdArray(transferIds)})
       AND v.deleted_at IS NULL
       AND t.workflow_origin='stock_transfer_order'
       AND t.destination_location_id=${destinationLocationId}
       AND ti.quantity > 0
     GROUP BY i.id,i.name,src.id,src.name
     ORDER BY src.name,i.name,i.id
  `);
  if (rows.rows.length < 1 || rows.rows.length > MAX_ROWS) {
    throw new StockTransferOrderApprovalError("STO_WA_EXPORT_INVALID",
      "The approved batch has no positive stock quantities or exceeds the workbook size limit.");
  }
  const now = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Beirut", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const snapshot = validateApprovedOrderNoCostSnapshot({
    companyName: String(header.company_name),
    destinationName: String(header.destination_name),
    transferDate: now,
    batchKey,
    orderNumbers: orders.rows.map(v => String((v as { voucher_number_snapshot: string }).voucher_number_snapshot)),
    items: rows.rows.map(v => ({
      stockItemName: String((v as { stock_item_name: string }).stock_item_name),
      sourceLocationName: String((v as { source_location_name: string }).source_location_name),
      quantity: Number((v as { quantity: string }).quantity),
    })),
  });
  const encoded = JSON.stringify(snapshot);
  if (Buffer.byteLength(encoded) > MAX_JSON_BYTES) {
    throw new StockTransferOrderApprovalError("STO_WA_EXPORT_INVALID", "Approved workbook exceeds its safe data limit.");
  }
  await tx.execute(sql`
    INSERT INTO stock_transfer_order_approval_workbooks
      (company_id,batch_id,snapshot_json,snapshot_sha256)
    VALUES (${companyId},${batchId},${encoded}::jsonb,${snapshotSha256(snapshot)})
    ON CONFLICT (company_id,batch_id) DO NOTHING
  `);
  return snapshot;
}

import type { RetailTransaction } from "./retailStockLedger";
import { allocateRetailBarcodes } from "./retailBarcodeService";
import {
  loadRetailSupplierCatalogSnapshot,
  planRetailSupplierCatalog,
  retailSupplierCatalogPreviewRowsSchema,
  type RetailSupplierCatalogDecision,
  type RetailSupplierCatalogInput,
} from "./retailSupplierCatalogPreview";

export type RetailSupplierBarcodeAction = "reuse" | "supplier" | "generate" | "conflict";
export interface RetailSupplierBarcodeIntent {
  action: RetailSupplierBarcodeAction;
  /** Existing or supplied literal barcode; null means reserved at confirmation only. */
  barcode: string | null;
  message: string;
}
export interface RetailSupplierBarcodeAssignment {
  rowNumber: number;
  barcode: string;
  barcodeSource: "generated" | "import";
  action: RetailSupplierBarcodeAction;
  existingVariantId: number | null;
}

/**
 * Preview is side-effect free: NEVER burn barcode sequences simply because the
 * user uploads Excel or changes a field in the dialog.
 */
export function describeRetailSupplierBarcode(
  row: { barcode: string },
  decision: RetailSupplierCatalogDecision
): RetailSupplierBarcodeIntent {
  if (decision.status === "conflict") {
    return { action: "conflict", barcode: null, message: "Resolve catalog conflicts before assigning a barcode" };
  }
  if (decision.status === "existing-variant") {
    return {
      action: "reuse",
      barcode: decision.existingBarcode,
      message: "Existing barcode is preserved; reprints and POS scans keep working",
    };
  }
  if (row.barcode.trim()) {
    return { action: "supplier", barcode: row.barcode.trim(), message: "Use supplier barcode as supplied" };
  }
  return { action: "generate", barcode: null, message: "Unique EAN-13 issued at final purchase confirmation" };
}

/**
 * Phase 3 transaction-only barcode resolution for Phase 4 supplier purchase.
 *
 * This must be called INSIDE the same purchase transaction that creates the
 * variant, receives stock, and posts supplier debt; it is not an HTTP route.
 * Recheck catalog identities in the transaction, allocate company-scoped
 * restricted-circulation EAN-13 values via the central sequence, and reserve
 * every supplier-provided barcode so generated values cannot collide with them.
 * A rolled-back purchase rolls back barcode sequence reservations as well.
 */
export async function resolveRetailSupplierBarcodesTx(
  tx: RetailTransaction,
  companyId: number,
  rawRows: RetailSupplierCatalogInput,
): Promise<RetailSupplierBarcodeAssignment[]> {
  if (!Number.isSafeInteger(companyId) || companyId < 1) {
    throw new Error("A valid Retail company is required for barcode resolution");
  }
  const rows = retailSupplierCatalogPreviewRowsSchema.parse(rawRows);
  const snapshot = await loadRetailSupplierCatalogSnapshot(tx, companyId);
  const plan = planRetailSupplierCatalog(rows, snapshot);
  if (plan.summary.conflicts) {
    const first = plan.decisions.find(row => row.status === "conflict");
    throw new Error(`Supplier barcode/catalog conflict at Excel row ${first?.rowNumber ?? "?"}: ${first?.messages.join("; ") ?? "Unknown conflict"}`);
  }
  if (plan.decisions.length !== rows.length) {
    throw new Error("Supplier barcode resolution produced an incomplete plan");
  }

  const reserved = new Set(rows.map(row => row.barcode.trim()).filter(Boolean));
  const generateCount = plan.decisions.filter(
    (decision, i) => decision.status !== "existing-variant" && !rows[i].barcode.trim()
  ).length;
  const generated = generateCount
    ? await allocateRetailBarcodes(tx, companyId, generateCount, reserved)
    : [];
  const consumed = new Set(reserved);
  let issuedIndex = 0;

  const assignments = rows.map((row, index): RetailSupplierBarcodeAssignment => {
    const decision = plan.decisions[index];
    const intent = describeRetailSupplierBarcode(row, decision);
    const barcode = intent.action === "generate" ? generated[issuedIndex++] : intent.barcode;
    if (!barcode) throw new Error(`No valid barcode for Excel row ${row.rowNumber}`);
    if (intent.action === "generate") {
      if (consumed.has(barcode)) throw new Error(`Duplicate generated retail barcode: ${barcode}`);
      consumed.add(barcode);
    }
    return {
      rowNumber: row.rowNumber,
      barcode,
      barcodeSource: intent.action === "generate" ? "generated" : "import",
      action: intent.action,
      existingVariantId: decision.variantId,
    };
  });
  if (issuedIndex !== generated.length) throw new Error("Generated barcode count mismatch");
  return assignments;
}

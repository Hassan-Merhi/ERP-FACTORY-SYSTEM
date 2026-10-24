import type { RetailTransaction } from "./retailStockLedger";
import {
  writeRetailSupplierCatalogLineTx,
  type RetailSupplierCatalogWriteLine,
} from "./retailSupplierCatalogWrites";
import {
  resolveRetailSupplierBarcodesTx,
  type RetailSupplierBarcodeAssignment,
} from "./retailSupplierBarcodeIntake";

/**
 * Phase 3 connection to Phase 2 catalog writes.
 *
 * CALL ONLY inside the Phase 4 confirmed purchase transaction that also posts
 * inventory, supplier payable and a durable import idempotency key. Never
 * expose this as an independent endpoint or call it from Excel preview.
 */
export type RetailSupplierPreparedCatalogLine =
  Omit<RetailSupplierCatalogWriteLine, "barcodeSource"> & { rowNumber: number };

export interface RetailSupplierCatalogBatchResult {
  rows: Array<{
    rowNumber: number;
    productId: number;
    variantId: number;
    barcode: string;
    action: RetailSupplierBarcodeAssignment["action"];
    newProduct: boolean;
    newVariant: boolean;
  }>;
}

/**
 * Reconciles all incoming rows with the company catalog, reserves unique
 * EAN-13s for missing new-variant barcodes, then creates/reuses product and
 * variant identities. The caller controls the transaction commit/rollback.
 */
export async function writeRetailSupplierCatalogBatchTx(
  tx: RetailTransaction,
  companyId: number,
  lines: RetailSupplierPreparedCatalogLine[]
): Promise<RetailSupplierCatalogBatchResult> {
  const seen = new Set<number>();
  for (const line of lines) {
    if (!Number.isSafeInteger(line.rowNumber) || line.rowNumber < 2) {
      throw new Error("Every supplier line needs its original Excel row number");
    }
    if (seen.has(line.rowNumber)) {
      throw new Error(`Duplicate Excel row in supplier purchase: ${line.rowNumber}`);
    }
    seen.add(line.rowNumber);
  }
  const resolutions = await resolveRetailSupplierBarcodesTx(
    tx, companyId,
    lines.map(line => ({
      rowNumber: line.rowNumber,
      name: line.name,
      brand: line.brand,
      category: line.category,
      color: line.color,
      size: line.size,
      sku: line.sku ?? "",
      barcode: line.barcode ?? "",
    }))
  );
  if (resolutions.length !== lines.length) throw new Error("Supplier barcode allocations are incomplete");

  const rows: RetailSupplierCatalogBatchResult["rows"] = [];
  for (const [index, line] of lines.entries()) {
    const assigned = resolutions[index];
    if (assigned.rowNumber !== line.rowNumber) {
      throw new Error("Supplier barcode and catalog row order does not match");
    }
    const result = await writeRetailSupplierCatalogLineTx(tx, companyId, {
      ...line,
      barcode: assigned.barcode,
      barcodeSource: assigned.action === "generate" ? "generated" : "import",
    });
    if (assigned.existingVariantId !== null &&
        result.variantId !== assigned.existingVariantId) {
      throw new Error(`Existing supplier variant changed during processing (row ${line.rowNumber})`);
    }
    if (assigned.action !== "generate" && result.newVariant &&
        assigned.action === "reuse") {
      throw new Error(`An existing barcode cannot create a new variant (row ${line.rowNumber})`);
    }
    rows.push({
      rowNumber: line.rowNumber,
      productId: result.productId,
      variantId: result.variantId,
      barcode: assigned.barcode,
      action: assigned.action,
      newProduct: result.newProduct,
      newVariant: result.newVariant,
    });
  }
  return { rows };
}

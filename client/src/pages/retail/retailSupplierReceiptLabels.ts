import type { RetailLabelRequestItem } from "./retailLabels";
import type { RetailSupplierImportRow } from "./retailSupplierImportDraft";

/** Received quantities from the committed supplier receipt, NOT current inventory. */
export interface RetailSupplierReceiptLine {
  rowNumber: number;
  variantId: number;
  barcode: string;
  quantity: number;
}

export interface RetailSupplierReceiptLabelItem extends RetailLabelRequestItem {
  receivedQuantity: number;
}

/**
 * Build print targets exclusively from the server-confirmed receipt.
 * Excel fields are only used for display names, never for quantities,
 * variant IDs or printable barcodes.
 */
export function buildRetailSupplierReceiptLabelItems(
  confirmed: RetailSupplierReceiptLine[],
  excelRows: Pick<RetailSupplierImportRow, "rowNumber" | "name" | "brand" | "color" | "size">[],
): RetailSupplierReceiptLabelItem[] {
  const namesByRow = new Map(excelRows.map(row => [row.rowNumber, row]));
  const byVariant = new Map<number, RetailSupplierReceiptLabelItem>();
  for (const line of confirmed) {
    if (!Number.isSafeInteger(line.variantId) || line.variantId <= 0 ||
        !Number.isSafeInteger(line.quantity) || line.quantity <= 0 ||
        !line.barcode?.trim()) {
      throw new Error("A saved supplier receipt has invalid barcode label data");
    }
    const old = byVariant.get(line.variantId);
    if (old) {
      if (old.barcode !== line.barcode) throw new Error("Receipt rows disagree about the same variant barcode");
      const sum = old.receivedQuantity + line.quantity;
      if (!Number.isSafeInteger(sum)) throw new Error("Received label count exceeds supported range");
      old.receivedQuantity = sum;
      continue;
    }
    const row = namesByRow.get(line.rowNumber);
    const title = row ? `${row.brand} · ${row.name} · ${row.color} / ${row.size || "One Size"}` : line.barcode;
    byVariant.set(line.variantId, {
      variantId: line.variantId,
      barcode: line.barcode,
      title,
      receivedQuantity: line.quantity,
    });
  }
  return [...byVariant.values()];
}

export const RETAIL_RECEIPT_LABEL_JOB_LIMIT = 500;

export interface RetailReceiptPrintLine {
  variantId: number;
  copies: number;
}

/**
 * Each batch is at most 500 physical labels total. The existing /api/retail/labels
 * endpoint also caps each variant at 500, so this stays within both limits.
 * Unselected variants keep their full unprinted receipt quantities.
 */
export function planRetailReceiptLabelJob(
  items: RetailSupplierReceiptLabelItem[],
  remaining: Readonly<Record<number, number>>,
  selected: ReadonlySet<number>,
  limit = RETAIL_RECEIPT_LABEL_JOB_LIMIT,
): RetailReceiptPrintLine[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Invalid label print job limit");
  const output: RetailReceiptPrintLine[] = [];
  let capacity = limit;
  for (const item of items) {
    if (!selected.has(item.variantId) || capacity === 0) continue;
    const pending = remaining[item.variantId] ?? 0;
    if (!Number.isSafeInteger(pending) || pending < 0) throw new Error("Invalid pending receipt labels");
    const copies = Math.min(pending, capacity);
    if (copies > 0) {
      output.push({ variantId: item.variantId, copies });
      capacity -= copies;
    }
  }
  return output;
}

// Extracted from ./posImportRoutes.ts to keep that module under the source-size cap.
import type { InventoryNumericInput } from "../lib/inventoryMath";
import { createDatabaseStockMovementAdapter } from "../services/inventory/databaseStockMovementAdapter";

/**
 * One POS-import line: what the parse endpoint emits, and what the validate and
 * import endpoints read back off `req.body`.
 *
 * These were carried as `any[]`, so a spreadsheet column the parser stopped
 * recognising reached the sales voucher as `undefined` rather than as a row the
 * importer skipped.
 */
export interface PosImportItem {
  rowNum: number;
  barcode: string;
  quantity: number;
  rate: number;
  value: number;
}

/** A POS-import line annotated by the validate endpoint. */
export interface ValidatedPosImportItem extends PosImportItem {
  error?: string;
  warning?: string;
  stockItemId?: number;
  stockItemName?: string;
  stockItemUom?: string;
  costPrice?: number;
  currentStock?: number;
  remainingStock?: number;
}

/**
 * The first of the given columns the row actually carries. Spreadsheet headers
 * vary in case and wording, and cells arrive as text or numbers, so the value is
 * returned as the sheet parser yielded it — the callers below test it for
 * truthiness, where a numeric 0 and the string "0" differ.
 */
export function firstPresent(row: Record<string, unknown>, ...columns: string[]): unknown {
  for (const column of columns) {
    const value = row[column];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

/** The same, narrowed to what the inventory math accepts; anything else reads as absent. */
export function firstNumeric(row: Record<string, unknown>, ...columns: string[]): InventoryNumericInput {
  const value = firstPresent(row, ...columns);
  return typeof value === "number" || typeof value === "string" ? value : undefined;
}

export const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

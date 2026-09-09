import { isRecord, toFiniteNumber } from "@shared/typeGuards";
import { storage } from "../../storage";
import type { StockItem } from "@shared/schema";

/**
 * The shape the PO-import routes require of the `preview` payload posted back
 * from the import wizard.
 *
 * `preview` arrives on `req.body`, so it is client-supplied and unvalidated; the
 * handlers previously reached into it through `(p: any)` and `items as any[]`,
 * then cast the array wholesale. Declaring what is actually read — and validating
 * it here rather than trusting a cast — means a payload the wizard stops sending
 * is rejected at the boundary instead of surfacing as `undefined` inside a
 * purchase-order total or a `TypeError` partway through the write.
 */
export interface PoImportPreviewItem {
  poNumber: string;
  barcode: string;
  itemName: string;
  quantity: number;
  rate: number;
  lineTotal: number;
  currency?: string;
  stockItemId?: number | null;
}

export interface PoImportPreviewCharges {
  freight?: number;
  surcharge?: number;
  fumigation?: number;
  documentCharges?: number;
  discount?: number;
  otherCharges?: number;
}

export interface PoImportPreviewContainer {
  containerNumber: string;
  items: PoImportPreviewItem[];
  charges: PoImportPreviewCharges;
  itemsCount: number;
  itemsTotal: number;
  chargesTotal: number;
  grandTotal: number;
}

/** A trimmed string from an unknown field, or `""` when the field is absent or not a string. */
function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * One preview line. Money fields go through `toFiniteNumber`, so a quantity or
 * line total the wizard sends as a numeric string becomes a number here rather
 * than string-concatenating into the purchase-order totals downstream. A line
 * whose money fields cannot be read is rejected outright.
 */
function parsePreviewItem(value: unknown): PoImportPreviewItem | null {
  if (!isRecord(value)) return null;

  const quantity = toFiniteNumber(value.quantity);
  const rate = toFiniteNumber(value.rate);
  const lineTotal = toFiniteNumber(value.lineTotal);
  if (quantity === undefined || rate === undefined || lineTotal === undefined) return null;

  const stockItemId = toFiniteNumber(value.stockItemId);
  const currency = optionalString(value.currency);

  return {
    poNumber: optionalString(value.poNumber),
    barcode: optionalString(value.barcode),
    itemName: optionalString(value.itemName),
    quantity,
    rate,
    lineTotal,
    ...(currency ? { currency } : {}),
    stockItemId: stockItemId === undefined ? null : stockItemId,
  };
}

/** The charge block, defaulting each absent charge to absent rather than zero. */
function parsePreviewCharges(value: unknown): PoImportPreviewCharges {
  if (!isRecord(value)) return {};
  const charges: PoImportPreviewCharges = {};
  const keys = ["freight", "surcharge", "fumigation", "documentCharges", "discount", "otherCharges"] as const;
  for (const key of keys) {
    const amount = toFiniteNumber(value[key]);
    if (amount !== undefined) charges[key] = amount;
  }
  return charges;
}

/**
 * The posted preview entry for one container, or `null` when the payload does
 * not contain a usable entry for it. Callers turn `null` into a 400 rather than
 * walking into the entry and throwing.
 */
export function findPreviewContainer(preview: unknown, containerNumber: string): PoImportPreviewContainer | null {
  if (!Array.isArray(preview)) return null;

  const entry = preview.find((candidate) => isRecord(candidate) && candidate.containerNumber === containerNumber);
  if (!isRecord(entry)) return null;

  if (!Array.isArray(entry.items)) return null;
  const items: PoImportPreviewItem[] = [];
  for (const raw of entry.items) {
    const item = parsePreviewItem(raw);
    if (!item) return null;
    items.push(item);
  }

  const itemsTotal = toFiniteNumber(entry.itemsTotal);
  const chargesTotal = toFiniteNumber(entry.chargesTotal);
  const grandTotal = toFiniteNumber(entry.grandTotal);
  if (itemsTotal === undefined || chargesTotal === undefined || grandTotal === undefined) return null;

  return {
    containerNumber,
    items,
    charges: parsePreviewCharges(entry.charges),
    itemsCount: toFiniteNumber(entry.itemsCount) ?? items.length,
    itemsTotal,
    chargesTotal,
    grandTotal,
  };
}

/**
 * The per-line problems both PO-import endpoints report: barcodes repeated
 * within one import, and lines that match no stock item by code/alias or name.
 * Both endpoints ran this identical loop against differently-named error arrays.
 */
export async function collectPreviewItemErrors(
  items: readonly PoImportPreviewItem[],
  companyId: number,
  allStockItems: readonly StockItem[]
): Promise<string[]> {
  const errors: string[] = [];
  const seenBarcodes = new Set<string>();

  for (const item of items) {
    // Check for duplicate barcodes in the import
    if (item.barcode && seenBarcodes.has(item.barcode)) {
      errors.push(`Duplicate barcode in import: ${item.barcode}`);
    } else if (item.barcode) {
      seenBarcodes.add(item.barcode);
    }

    // Try to find stock item by code/alias first, then by name
    let stockItem = null;
    if (item.barcode) {
      stockItem = await storage.getStockItemByCodeOrAlias(item.barcode, companyId);
    }
    if (!stockItem && item.itemName) {
      stockItem = allStockItems.find((si) => si.name === item.itemName);
    }

    if (!stockItem) {
      if (item.barcode) {
        errors.push(`Item not found: code ${item.barcode} (${item.itemName})`);
      } else {
        errors.push(`Item not found by name: ${item.itemName}`);
      }
    }
  }

  return errors;
}

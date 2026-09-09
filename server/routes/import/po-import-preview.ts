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

/**
 * A trimmed string from an unknown field, or `""` when the field is absent.
 *
 * Numbers and booleans are stringified rather than dropped: the import wizard
 * builds this payload from spreadsheet cells, so a numeric PO number or barcode
 * arrives as a number. These values were previously used raw — as object keys
 * when grouping by PO number, and interpolated into messages — so stringifying
 * matches what they already became at the point of use.
 */
function optionalString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return String(value);
  return "";
}

/**
 * One preview line. Money fields go through `toFiniteNumber`, so a quantity or
 * line total the wizard sends as a numeric string becomes a number rather than
 * string-concatenating into the purchase-order totals downstream.
 *
 * A money field the payload does not carry reads as 0 here and is reported
 * through `linesWithUnreadableMoney` rather than rejecting the whole payload:
 * the validate endpoint exists to report per-line problems, and is called with
 * previews that legitimately carry no quantities yet. The import endpoint, which
 * writes these figures, refuses the payload when that list is non-empty.
 */
function parsePreviewItem(value: unknown): { item: PoImportPreviewItem; moneyReadable: boolean } | null {
  if (!isRecord(value)) return null;

  const quantity = toFiniteNumber(value.quantity);
  const rate = toFiniteNumber(value.rate);
  const lineTotal = toFiniteNumber(value.lineTotal);

  const stockItemId = toFiniteNumber(value.stockItemId);
  const currency = optionalString(value.currency);

  return {
    item: {
      poNumber: optionalString(value.poNumber),
      barcode: optionalString(value.barcode),
      itemName: optionalString(value.itemName),
      quantity: quantity ?? 0,
      rate: rate ?? 0,
      lineTotal: lineTotal ?? 0,
      ...(currency ? { currency } : {}),
      stockItemId: stockItemId === undefined ? null : stockItemId,
    },
    moneyReadable: quantity !== undefined && rate !== undefined && lineTotal !== undefined,
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

/** A parsed preview entry, alongside what the payload failed to carry as money. */
export interface PreviewContainerParse {
  container: PoImportPreviewContainer;
  /** 1-based line numbers whose quantity, rate or line total was not a readable number. */
  linesWithUnreadableMoney: number[];
  /** Container total names that were not readable numbers. */
  unreadableTotals: string[];
}

/**
 * The posted preview entry for one container, or `null` when the payload carries
 * no usable entry for it. Callers turn `null` into a rejection rather than
 * walking into the entry and throwing.
 *
 * Parsing is deliberately lenient about missing money so the validate endpoint
 * can still report the per-line problems it exists to report; what could not be
 * read is returned alongside, for the import endpoint to refuse on.
 */
export function findPreviewContainer(preview: unknown, containerNumber: string): PreviewContainerParse | null {
  if (!Array.isArray(preview)) return null;

  const entry = preview.find((candidate) => isRecord(candidate) && candidate.containerNumber === containerNumber);
  if (!isRecord(entry)) return null;
  if (!Array.isArray(entry.items)) return null;

  const items: PoImportPreviewItem[] = [];
  const linesWithUnreadableMoney: number[] = [];
  for (const [index, raw] of entry.items.entries()) {
    const parsed = parsePreviewItem(raw);
    if (!parsed) return null;
    items.push(parsed.item);
    if (!parsed.moneyReadable) linesWithUnreadableMoney.push(index + 1);
  }

  const itemsTotal = toFiniteNumber(entry.itemsTotal);
  const chargesTotal = toFiniteNumber(entry.chargesTotal);
  const grandTotal = toFiniteNumber(entry.grandTotal);
  const unreadableTotals: string[] = [];
  if (itemsTotal === undefined) unreadableTotals.push("itemsTotal");
  if (chargesTotal === undefined) unreadableTotals.push("chargesTotal");
  if (grandTotal === undefined) unreadableTotals.push("grandTotal");

  return {
    container: {
      containerNumber,
      items,
      charges: parsePreviewCharges(entry.charges),
      itemsCount: toFiniteNumber(entry.itemsCount) ?? items.length,
      itemsTotal: itemsTotal ?? 0,
      chargesTotal: chargesTotal ?? 0,
      grandTotal: grandTotal ?? 0,
    },
    linesWithUnreadableMoney,
    unreadableTotals,
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

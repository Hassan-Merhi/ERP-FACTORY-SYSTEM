import type { StockItem } from "@shared/schema";
import { parseMoneyInput } from "../../lib/money";

/**
 * The container-import spreadsheet (the "PO Import" Excel every ERP company
 * receives from its supplier), parsed into per-container previews.
 *
 * This is the one reader of that sheet. `POST /api/po-import/parse` has always
 * used it for ERP companies; the Supplier Partner Excel import reads the very
 * same file through the same function so both company types agree on what a
 * row, a charge and a container total mean. Only the posting that follows the
 * preview differs between them.
 *
 * `sheetToJson` yields one record per row keyed by header name, with each cell
 * left as the workbook held it — text, a number, or a boolean. A renamed column
 * or a cell of an unexpected type is reported as a row error rather than
 * reaching the preview as `undefined`.
 */
export type ImportSheetRow = Record<string, unknown>;

/** One item line parsed out of the sheet, before container grouping. */
export interface ParsedItemRow {
  rowNum: number;
  poNumber: string;
  containerNumber: string;
  supplierCode: string;
  barcode: string | null;
  stockItemId: number | null;
  itemName: string;
  quantity: number;
  rate: number;
  lineTotal: number;
  currency: string;
  freight: number;
  surcharge: number;
  fumigation: number;
  discount: number;
  documentCharges: number;
}

/** One charge line parsed out of the sheet, when charges arrive as their own rows. */
export interface ParsedChargeRow {
  rowNum: number;
  chargeType: string;
  amount: number;
  containerNumber: string;
}

/** Item lines grouped by container, and by PO number within each container. */
interface ContainerGroup {
  containerNumber: string;
  supplierCode: string;
  items: ParsedItemRow[];
  pos: Map<string, ParsedItemRow[]>;
}

export interface ParsedContainerCharges {
  freight: number;
  surcharge: number;
  fumigation: number;
  discount: number;
  documentCharges: number;
}

/** One container of the sheet with its totals, exactly as the import wizard shows it. */
export interface ParsedContainerPreview {
  containerNumber: string;
  supplierCode: string;
  itemsCount: number;
  posCount: number;
  itemsTotal: number;
  charges: ParsedContainerCharges;
  chargesTotal: number;
  grandTotal: number;
  items: ParsedItemRow[];
  pos: string[];
}

export interface PoImportSheetLookups {
  /** Stock item matched by code or alias within the importing company. */
  getStockItemByCodeOrAlias: (codeOrAlias: string) => Promise<StockItem | undefined>;
  /** Every stock item of the importing company, used for the name fallback. */
  allStockItems: readonly StockItem[];
}

export type PoImportSheetResult =
  | { ok: true; preview: ParsedContainerPreview[] }
  | { ok: false; kind: "row-errors"; errors: string[] }
  | { ok: false; kind: "no-items" };

/**
 * Column value with flexible naming, returned as the sheet parser yielded it.
 * Several checks test it for truthiness, where a numeric 0 and the string "0"
 * behave differently, so it is deliberately not stringified here.
 */
function getColumnValue(row: ImportSheetRow, ...possibleNames: string[]): unknown {
  for (const name of possibleNames) {
    if (row[name] !== undefined && row[name] !== null && row[name] !== "") {
      return row[name];
    }
  }
  return undefined;
}

/** A column as text, or "" when absent. */
function columnText(row: ImportSheetRow, ...possibleNames: string[]): string {
  const value = getColumnValue(row, ...possibleNames);
  return value === undefined ? "" : String(value);
}

/** A column as a number read the way parseFloat reads it; NaN when it does not parse. */
function columnNumber(row: ImportSheetRow, ...possibleNames: string[]): number {
  return parseMoneyInput(String(getColumnValue(row, ...possibleNames) || "0"))?.toNumber() ?? NaN;
}

export async function parsePoImportSheetRows(
  rows: ImportSheetRow[],
  lookups: PoImportSheetLookups
): Promise<PoImportSheetResult> {
  const errors: string[] = [];
  const itemRows: ParsedItemRow[] = [];
  const chargeRows: ParsedChargeRow[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;

    // Check if it's a charge row or item row
    const chargeType = getColumnValue(row, "Charge_Type", "Charge Type");
    const chargeAmount = getColumnValue(row, "Charge_Amount", "Charge Amount");
    if (chargeType && chargeAmount) {
      chargeRows.push({
        rowNum,
        chargeType: String(chargeType),
        amount: parseMoneyInput(String(chargeAmount))?.toNumber() ?? NaN,
        containerNumber: columnText(row, "Container_Number", "Container Number"),
      });
    } else if (getColumnValue(row, "Item_Barcode", "Item Barcode") || getColumnValue(row, "Item_Name", "Item Name")) {
      let stockItem: StockItem | undefined;
      const itemBarcode = columnText(row, "Item_Barcode", "Item Barcode");
      const itemNameValue = columnText(row, "Item_Name", "Item Name");
      let itemName = itemNameValue;

      // Try to find stock item by code/alias or name (for preview purposes only - validation happens in validate step)
      if (itemBarcode) {
        stockItem = await lookups.getStockItemByCodeOrAlias(itemBarcode);
        if (stockItem) {
          itemName = stockItem.name;
        }
      } else if (itemNameValue) {
        stockItem = lookups.allStockItems.find((item) => item.name === itemNameValue);
      }

      const quantity = columnNumber(row, "Quantity");
      const rate = columnNumber(row, "Rate");

      if (quantity === 0 || isNaN(quantity)) {
        errors.push(`Row ${rowNum}: Quantity must be a non-zero number (negative quantities are allowed)`);
        continue;
      }

      if (rate === undefined || rate < 0) {
        errors.push(`Row ${rowNum}: Rate must be non-negative`);
        continue;
      }

      itemRows.push({
        rowNum,
        poNumber: columnText(row, "PO_Number", "PO Number"),
        containerNumber: columnText(row, "Container_Number", "Container Number"),
        supplierCode: columnText(row, "Supplier_Code", "Supplier Code"),
        barcode: itemBarcode || null,
        stockItemId: stockItem?.id || null,
        itemName: itemName,
        quantity: quantity,
        rate: rate,
        lineTotal: quantity * rate,
        currency: columnText(row, "Currency") || "USD",
        freight: columnNumber(row, "Freight"),
        surcharge: columnNumber(row, "Surcharge"),
        fumigation: columnNumber(row, "Fumigation"),
        discount: columnNumber(row, "Discount"),
        documentCharges: columnNumber(row, "Document_Charges", "Document Charges"),
      });
    }
  }

  // Basic structural errors only (validation of item existence happens in validate step)
  if (errors.length > 0) {
    return { ok: false, kind: "row-errors", errors };
  }

  if (itemRows.length === 0) {
    return { ok: false, kind: "no-items" };
  }

  // Group by container
  const containerGroups = itemRows.reduce<Record<string, ContainerGroup>>((acc, row) => {
    if (!acc[row.containerNumber]) {
      acc[row.containerNumber] = {
        containerNumber: row.containerNumber,
        supplierCode: row.supplierCode,
        items: [],
        pos: new Map(),
      };
    }

    const container = acc[row.containerNumber];
    container.items.push(row);

    if (!container.pos.has(row.poNumber)) {
      container.pos.set(row.poNumber, []);
    }
    container.pos.get(row.poNumber)!.push(row);

    return acc;
  }, {});

  // Calculate container totals
  const preview = Object.values(containerGroups).map((container): ParsedContainerPreview => {
    const itemsTotal = container.items.reduce((sum, item) => sum + item.lineTotal, 0);

    // Get charges from rows or aggregate from columns
    const charges: ParsedContainerCharges = {
      freight: 0,
      surcharge: 0,
      fumigation: 0,
      discount: 0,
      documentCharges: 0,
    };

    // Check if charges are in separate rows
    const containerCharges = chargeRows.filter((c) => c.containerNumber === container.containerNumber);
    if (containerCharges.length > 0) {
      containerCharges.forEach((charge) => {
        const chargeType = (charge.chargeType || "").toLowerCase().replace(/[_\s]/g, "");
        if (chargeType === "freight") charges.freight = charge.amount;
        else if (chargeType === "surcharge") charges.surcharge = charge.amount;
        else if (chargeType === "fumigation") charges.fumigation = charge.amount;
        else if (chargeType === "discount") charges.discount = charge.amount;
        else if (chargeType.includes("document")) charges.documentCharges = charge.amount;
      });
    } else {
      // Aggregate from item row columns
      container.items.forEach((item) => {
        charges.freight += item.freight;
        charges.surcharge += item.surcharge;
        charges.fumigation += item.fumigation;
        charges.discount += item.discount;
        charges.documentCharges += item.documentCharges;
      });
    }

    const chargesTotal =
      charges.freight + charges.surcharge + charges.fumigation + charges.documentCharges - charges.discount;
    const grandTotal = itemsTotal + chargesTotal;

    return {
      containerNumber: container.containerNumber,
      supplierCode: container.supplierCode,
      itemsCount: container.items.length,
      posCount: container.pos.size,
      itemsTotal,
      charges,
      chargesTotal,
      grandTotal,
      items: container.items,
      pos: Array.from(container.pos.keys()),
    };
  });

  return { ok: true, preview };
}

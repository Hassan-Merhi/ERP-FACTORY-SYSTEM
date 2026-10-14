import type { StockItem, StockTransferFormData } from "../stocktransferform/types";
import type { TransferInventoryItem } from "./useTransferFormDerived";

type Entry = StockTransferFormData["entries"][number];

export type PosTransferImportResult = {
  entries: Entry[];
  errors: string[];
};

function cleanCode(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function valueFor(row: Record<string, unknown>, keys: readonly string[]): unknown {
  const byHeader = new Map(
    Object.entries(row).map(([key, value]) => [key.toLowerCase().replace(/[^a-z0-9]/g, ""), value])
  );
  for (const key of keys) {
    const value = byHeader.get(key);
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return undefined;
}

/**
 * POS imports only populate the current transfer form. They never post stock:
 * the usual Save Transfer endpoint remains responsible for authorization,
 * inventory movements, voucher creation and WhatsApp notifications.
 */
export function buildPosTransferImportEntries(
  rows: Record<string, unknown>[],
  stockItems: StockItem[],
  sourceInventory: TransferInventoryItem[],
  sourceLocationId: number,
  sourceLocationName: string
): PosTransferImportResult {
  const errors: string[] = [];
  const entries = new Map<number, Entry>();
  if (!Number.isInteger(sourceLocationId) || sourceLocationId <= 0 || !sourceLocationName) {
    return { entries: [], errors: ["Select your authorized From location before importing."] };
  }

  const itemsByCode = new Map(stockItems.filter((item) => item.code).map((item) => [cleanCode(item.code), item]));
  const inventoryByCode = new Map(
    sourceInventory.filter((item) => item.stockItemCode).map((item) => [cleanCode(item.stockItemCode), item])
  );
  const inventoryById = new Map(sourceInventory.map((item) => [item.stockItemId, item]));

  for (const [index, row] of rows.entries()) {
    const code = cleanCode(valueFor(row, ["barcode", "itemcode", "stockcode", "code", "sku"]));
    const quantityValue = valueFor(row, ["quantity", "qty"]);
    if (!code && (quantityValue === undefined || String(quantityValue).trim() === "")) continue;

    const qty = typeof quantityValue === "number"
      ? quantityValue
      : Number(String(quantityValue ?? "").trim().replace(/,/g, ""));
    if (!code) {
      errors.push(`Row ${index + 2}: Item Code/Barcode is required.`);
      continue;
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      errors.push(`Row ${index + 2}: Quantity for ${code} must be greater than zero.`);
      continue;
    }
    const stockItem = itemsByCode.get(code);
    const inventoryItem = inventoryByCode.get(code) ??
      (stockItem ? inventoryById.get(stockItem.id) : undefined);
    const itemId = stockItem?.id ?? inventoryItem?.stockItemId;
    if (!itemId) {
      errors.push(`Row ${index + 2}: ${code} was not found in this company's stock items.`);
      continue;
    }
    const previous = entries.get(itemId);
    const totalQty = (previous ? Number(previous.quantity) : 0) + qty;
    if (!Number.isFinite(totalQty)) {
      errors.push(`Row ${index + 2}: Quantity for ${code} is too large.`);
      continue;
    }
    entries.set(itemId, {
      sourceLocationId,
      sourceLocationName,
      stockItemId: itemId,
      stockItemCode: stockItem?.code ?? inventoryItem?.stockItemCode ?? code,
      stockItemName: stockItem?.name ?? inventoryItem?.stockItemName ?? code,
      quantity: String(totalQty),
      rate: inventoryItem?.averageRate ?? "",
    });
  }
  if (entries.size === 0 && errors.length === 0) {
    errors.push("No stock items found. Use columns Item Code and Quantity, with one item per row.");
  }
  return { entries: [...entries.values()], errors };
}

export async function parsePosTransferImportFile(
  file: File,
  stockItems: StockItem[],
  sourceInventory: TransferInventoryItem[],
  sourceLocationId: number,
  sourceLocationName: string
): Promise<PosTransferImportResult> {
  if (!/\.(xlsx|csv)$/i.test(file.name)) {
    return { entries: [], errors: ["Upload an .xlsx or .csv spreadsheet."] };
  }
  if (file.size > 10 * 1024 * 1024) {
    return { entries: [], errors: ["File exceeds the 10 MB limit."] };
  }

  const { read, utils } = await import("@/lib/excelHelper");
  const workbook = await read(file);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return { entries: [], errors: ["Spreadsheet has no worksheet."] };
  const rows = utils.sheet_to_json<Record<string, unknown>>(sheet);
  return buildPosTransferImportEntries(rows, stockItems, sourceInventory, sourceLocationId, sourceLocationName);
}

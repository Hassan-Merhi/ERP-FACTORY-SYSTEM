/**
 * XLSX-only import and a blank Excel template for loading-specific extra items.
 * No rows touch the original customer proforma.
 */
import * as XLSX from "@/lib/excelHelper";

export type ContainerExtraImportRow = {
  articleCode: string;
  quantity: number;
  priceInput: string;
};

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  return Number(String(value ?? "").trim().replace(/[$,]/g, ""));
}

export async function parseContainerExtraExcel(file: File): Promise<ContainerExtraImportRow[]> {
  if (!/\\.xlsx$/i.test(file.name)) throw new Error("Choose an .xlsx Excel workbook");
  if (file.size > 5 * 1024 * 1024) throw new Error("Workbook is too large (maximum 5 MB)");
  const book = await XLSX.read(await file.arrayBuffer(), { type: "array" });
  const sheet = book.Sheets[book.SheetNames[0]];
  if (!sheet) throw new Error("Excel workbook has no worksheet");
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  const headerNames = Object.keys(rows[0] ?? {});
  const headerFor = (...aliases: string[]) =>
    headerNames.find((header) => aliases.includes(normalizeHeader(header)));
  const codeHeader = headerFor("articlecode", "code", "productcode");
  const qtyHeader = headerFor("quantity", "qty", "extrabales", "bales", "expectedqty");
  const priceHeader = headerFor("priceperbaleoptional", "priceperbale", "price", "sellingprice", "manualprice");
  if (!codeHeader || !qtyHeader)
    throw new Error("Excel must have Article Code and Quantity columns. Use Download Template.");
  const imported: ContainerExtraImportRow[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const code = String(row[codeHeader] ?? "").trim().toUpperCase();
    const qtyValue = row[qtyHeader];
    const optionalPrice = priceHeader ? row[priceHeader] : "";
    if (!code && String(qtyValue ?? "").trim() === "" && String(optionalPrice ?? "").trim() === "") return;
    const qty = asNumber(qtyValue);
    if (!code || code.length > 100 || !Number.isSafeInteger(qty) || qty < 1 || qty > 100000)
      throw new Error(`Excel row ${index + 2}: enter an article code and whole quantity (1–100000)`);
    if (seen.has(code))
      throw new Error(`Excel row ${index + 2}: duplicate ${code}. Combine the quantities into one row.`);
    seen.add(code);
    const priceInput = String(optionalPrice ?? "").trim().replace(/[$,]/g, "");
    if (priceInput && (!/^\\d+(?:\\.\\d{1,4})?$/.test(priceInput) || Number(priceInput) > 99999999))
      throw new Error(`Excel row ${index + 2}: price must be non-negative, with up to four decimals`);
    imported.push({ articleCode: code, quantity: qty, priceInput });
  });
  if (imported.length < 1 || imported.length > 500)
    throw new Error("Excel must contain between 1 and 500 items");
  return imported;
}

export async function downloadContainerExtraTemplate(): Promise<void> {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([["Article Code", "Quantity", "Price Per Bale (optional)"]]);
  ws["!cols"] = [{ wch: 24 }, { wch: 18 }, { wch: 30 }];
  XLSX.utils.book_append_sheet(wb, ws, "Additional Items");
  const guide = XLSX.utils.aoa_to_sheet([
    ["Additional container items — instructions"],
    ["Fill Article Code and Quantity on the Additional Items tab."],
    ["Price Per Bale is optional. Leave blank to use customer agreed price, then catalog selling price."],
    ["If neither price exists, the item is saved at 0 so you can set its price later."],
    ["You can enter a custom per-bale price in the template or in the import preview."],
    ["One row per article. Maximum 500 article rows per import."],
    ["Only the selected loading is changed; the original proforma remains unchanged."],
  ]);
  guide["!cols"] = [{ wch: 100 }];
  XLSX.utils.book_append_sheet(wb, guide, "Instructions");
  await XLSX.writeFile(wb, "container-additional-items-template.xlsx");
}

import * as XLSX from "@/lib/excelHelper";

export type BaleImportPreviewRow = { articleCode: string; qty: number };

export type BaleImportParseResult =
  { mode: "refNumber"; refNumbers: string[] } | { mode: "articleCode"; rows: BaleImportPreviewRow[] };

/** Toast description shown when a sheet parses to no usable rows in the detected mode. */
export const BALE_IMPORT_EMPTY_HINT: Record<BaleImportParseResult["mode"], string> = {
  refNumber: "Ensure the Ref / Ref Code column has values",
  articleCode: "Ensure columns are Article Code and Qty, or use a Ref Number column for individual bale import",
};

export function baleImportRowCount(result: BaleImportParseResult): number {
  return result.mode === "refNumber" ? result.refNumbers.length : result.rows.length;
}

/**
 * Parse the first sheet of a bulk bale import workbook. A "Ref" / "Reference" /
 * "Ref Number" / "Ref Code" column switches to individual bale import by
 * reference; otherwise rows are read as Article Code + Qty.
 */
export async function parseBaleImportWorkbook(buffer: ArrayBuffer): Promise<BaleImportParseResult> {
  const wb = await XLSX.read(new Uint8Array(buffer), { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws);

  const firstRow = rows[0] || {};
  const refKey = Object.keys(firstRow).find((k) => /^ref(erence)?([\s_-]?(number|code|no|num))?$/i.test(k.trim()));

  if (refKey) {
    return { mode: "refNumber", refNumbers: rows.map((r) => String(r[refKey] ?? "").trim()).filter(Boolean) };
  }

  return {
    mode: "articleCode",
    rows: rows
      .map((r) => ({
        articleCode: String(
          r["Article Code"] ?? r.articleCode ?? r.article_code ?? r.ArticleCode ?? r.ARTICLECODE ?? ""
        ).trim(),
        qty: parseInt(String(r.Qty ?? r.qty ?? r.QTY ?? r.Quantity ?? r.quantity ?? 0), 10) || 0,
      }))
      .filter((r) => r.articleCode && r.qty > 0),
  };
}

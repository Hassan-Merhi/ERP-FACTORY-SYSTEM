import { getErrorDetails } from "@shared/errorUtils";
/**
 * Pure helpers and lookup tables for the FactoryBaleRelabeling page.
 *
 * Extracted from FactoryBaleRelabeling.tsx during the Phase 4 god-file split.
 */
import * as XLSX from "@/lib/excelHelper";
import type { ApplyItem, ParsedRow } from "./types";
import { downloadBlob } from "@/lib/downloadBlob";

export const POSSIBLE_COLUMNS = [
  "current_reference_code",
  "reference_code",
  "ref",
  "barcode",
  "old_ref",
  "reference",
  "current_ref",
  "bale_code",
  "baleCode",
  "refcode",
];

export function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[\s_-]/g, "");
}

export function findRefColumn(headers: string[]): string | null {
  const normalized = headers.map((h) => normalizeHeader(h));
  const candidates = POSSIBLE_COLUMNS.map((c) => normalizeHeader(c));
  for (const candidate of candidates) {
    const idx = normalized.indexOf(candidate);
    if (idx !== -1) return headers[idx];
  }
  return null;
}

export function parseExcelFile(file: File): Promise<ParsedRow[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = e.target?.result;
        const wb = await XLSX.read(data, { type: "binary" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
        if (rows.length === 0) {
          reject(new Error("No rows found in file"));
          return;
        }
        const headers = Object.keys(rows[0]);
        const refCol = findRefColumn(headers);
        if (!refCol) {
          reject(
            new Error(
              `Could not find a reference code column. Expected one of: ${POSSIBLE_COLUMNS.slice(0, 6).join(", ")}`
            )
          );
          return;
        }
        const parsed: ParsedRow[] = rows
          .map((r, i: number) => ({ currentRef: String(r[refCol] || "").trim(), rowNum: i + 2 }))
          .filter((r) => r.currentRef);
        resolve(parsed);
      } catch (err) {
        reject(new Error(getErrorDetails(err).message || "Failed to parse file"));
      }
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsBinaryString(file);
  });
}

export function downloadCsv(items: ApplyItem[], filename: string) {
  const header = "old_reference_code,new_reference_code,product_name,article_code,weight_kg,status";
  const rows = items.map((r) =>
    [r.oldRef, r.newRef, `"${r.productName}"`, r.articleCode, r.weightKg, "SUCCESS"].join(",")
  );
  downloadBlob(new Blob(["\uFEFF" + [header, ...rows].join("\n")], { type: "text/csv;charset=utf-8" }), filename);
}

export async function downloadExcelTemplate() {
  const wb = XLSX.utils.book_new();
  const data = [["current_reference_code"], ["REF00001"], ["REF00002"], ["REF00003"]];
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws["!cols"] = [{ wch: 30 }];
  XLSX.utils.book_append_sheet(wb, ws, "Bale References");
  await XLSX.writeFile(wb, "bale-relabeling-template.xlsx");
}

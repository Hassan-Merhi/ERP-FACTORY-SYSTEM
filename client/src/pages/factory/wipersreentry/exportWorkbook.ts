import * as XLSX from "@/lib/excelHelper";
import type { CreatedBale } from "./types";

/** Downloads the bales created in this re-entry session as an Excel sheet. */
export async function exportCreatedBalesWorkbook(createdBales: CreatedBale[], entryDate: string): Promise<void> {
  const rows = createdBales.map((b) => ({
    Reference: b.referenceNumber,
    Product: b.productName || "",
    "Article Code": b.articleCode || "",
    "Weight (kg)": b.weightKg,
    "Entry Date": b.stockEntryDate || entryDate,
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "WipersReEntry");
  await XLSX.writeFile(wb, `wipers-re-entry-${entryDate}.xlsx`);
}

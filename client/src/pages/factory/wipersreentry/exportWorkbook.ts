import { exportOperationalWorkbook } from "@/lib/operationalExcelExport";
import type { CreatedBale } from "./types";

/** Export actual created bales, not a stock-import template. */
export async function exportCreatedBalesWorkbook(createdBales: CreatedBale[], entryDate: string): Promise<void> {
  const rows = createdBales.map((b) => ({
    Reference: b.referenceNumber,
    Product: b.productName || "",
    "Article Code": b.articleCode || "",
    "Weight (kg)": b.weightKg,
    "Entry Date": b.stockEntryDate || entryDate,
  }));
  await exportOperationalWorkbook({
    title: "Factory Wipers Re-entry",
    fileName: "wipers-re-entry-" + entryDate + ".xlsx",
    filters: [{ label: "Entry date", value: entryDate }],
    sheets: [{
      name: "WipersReEntry",
      columns: [
        { key: "Reference", header: "Reference", width: 22 },
        { key: "Product", header: "Product", width: 34 },
        { key: "Article Code", header: "Article Code", width: 20 },
        { key: "Weight (kg)", header: "Weight (kg)", type: "decimal", width: 17, numFmt: "#,##0.000" },
        { key: "Entry Date", header: "Entry Date", width: 17 },
      ],
      rows,
    }],
  });
}

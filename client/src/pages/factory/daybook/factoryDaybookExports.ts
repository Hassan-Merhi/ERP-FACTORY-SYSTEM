/**
 * Excel export builders for the Factory Daybook.
 *
 * Extracted verbatim from FactoryDaybook.tsx: both helpers keep the exact
 * column order, widths, sheet names and file names the page shipped with, so
 * downstream spreadsheets keep parsing. Toast messaging stays with the caller -
 * these functions only build and write the workbook.
 */
import { format } from "date-fns";
import { exportOperationalWorkbook } from "@/lib/operationalExcelExport";
import { formatDaybookDescription, formatTxType } from "./daybookUtils";
import type { DaybookEntry } from "./types";

type FormatDisplayDate = (value: string) => string;

export interface DaybookExportResult {
  fileName: string;
  rowCount: number;
}

/** Summary export: one row per daybook entry, single "Factory Daybook" sheet. */
export async function exportFactoryDaybookSummary(
  entries: DaybookEntry[],
  formatDisplayDate: FormatDisplayDate
): Promise<DaybookExportResult> {
  const exportData = entries.map((e) => ({
    Date: formatDisplayDate(e.txDate + "T00:00:00"),
    Type: formatTxType(e.txType),
    Description: formatDaybookDescription(e),
    Currency: e.currencyCode,
    Amount: parseFloat(e.amountCurrency || "0"),
    "FX Rate": parseFloat(e.fxRateToUsd || "1"),
    "Amount (USD)": parseFloat(e.amountUsd || "0"),
    Optional: e.optional ? "Yes" : "No",
  }));
  const fileName = `FactoryDaybook_${format(new Date(), "yyyy-MM-dd")}.xlsx`;
  await exportOperationalWorkbook({
    title: "Factory Daybook",
    fileName,
    sheets: [{
      name: "Factory Daybook",
      columns: [
        { key: "Date", header: "Date", width: 12 },
        { key: "Type", header: "Type", width: 22 },
        { key: "Description", header: "Description", width: 40 },
        { key: "Currency", header: "Currency", width: 10 },
        { key: "Amount", header: "Amount", type: "money", width: 15 },
        { key: "FX Rate", header: "FX Rate", type: "decimal", width: 12, numFmt: "0.000000" },
        { key: "Amount (USD)", header: "Amount (USD)", type: "money", width: 17 },
        { key: "Optional", header: "Optional", width: 10 },
      ],
      rows: exportData,
    }],
  });
  return { fileName, rowCount: entries.length };
}

type DetailRow = {
  Date: string;
  Type: string;
  Description: string;
  Currency: string;
  Amount: number;
  "Amount (USD)": number;
  Optional: string;
  "Account Name": string;
  Debit: number | "";
  Credit: number | "";
};

/**
 * Detailed export: voucher-backed entries are expanded into their debit/credit
 * lines (one sheet per transaction type). A failed voucher fetch degrades to
 * the plain summary row for that entry rather than aborting the export.
 */
export async function exportFactoryDaybookDetailed(
  entries: DaybookEntry[],
  formatDisplayDate: FormatDisplayDate
): Promise<DaybookExportResult> {
  const detailedData: DetailRow[] = [];

  for (const entry of entries) {
    const isVoucherBacked = entry.referenceTable === "vouchers" && !!entry.referenceId;
    const baseRow = {
      Date: formatDisplayDate(entry.txDate + "T00:00:00"),
      Type: formatTxType(entry.txType),
      Description: formatDaybookDescription(entry),
      Currency: entry.currencyCode,
      Amount: parseFloat(entry.amountCurrency || "0"),
      "Amount (USD)": parseFloat(entry.amountUsd || "0"),
      Optional: entry.optional ? "Yes" : "No",
    };
    if (isVoucherBacked) {
      try {
        const res = await fetch(`/api/vouchers/${entry.referenceId}/view-entries`, { credentials: "include" });
        if (res.ok) {
          const raw = await res.json();
          const vEntries = Array.isArray(raw) ? raw : raw.entries || [];
          if (vEntries.length > 0) {
            for (const ve of vEntries) {
              detailedData.push({
                ...baseRow,
                "Account Name": ve.accountName || "",
                Debit: parseFloat(ve.debitAmount || "0") > 0 ? parseFloat(ve.debitAmount) : "",
                Credit: parseFloat(ve.creditAmount || "0") > 0 ? parseFloat(ve.creditAmount) : "",
              });
            }
            continue;
          }
        }
      } catch {
        // Failure here is non-fatal and the surrounding flow continues deliberately.
      }
    }
    detailedData.push({ ...baseRow, "Account Name": "", Debit: "", Credit: "" });
  }

  const dataByType: Record<string, DetailRow[]> = {};
  for (const row of detailedData) {
    if (!dataByType[row.Type]) dataByType[row.Type] = [];
    dataByType[row.Type].push(row);
  }
  const detailColumns = [
    { key: "Date", header: "Date", width: 12 },
    { key: "Type", header: "Type", width: 22 },
    { key: "Description", header: "Description", width: 40 },
    { key: "Currency", header: "Currency", width: 10 },
    { key: "Amount", header: "Amount", type: "money" as const, width: 15 },
    { key: "Amount (USD)", header: "Amount (USD)", type: "money" as const, width: 15 },
    { key: "Optional", header: "Optional", width: 10 },
    { key: "Account Name", header: "Account Name", width: 30 },
    { key: "Debit", header: "Debit", type: "money" as const, width: 15 },
    { key: "Credit", header: "Credit", type: "money" as const, width: 15 },
  ];
  const sheets = Object.keys(dataByType).sort().map((type) => ({
    name: type.substring(0, 31).replace(/[^a-z0-9 _-]/gi, "_"),
    columns: detailColumns,
    rows: dataByType[type],
  }));
  const fileName = `FactoryDaybook_Detailed_${format(new Date(), "yyyy-MM-dd")}.xlsx`;
  await exportOperationalWorkbook({
    title: "Factory Daybook — Detailed",
    fileName,
    sheets: sheets.length ? sheets : [{ name: "Factory Daybook Detail", columns: detailColumns, rows: [] }],
  });
  return { fileName, rowCount: detailedData.length };
}

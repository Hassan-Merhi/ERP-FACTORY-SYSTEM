/**
 * Excel export builders for the Factory Daybook.
 *
 * Extracted verbatim from FactoryDaybook.tsx: both helpers keep the exact
 * column order, widths and sheet names the page shipped with, so
 * downstream spreadsheets keep parsing. Toast messaging stays with the caller -
 * these functions only build and write the workbook.
 */
import { utils, writeFile } from "@/lib/excelHelper";
import { formatDaybookDescription, formatTxType } from "./daybookUtils";
import type { DaybookEntry } from "./types";
import { exportFileName } from "@/lib/exportFile";

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
  const worksheet = utils.json_to_sheet(exportData);
  worksheet["!cols"] = [
    { wch: 12 },
    { wch: 22 },
    { wch: 40 },
    { wch: 10 },
    { wch: 15 },
    { wch: 10 },
    { wch: 15 },
    { wch: 10 },
  ];
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, worksheet, "Factory Daybook");
  const fileName = exportFileName("factory daybook", "xlsx");
  await writeFile(workbook, fileName);
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
  Debit: string;
  Credit: string;
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
                Debit: parseFloat(ve.debitAmount || "0") > 0 ? String(parseFloat(ve.debitAmount)) : "",
                Credit: parseFloat(ve.creditAmount || "0") > 0 ? String(parseFloat(ve.creditAmount)) : "",
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

  const workbook = utils.book_new();
  const dataByType: Record<string, DetailRow[]> = {};
  for (const row of detailedData) {
    if (!dataByType[row.Type]) dataByType[row.Type] = [];
    dataByType[row.Type].push(row);
  }
  for (const type of Object.keys(dataByType).sort()) {
    const ws = utils.json_to_sheet(dataByType[type]);
    ws["!cols"] = [
      { wch: 12 },
      { wch: 22 },
      { wch: 40 },
      { wch: 10 },
      { wch: 15 },
      { wch: 15 },
      { wch: 10 },
      { wch: 30 },
      { wch: 15 },
      { wch: 15 },
    ];
    const sheetName = type.substring(0, 31).replace(/[\\/*?[\]:]/g, "_");
    utils.book_append_sheet(workbook, ws, sheetName);
  }

  const fileName = exportFileName("factory daybook detailed", "xlsx");
  await writeFile(workbook, fileName);
  return { fileName, rowCount: detailedData.length };
}

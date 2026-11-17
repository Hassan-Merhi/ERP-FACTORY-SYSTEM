import * as XLSX from "@/lib/excelHelper";
import { exportFileName } from "@/lib/exportFile";

import type { GroupRow } from "./types";
import { createStockEntryHistoryReports as createLegacyStockEntryHistoryReports } from "./reportsLegacy";
import { buildWorkerMatrix } from "./utils";

interface StockEntryHistoryReportsInput {
  filteredGroups: GroupRow[];
  fetchGroupsWithBales: () => Promise<GroupRow[]>;
  fromDate: string;
  toDate: string;
}

export function createStockEntryHistoryReports(input: StockEntryHistoryReportsInput) {
  const { fetchGroupsWithBales, fromDate, toDate } = input;
  const legacy = createLegacyStockEntryHistoryReports(input);

  async function exportExcel() {
    const wb = XLSX.utils.book_new();

    // Condensed mode is paged, so every export sheet must use the complete filtered
    // result instead of the currently rendered page.
    const groupsWithBales = await fetchGroupsWithBales();

    const summaryRows = groupsWithBales.map((group) => ({
      "Stock Entry Date": group.stockEntryDate,
      Location: group.locationName,
      Worker: group.workerName || "Unassigned",
      Product: group.productName || "—",
      "Article Code": group.articleCode || "—",
      "Bale Count": group.baleCount,
      "Total Weight (kg)": parseFloat(group.totalWeight || "0"),
      "Avg Weight (kg)": parseFloat(group.avgWeight || "0"),
      "First Bale Time": group.firstFinalizedAt ? new Date(group.firstFinalizedAt).toLocaleString() : "—",
      "Last Bale Time": group.lastFinalizedAt ? new Date(group.lastFinalizedAt).toLocaleString() : "—",
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), "Summary");

    const detailRows = groupsWithBales.flatMap((group) =>
      group.bales.map((bale) => ({
        "Stock Entry Date": bale.stockEntryDate,
        Location: bale.locationName,
        Worker: bale.workerName || "Unassigned",
        Product: bale.productName || "—",
        "Article Code": bale.articleCode || "—",
        "Reference Number": bale.referenceNumber,
        "Weight (kg)": parseFloat(bale.weightKg || "0"),
        Status: bale.status,
        "Finalized At": bale.finalizedAt ? new Date(bale.finalizedAt).toLocaleString() : "—",
      }))
    );
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detailRows), "Bale Details");

    const matrix = buildWorkerMatrix(groupsWithBales);
    const matrixSheet = XLSX.utils.aoa_to_sheet([]);
    XLSX.utils.sheet_add_aoa(matrixSheet, [["Stock Entry History — Worker Matrix"]], { origin: "A1" });
    XLSX.utils.sheet_add_aoa(matrixSheet, [[`Period: ${fromDate}  →  ${toDate}`]], { origin: "A2" });
    XLSX.utils.sheet_add_aoa(matrixSheet, [["Bale / Product", ...matrix.workers, "Total"]], {
      origin: "A4",
    });

    const matrixRows = matrix.rows.map((row) => [
      row.productLabel,
      ...matrix.workers.map((worker) => row.counts[worker] || 0),
      row.total,
    ]);
    if (matrixRows.length > 0) {
      XLSX.utils.sheet_add_aoa(matrixSheet, matrixRows, { origin: "A5" });
    }

    const totalsRow = ["TOTAL", ...matrix.workers.map((worker) => matrix.workerTotals[worker] || 0), matrix.grandTotal];
    XLSX.utils.sheet_add_aoa(matrixSheet, [totalsRow], {
      origin: { r: 4 + matrix.rows.length, c: 0 },
    });
    matrixSheet["!cols"] = [{ wch: 36 }, ...matrix.workers.map(() => ({ wch: 14 })), { wch: 10 }];
    matrixSheet["!freeze"] = { xSplit: 0, ySplit: 4 };
    XLSX.utils.book_append_sheet(wb, matrixSheet, "Worker Matrix");

    await XLSX.writeFile(wb, exportFileName("stock entry history", "xlsx", { from: fromDate, to: toDate }));
  }

  return {
    ...legacy,
    exportExcel,
  };
}

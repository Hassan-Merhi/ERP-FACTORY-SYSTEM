// Extracted from ./POS.tsx: the single-transaction Excel export.
import { downloadBlob } from "@/lib/downloadBlob";
import { exportFileName } from "@/lib/exportFile";
import { getErrorDetails } from "@shared/errorUtils";
import type { usePOSState } from "./POSUsePOSState";

export async function exportPosTransaction({
  rows,
  toast,
  editVoucher,
  editVoucherId,
}: {
  rows: ReturnType<typeof usePOSState>["rows"];
  toast: ReturnType<typeof usePOSState>["toast"];
  editVoucher: ReturnType<typeof usePOSState>["editVoucher"];
  editVoucherId: ReturnType<typeof usePOSState>["editVoucherId"];
}) {
  const validRows = rows.filter((r) => r.stockItemId && r.quantity > 0);
  if (validRows.length === 0) {
    toast({ title: "Nothing to export", description: "No items in this transaction.", variant: "destructive" });
    return;
  }
  try {
    const { default: ExcelJS } = await import("exceljs");
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Transaction");

    // ── Header row ──────────────────────────────────────────────────────────
    const headerRow = ws.addRow(["#", "Item", "Code", "Qty", "Rate", "Amt", "P/L", "T.P/L"]);
    headerRow.font = { bold: true };
    headerRow.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
      cell.border = {
        bottom: { style: "thin", color: { argb: "FF94A3B8" } },
      };
      cell.alignment = { horizontal: "center" };
    });

    // ── Column widths ────────────────────────────────────────────────────────
    ws.getColumn(1).width = 5; // #
    ws.getColumn(2).width = 30; // Item
    ws.getColumn(3).width = 14; // Code
    ws.getColumn(4).width = 8; // Qty
    ws.getColumn(5).width = 10; // Rate
    ws.getColumn(6).width = 12; // Amt
    ws.getColumn(7).width = 10; // P/L
    ws.getColumn(8).width = 12; // T.P/L

    // ── Data rows ────────────────────────────────────────────────────────────
    validRows.forEach((row, i) => {
      const rateUSD = row.rateUSD ?? row.rate;
      const cfgUSD = row.configuredPrice ?? 0;
      const plBale = rateUSD - cfgUSD;
      const totalPL = plBale * row.quantity;
      const dataRow = ws.addRow([
        i + 1,
        row.itemName,
        row.stockItemCode,
        row.quantity,
        row.rate,
        row.amount,
        plBale,
        totalPL,
      ]);
      // Colour negative P/L rows red
      if (plBale < 0) {
        dataRow.getCell(7).font = { color: { argb: "FFDC2626" } };
        dataRow.getCell(8).font = { color: { argb: "FFDC2626" } };
      }
    });

    // ── Totals row ───────────────────────────────────────────────────────────
    const totalQty = validRows.reduce((s, r) => s + r.quantity, 0);
    const totalAmt = validRows.reduce((s, r) => s + r.amount, 0);
    const totalTPL = validRows.reduce((s, r) => {
      const rateUSD = r.rateUSD ?? r.rate;
      return s + (rateUSD - (r.configuredPrice ?? 0)) * r.quantity;
    }, 0);

    const totRow = ws.addRow(["", "TOTAL", "", totalQty, "", totalAmt, "", totalTPL]);
    totRow.font = { bold: true };
    totRow.eachCell((cell) => {
      cell.border = { top: { style: "thin", color: { argb: "FF94A3B8" } } };
    });

    // ── Download ─────────────────────────────────────────────────────────────
    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const dateStr = editVoucher?.voucherDate?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
    const num = editVoucher?.voucherNumber ?? editVoucherId ?? "txn";
    downloadBlob(blob, exportFileName(`transaction ${num}`, "xlsx", { date: dateStr }));
  } catch (err) {
    toast({ title: "Export failed", description: getErrorDetails(err).optionalMessage, variant: "destructive" });
  }
}

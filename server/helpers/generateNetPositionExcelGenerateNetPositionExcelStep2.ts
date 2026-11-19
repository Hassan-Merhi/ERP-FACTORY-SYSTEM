// Extracted from ./generateNetPositionExcel.ts
import { round2 } from "../netPositionHelper";
import { C, currencyFmt, generateNetPositionExcelStep1, setThin } from "./generateMonthEnds";

export function generateNetPositionExcelStep2({
  snapshots,
  wsInc,
}: Pick<Awaited<ReturnType<typeof generateNetPositionExcelStep1>>, "snapshots" | "wsInc">) {
  // Per-month breakdown detail
  for (const s of snapshots) {
    const inc = s.income;
    const netInc = round2(inc.totalRevenue - inc.totalExpenses);

    // Month heading
    const mHdr = wsInc.addRow([`${s.label}   (${s.periodFrom} → ${s.dateStr})`, "", "", ""]);
    mHdr.height = 22;
    mHdr.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.DARK_BLUE } };
      cell.font = { bold: true, color: { argb: C.WHITE }, size: 11 };
    });
    wsInc.mergeCells(`A${mHdr.number}:D${mHdr.number}`);

    // Revenue lines
    if (inc.revenueLines.length > 0) {
      const rHdr = wsInc.addRow(["  Revenue", "", "", ""]);
      rHdr.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF16A34A" } };
        cell.font = { bold: true, color: { argb: C.WHITE }, size: 10 };
      });
      for (const l of inc.revenueLines) {
        const lr = wsInc.addRow([`    ${l.label}`, "", l.value, ""]);
        lr.getCell(3).numFmt = currencyFmt;
        lr.getCell(3).font = { color: { argb: C.GREEN } };
        lr.eachCell((cell) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.GREEN_BG } };
          setThin(cell);
        });
      }
      const rTot = wsInc.addRow(["  Total Revenue", "", inc.totalRevenue, ""]);
      rTot.getCell(1).font = { bold: true };
      rTot.getCell(3).numFmt = currencyFmt;
      rTot.getCell(3).font = { bold: true, color: { argb: C.GREEN } };
      rTot.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFB3F5D3" } };
      });
    }

    // Expense lines
    const allExpLines = [...inc.directExpLines, ...inc.indirectExpLines, ...inc.generalExpLines];
    if (allExpLines.length > 0) {
      const eHdr = wsInc.addRow(["  Expenses", "", "", ""]);
      eHdr.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.RED } };
        cell.font = { bold: true, color: { argb: C.WHITE }, size: 10 };
      });
      for (const l of allExpLines) {
        const lr = wsInc.addRow([`    ${l.label}`, "", l.value, ""]);
        lr.getCell(3).numFmt = currencyFmt;
        lr.getCell(3).font = { color: { argb: C.RED } };
        lr.eachCell((cell) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.RED_BG } };
          setThin(cell);
        });
      }
      const eTot = wsInc.addRow(["  Total Expenses", "", inc.totalExpenses, ""]);
      eTot.getCell(1).font = { bold: true };
      eTot.getCell(3).numFmt = currencyFmt;
      eTot.getCell(3).font = { bold: true, color: { argb: C.RED } };
      eTot.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDCFCF" } };
      });
    }

    // Net income line
    const niRow = wsInc.addRow(["  Net Income", "", Math.abs(netInc), netInc >= 0 ? "Profit" : "Loss"]);
    niRow.height = 22;
    niRow.getCell(1).font = { bold: true, size: 11 };
    niRow.getCell(3).numFmt = currencyFmt;
    niRow.getCell(3).font = { bold: true, size: 11, color: { argb: netInc >= 0 ? C.GREEN : C.RED } };
    niRow.getCell(4).font = { bold: true, color: { argb: netInc >= 0 ? C.GREEN : C.RED } };
    niRow.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.YELLOW_BG } };
      cell.border = {
        top: { style: "thin", color: { argb: "FFAAAAAA" } },
        bottom: { style: "thin", color: { argb: "FFAAAAAA" } },
      };
    });

    wsInc.addRow([]);
  }

  [30, 10, 20, 12].forEach((w, i) => {
    wsInc.getColumn(i + 1).width = w;
  });
  return {};
}

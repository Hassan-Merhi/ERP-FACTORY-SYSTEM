import { styleUniversalFinancialWorkbook } from "@shared/universal-excel/financialWorkbookStyle";
/**
 * Shared helper: builds the net-position monthly Excel workbook buffer.
 * Used by both the HTTP route (streams to browser) and the WhatsApp scheduler.
 */

import { NetPositionLineItem } from "./calculateNetPositionAsOf";
import { round2 } from "../netPositionHelper";
import {
  C,
  currencyFmt,
  fmtSheetName,
  generateNetPositionExcelStep1,
  lineKey,
  setThin,
  signedFmt,
  styleHeader,
  styleTitle,
} from "./generateMonthEnds";
import { generateNetPositionExcelStep2 } from "./generateNetPositionExcelGenerateNetPositionExcelStep2";
export { fmtMonthLabel, generateMonthEnds } from "./generateMonthEnds";

function valueMap(lines: NetPositionLineItem[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) m.set(lineKey(l), l.value);
  return m;
}

// ─── main export ──────────────────────────────────────────────────────────────

export async function generateNetPositionExcel(
  companyId: number,
  companyName: string,
  startDate: string,
  endDate: string,
  dest?: NodeJS.WritableStream
): Promise<Buffer> {
  const { snapshots, wb, wsInc } = await generateNetPositionExcelStep1(companyId, companyName, startDate, endDate);
  generateNetPositionExcelStep2({ snapshots, wsInc });
  const { buf } = await generateNetPositionExcelStep3({ snapshots, wb }, companyName, dest);
  return buf;
}

async function generateNetPositionExcelStep3(
  { snapshots, wb }: Pick<Awaited<ReturnType<typeof generateNetPositionExcelStep1>>, "snapshots" | "wb">,
  companyName: string,
  dest?: NodeJS.WritableStream
) {
  // ═══════════════════════════════════════════════════════════════════
  //  SHEETS 3…N: one per month — simplified detail only
  // ═══════════════════════════════════════════════════════════════════
  for (let idx = 0; idx < snapshots.length; idx++) {
    const snap = snapshots[idx];
    const prevSnap = idx > 0 ? snapshots[idx - 1] : null;
    const prevMap = prevSnap ? valueMap([...prevSnap.forUsLines, ...prevSnap.onUsLines]) : new Map<string, number>();

    const ws = wb.addWorksheet(fmtSheetName(snap.dateStr));

    ws.mergeCells("A1:D1");
    styleTitle(ws.getCell("A1"), `${snap.label} — Net Position Details`, 14);
    ws.getRow(1).height = 34;

    ws.mergeCells("A2:D2");
    const meta = ws.getCell("A2");
    meta.value = `${companyName}   |   Snapshot: ${snap.dateStr}   |   Net Position: ${snap.netPosition >= 0 ? "+" : ""}${snap.netPosition.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
    meta.font = { italic: true, size: 10, color: { argb: C.MUTED } };
    meta.alignment = { horizontal: "center" };
    ws.getRow(2).height = 18;

    ws.addRow([]);

    // KPI row
    const kHdr = ws.addRow(["Money Owed TO US", "Money WE OWE", "Net Position", "Status"]);
    kHdr.height = 22;
    kHdr.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: C.WHITE }, size: 10 };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.MID_BLUE } };
      cell.alignment = { horizontal: "center", vertical: "middle" };
    });

    const isPos = snap.netPosition >= 0;
    const kVal = ws.addRow([snap.forUsTotal, snap.onUsTotal, Math.abs(snap.netPosition), snap.netPositionLabel]);
    kVal.height = 28;
    kVal.getCell(1).numFmt = currencyFmt;
    kVal.getCell(1).font = { bold: true, size: 13, color: { argb: C.GREEN } };
    kVal.getCell(2).numFmt = currencyFmt;
    kVal.getCell(2).font = { bold: true, size: 13, color: { argb: C.RED } };
    kVal.getCell(3).numFmt = currencyFmt;
    kVal.getCell(3).font = { bold: true, size: 13, color: { argb: isPos ? C.GREEN : C.RED } };
    kVal.getCell(4).font = { bold: true, size: 12, color: { argb: isPos ? C.GREEN : C.RED } };
    kVal.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.LIGHT_BLUE } };
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.border = { bottom: { style: "medium", color: { argb: C.DARK_BLUE } } };
    });

    ws.addRow([]);

    // Column header for detail table — no Category column
    const prevLabel = prevSnap ? prevSnap.label : "Prior Month";
    const detHdr = ws.addRow(["Line Item", snap.label, prevLabel, "Change"]);
    detHdr.height = 22;
    detHdr.eachCell((cell) => styleHeader(cell));

    // WHAT WE HAVE
    const forUsSec = ws.addRow(["  MONEY OWED TO US", "", "", ""]);
    forUsSec.height = 22;
    forUsSec.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF16A34A" } };
      cell.font = { bold: true, color: { argb: C.WHITE } };
    });

    let forUsSubtotal = 0;
    for (const line of snap.forUsLines) {
      const key = lineKey(line);
      const prevVal = prevMap.get(key) ?? 0;
      const change = prevSnap ? round2(line.value - prevVal) : null;
      forUsSubtotal += line.value;

      const dr = ws.addRow([line.label, line.value, prevSnap ? prevVal : null, change]);
      dr.getCell(1).font = { size: 10 };
      dr.getCell(2).numFmt = currencyFmt;
      dr.getCell(2).font = { color: { argb: C.GREEN } };
      if (prevSnap) {
        dr.getCell(3).numFmt = currencyFmt;
        dr.getCell(3).font = { color: { argb: C.MUTED } };
      } else {
        dr.getCell(3).value = "—";
        dr.getCell(3).font = { color: { argb: C.MUTED } };
      }
      if (change !== null) {
        dr.getCell(4).numFmt = signedFmt;
        dr.getCell(4).font = { italic: true, color: { argb: change >= 0 ? C.GREEN : C.RED } };
      } else {
        dr.getCell(4).value = "—";
        dr.getCell(4).font = { color: { argb: C.MUTED } };
      }
      dr.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.GREEN_BG } };
        setThin(cell);
      });
    }

    const forUsTotRow = ws.addRow([
      "Total — Money Owed TO US",
      forUsSubtotal,
      prevSnap ? prevSnap.forUsTotal : null,
      prevSnap ? round2(forUsSubtotal - prevSnap.forUsTotal) : null,
    ]);
    forUsTotRow.height = 20;
    forUsTotRow.getCell(1).font = { bold: true };
    forUsTotRow.getCell(2).numFmt = currencyFmt;
    forUsTotRow.getCell(2).font = { bold: true, color: { argb: C.GREEN } };
    if (prevSnap) {
      forUsTotRow.getCell(3).numFmt = currencyFmt;
      forUsTotRow.getCell(3).font = { bold: true, color: { argb: C.MUTED } };
      forUsTotRow.getCell(4).numFmt = signedFmt;
      forUsTotRow.getCell(4).font = {
        bold: true,
        color: { argb: forUsSubtotal - prevSnap.forUsTotal >= 0 ? C.GREEN : C.RED },
      };
    }
    forUsTotRow.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFB3F5D3" } };
      cell.border = {
        top: { style: "thin", color: { argb: "FF16A34A" } },
        bottom: { style: "thin", color: { argb: "FF16A34A" } },
      };
    });

    ws.addRow([]);

    // WHAT WE OWE
    const onUsSec = ws.addRow(["  MONEY WE OWE", "", "", ""]);
    onUsSec.height = 22;
    onUsSec.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDC2626" } };
      cell.font = { bold: true, color: { argb: C.WHITE } };
    });

    let onUsSubtotal = 0;
    for (const line of snap.onUsLines) {
      const key = lineKey(line);
      const prevVal = prevMap.get(key) ?? 0;
      const change = prevSnap ? round2(line.value - prevVal) : null;
      onUsSubtotal += line.value;

      const dr = ws.addRow([line.label, line.value, prevSnap ? prevVal : null, change]);
      dr.getCell(1).font = { size: 10 };
      dr.getCell(2).numFmt = currencyFmt;
      dr.getCell(2).font = { color: { argb: C.RED } };
      if (prevSnap) {
        dr.getCell(3).numFmt = currencyFmt;
        dr.getCell(3).font = { color: { argb: C.MUTED } };
      } else {
        dr.getCell(3).value = "—";
        dr.getCell(3).font = { color: { argb: C.MUTED } };
      }
      if (change !== null) {
        dr.getCell(4).numFmt = signedFmt;
        dr.getCell(4).font = { italic: true, color: { argb: change <= 0 ? C.GREEN : C.RED } };
      } else {
        dr.getCell(4).value = "—";
        dr.getCell(4).font = { color: { argb: C.MUTED } };
      }
      dr.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.RED_BG } };
        setThin(cell);
      });
    }

    const onUsTotRow = ws.addRow([
      "Total — Money WE OWE",
      onUsSubtotal,
      prevSnap ? prevSnap.onUsTotal : null,
      prevSnap ? round2(onUsSubtotal - prevSnap.onUsTotal) : null,
    ]);
    onUsTotRow.height = 20;
    onUsTotRow.getCell(1).font = { bold: true };
    onUsTotRow.getCell(2).numFmt = currencyFmt;
    onUsTotRow.getCell(2).font = { bold: true, color: { argb: C.RED } };
    if (prevSnap) {
      onUsTotRow.getCell(3).numFmt = currencyFmt;
      onUsTotRow.getCell(3).font = { bold: true, color: { argb: C.MUTED } };
      const oweDiff = onUsSubtotal - prevSnap.onUsTotal;
      onUsTotRow.getCell(4).numFmt = signedFmt;
      onUsTotRow.getCell(4).font = { bold: true, color: { argb: oweDiff <= 0 ? C.GREEN : C.RED } };
    }
    onUsTotRow.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDCFCF" } };
      cell.border = {
        top: { style: "thin", color: { argb: C.RED } },
        bottom: { style: "thin", color: { argb: C.RED } },
      };
    });

    // NOT YET IN THE LEDGER — listed for information, never in the totals (wave 10)
    const memoLines = snap.notInLedger?.lines ?? [];
    if (memoLines.length > 0) {
      ws.addRow([]);
      const memoSec = ws.addRow(["  NOT YET IN THE LEDGER (not included in the net position)", "", "", ""]);
      memoSec.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: C.MUTED } };
      });
      for (const line of memoLines) {
        const mr = ws.addRow([line.label, line.value, "", ""]);
        mr.getCell(1).font = { italic: true, size: 10 };
        mr.getCell(2).numFmt = signedFmt;
      }
    }

    ws.getColumn(1).width = 40;
    ws.getColumn(2).width = 20;
    ws.getColumn(3).width = 20;
    ws.getColumn(4).width = 18;
  }

  styleUniversalFinancialWorkbook(
    wb,
    wb.worksheets.map((ws) => ({ name: ws.name }))
  );
  const rawBuf = await wb.xlsx.writeBuffer();
  const buf = Buffer.isBuffer(rawBuf) ? rawBuf : Buffer.from(rawBuf);
  if (dest) {
    dest.write(buf);
  }
  return { buf };
}

import { styleFactoryOperationalWorkbook } from "@shared/universal-excel/factoryOperationalStyle";
/**
 * Shared state and helpers for the factoryBaleExportRoutes routes.
 *
 * Extracted verbatim from the former single-file factoryBaleExportRoutes.ts.
 */
import { buildWeeklyReportExcelBufferPart1, _wrMondayOfWeek, type WrCatKey } from "./buildWeeklyReportExcelBufferPart1";
export { _wrIsoWeekKey, _wrMondayOfWeek, _wrDateOnly, type WrCatKey } from "./buildWeeklyReportExcelBufferPart1";

// ── Weekly report: shared Excel builder (used by download + WhatsApp send) ───

export const _WR_DAY_NAMES = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
export function _wrDayName(dateStr: string): string {
  return _WR_DAY_NAMES[(new Date(dateStr + "T00:00:00").getUTCDay() + 6) % 7];
}
export function _wrFmtDate(dateStr: string): string {
  const [, mm, dd] = dateStr.split("-");
  return `${dd}/${mm}`;
}

export async function buildWeeklyReportExcelBuffer(companyId: number, period: string = "all"): Promise<Buffer> {
  const { periodStart, catBalMap, consByDate, weekMap, sortedWks, allCKs, weekCons, weekSI, totSI, totC } =
    await buildWeeklyReportExcelBufferPart1(companyId, period);
  const openBals = new Map<string, Map<WrCatKey, number>>();
  const firstOpen = new Map<WrCatKey, number>(
    allCKs.map((ck) => [ck, (catBalMap.get(ck)?.currentBalance || 0) - (totSI.get(ck) || 0) + (totC.get(ck) || 0)])
  );
  if (sortedWks.length > 0) openBals.set(sortedWks[0], firstOpen);
  for (let i = 0; i < sortedWks.length; i++) {
    const wk = sortedWks[i];
    const op = openBals.get(wk)!;
    const cl = new Map<WrCatKey, number>();
    for (const ck of allCKs)
      cl.set(ck, (op.get(ck) || 0) + (weekSI.get(wk)!.get(ck) || 0) - (weekCons.get(wk)!.get(ck) || 0));
    if (i < sortedWks.length - 1) openBals.set(sortedWks[i + 1], cl);
  }
  const displayWks = periodStart
    ? sortedWks.filter((wk) => {
        const dates = weekMap.get(wk)!;
        return dates[dates.length - 1] >= periodStart! || _wrMondayOfWeek(dates[0]) >= periodStart!;
      })
    : sortedWks;

  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const sh = wb.addWorksheet("Weekly Report");
  const BLUE = "FF1E40AF",
    LB = "FFE0EAFF",
    DG = "FF374151",
    TBG = "FFD1FAE5";
  const BS: import("exceljs").Border = { style: "thin", color: { argb: "FFD1D5DB" } };
  const BA = { top: BS, left: BS, bottom: BS, right: BS };
  sh.getColumn(1).width = 24;
  sh.getColumn(2).width = 14;
  sh.getColumn(3).width = 12;
  let row = 1;
  if (displayWks.length === 0) {
    const r = sh.getRow(row);
    const c = r.getCell(1);
    c.value = "No production data found";
    c.font = { italic: true, size: 11 };
    sh.mergeCells(row, 1, row, 12);
    row++;
  }
  for (const wk of displayWks) {
    const dates = weekMap.get(wk)!;
    const monDate = _wrMondayOfWeek(dates[0]);
    const monD = new Date(monDate + "T00:00:00");
    const days: string[] = [];
    for (let di = 0; di < 7; di++) {
      const d = new Date(monD);
      d.setUTCDate(monD.getUTCDate() + di);
      days.push(d.toISOString().slice(0, 10));
    }
    const tCols = 3 + days.length + 2;
    const tRow = sh.getRow(row);
    tRow.getCell(1).value = `Week of ${_wrFmtDate(monDate)} – ${_wrFmtDate(days[6])}  |  ${wk}`;
    tRow.getCell(1).font = { bold: true, size: 11, color: { argb: "FFFFFFFF" } };
    tRow.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLUE } };
    tRow.getCell(1).alignment = { horizontal: "center", vertical: "middle" };
    sh.mergeCells(row, 1, row, tCols);
    tRow.height = 22;
    row++;
    const hdrs = [
      "CATEGORY",
      "Balance",
      "Stock In",
      ...days.map((d) => `${_wrDayName(d)}\n${_wrFmtDate(d)}`),
      "TOTAL",
      "REMAINS",
    ];
    const hRow = sh.getRow(row);
    hdrs.forEach((h, ci) => {
      const c = hRow.getCell(ci + 1);
      c.value = h;
      c.font = { bold: true, size: 9, color: { argb: "FFFFFFFF" } };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: DG } };
      c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      c.border = BA;
    });
    for (let di = 0; di < days.length; di++) sh.getColumn(4 + di).width = 10;
    sh.getColumn(4 + days.length).width = 11;
    sh.getColumn(5 + days.length).width = 12;
    hRow.height = 28;
    styleFactoryOperationalWorkbook(wb, [{ name: "Weekly Report", headerRow: row }]);
    row++;
    const op = openBals.get(wk)!;
    const sm = weekSI.get(wk)!;
    const activeCKs = allCKs
      .filter((ck) => (weekCons.get(wk)!.get(ck) || 0) > 0.001 || (sm.get(ck) || 0) > 0.001)
      .sort((a, b) => (catBalMap.get(a)?.name || "").localeCompare(catBalMap.get(b)?.name || ""));
    let wtB = 0,
      wtSI = 0,
      wtT = 0,
      wtR = 0;
    const wtD = days.map(() => 0);
    for (const ck of activeCKs) {
      const info = catBalMap.get(ck)!;
      const ob = op.get(ck) || 0;
      const si = sm.get(ck) || 0;
      const dv = days.map((d) => consByDate.get(d)?.get(ck) || 0);
      const tot = weekCons.get(wk)!.get(ck) || 0;
      const rem = ob + si - tot;
      wtB += ob;
      wtSI += si;
      wtT += tot;
      wtR += rem;
      dv.forEach((v, i) => {
        wtD[i] += v;
      });
      const dr = sh.getRow(row);
      const vals: (string | number | null)[] = [
        info.name,
        Math.round(ob) || 0,
        si > 0.5 ? Math.round(si) : null,
        ...dv.map((v) => (v > 0.5 ? Math.round(v) : null)),
        Math.round(tot) > 0 ? Math.round(tot) : null,
        Math.round(rem),
      ];
      vals.forEach((v, ci) => {
        const c = dr.getCell(ci + 1);
        c.value = v;
        c.font = { size: 9 };
        c.border = BA;
        if (ci === 0) {
          c.font = { size: 9, bold: true };
          c.alignment = { vertical: "middle" };
        } else {
          c.alignment = { horizontal: "right", vertical: "middle" };
          c.numFmt = "#,##0";
        }
        if (ci >= 3 && ci < 3 + days.length && typeof v === "number")
          c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: LB } };
      });
      dr.height = 16;
      row++;
    }
    const totRow = sh.getRow(row);
    const totVals: (string | number | null)[] = [
      "TOTAL",
      Math.round(wtB),
      wtSI > 0.5 ? Math.round(wtSI) : null,
      ...wtD.map((v) => (Math.round(v) > 0 ? Math.round(v) : null)),
      Math.round(wtT) > 0 ? Math.round(wtT) : null,
      Math.round(wtR),
    ];
    totVals.forEach((v, ci) => {
      const c = totRow.getCell(ci + 1);
      c.value = v;
      c.font = { bold: true, size: 9 };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TBG } };
      c.border = BA;
      if (ci === 0) c.alignment = { vertical: "middle" };
      else {
        c.alignment = { horizontal: "right", vertical: "middle" };
        c.numFmt = "#,##0";
      }
    });
    totRow.height = 18;
    row++;
    row++;
  }
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

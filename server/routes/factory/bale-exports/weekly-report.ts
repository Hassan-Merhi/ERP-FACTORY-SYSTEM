/**
 * factoryBaleExportRoutes: FactoryWeeklyReportExport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { requireAuth } from "../../../auth";
import path from "path";
import fs from "fs";
import { weeklyReportStep } from "./weeklyReportStep";
import { weeklyReportStep2 } from "./weeklyReportStep2";

export function registerFactoryWeeklyReportExportRoutes(app: Express) {
  // ───────────────────────────────────────────────
  // Weekly pivot production report (by category × day)
  // ───────────────────────────────────────────────
  app.get("/api/factory/weekly-report/export", requireAuth, async (req: Request, res: Response) => {
    try {
      const wkr1 = await weeklyReportStep({ req, res });
      if (wkr1.done) return wkr1.value;
      const { format, mondayOfWeek, fmtDate, dayName, catBalMap, consumptionByDate } = wkr1;
      const wkr2 = await weeklyReportStep2({ wkr1, res });
      if (wkr2.done) return wkr2.value;
      const { displayWeekKeys, periodLabel, weekMap, openingBalances, weekStockIn, allCatKeys, weekConsumption } = wkr2;

      // 8. Excel generation
      if (format === "excel") {
        const ExcelJS = (await import("exceljs")).default;
        const wb = new ExcelJS.Workbook();
        const sh = wb.addWorksheet("Weekly Report");

        const BLUE = "FF1E40AF";
        const LIGHT_BLUE = "FFE0EAFF";
        const DARK_GRAY = "FF374151";
        const TOTAL_BG = "FFD1FAE5";
        const BORDER_STYLE: import("exceljs").Border = { style: "thin", color: { argb: "FFD1D5DB" } };
        const BORDER_ALL = { top: BORDER_STYLE, left: BORDER_STYLE, bottom: BORDER_STYLE, right: BORDER_STYLE };

        sh.getColumn(1).width = 24;
        sh.getColumn(2).width = 14;
        sh.getColumn(3).width = 12;

        let row = 1;

        if (displayWeekKeys.length === 0) {
          const msgRow = sh.getRow(row);
          const msgCell = msgRow.getCell(1);
          msgCell.value = `No production data found for period: ${periodLabel}`;
          msgCell.font = { italic: true, size: 11 };
          sh.mergeCells(row, 1, row, 12);
          row++;
        }

        for (const wk of displayWeekKeys) {
          const dates = weekMap.get(wk)!;
          const monDate = mondayOfWeek(dates[0]);
          const monD = new Date(monDate + "T00:00:00");
          const weekDaysMoSa: string[] = [];
          for (let di = 0; di < 7; di++) {
            const d = new Date(monD);
            d.setUTCDate(monD.getUTCDate() + di);
            weekDaysMoSa.push(d.toISOString().slice(0, 10));
          }

          const totalCols = 3 + weekDaysMoSa.length + 2; // CATEGORY + Balance + StockIn + days + TOTAL + REMAINS

          // ── Title row ──
          const titleRow = sh.getRow(row);
          const titleText = `Week of ${fmtDate(monDate)} – ${fmtDate(weekDaysMoSa[6])}  |  ${wk}`;
          const titleCell = titleRow.getCell(1);
          titleCell.value = titleText;
          titleCell.font = { bold: true, size: 11, color: { argb: "FFFFFFFF" } };
          titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLUE } };
          titleCell.alignment = { horizontal: "center", vertical: "middle" };
          sh.mergeCells(row, 1, row, totalCols);
          titleRow.height = 22;
          row++;

          // ── Column header row ──
          const colHeaders = [
            "CATEGORY",
            "Balance",
            "Stock In",
            ...weekDaysMoSa.map((d) => `${dayName(d)}\n${fmtDate(d)}`),
            "TOTAL",
            "REMAINS",
          ];
          const headerRow = sh.getRow(row);
          colHeaders.forEach((h, ci) => {
            const cell = headerRow.getCell(ci + 1);
            cell.value = h;
            cell.font = { bold: true, size: 9, color: { argb: "FFFFFFFF" } };
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: DARK_GRAY } };
            cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
            cell.border = BORDER_ALL;
          });
          // Set day column widths
          for (let di = 0; di < weekDaysMoSa.length; di++) {
            sh.getColumn(4 + di).width = 10;
          }
          sh.getColumn(4 + weekDaysMoSa.length).width = 11;
          sh.getColumn(5 + weekDaysMoSa.length).width = 12;
          headerRow.height = 28;
          row++;

          const opening = openingBalances.get(wk)!;
          const sMap = weekStockIn.get(wk)!;

          // Active categories this week: only include categories with actual activity
          // (stock-in or consumption). Categories with only a carry-over balance are hidden.
          const activeCats = allCatKeys
            .filter((ck) => {
              return (weekConsumption.get(wk)!.get(ck) || 0) > 0.001 || (sMap.get(ck) || 0) > 0.001;
            })
            .sort((a, b) => (catBalMap.get(a)?.name || "").localeCompare(catBalMap.get(b)?.name || ""));

          let weekTotalBalance = 0,
            weekTotalStockIn = 0,
            weekTotalTotal = 0,
            weekTotalRemains = 0;
          const weekTotalByDay = weekDaysMoSa.map(() => 0);

          for (const ck of activeCats) {
            const info = catBalMap.get(ck)!;
            const openBal = opening.get(ck) || 0;
            const stockIn = sMap.get(ck) || 0;
            const dayVals = weekDaysMoSa.map((d) => consumptionByDate.get(d)?.get(ck) || 0);
            // Use authoritative weekConsumption (includes all 7 days) for TOTAL and REMAINS
            const total = weekConsumption.get(wk)!.get(ck) || 0;
            const remains = openBal + stockIn - total;

            weekTotalBalance += openBal;
            weekTotalStockIn += stockIn;
            weekTotalTotal += total;
            weekTotalRemains += remains;
            dayVals.forEach((v, i) => {
              weekTotalByDay[i] += v;
            });

            const dataRow = sh.getRow(row);
            const vals: (string | number | null)[] = [
              info.name,
              Math.round(openBal) || 0,
              stockIn > 0.5 ? Math.round(stockIn) : null,
              ...dayVals.map((v) => (v > 0.5 ? Math.round(v) : null)),
              Math.round(total) > 0 ? Math.round(total) : null,
              Math.round(remains),
            ];
            vals.forEach((v, ci) => {
              const cell = dataRow.getCell(ci + 1);
              cell.value = v;
              cell.font = { size: 9 };
              cell.border = BORDER_ALL;
              if (ci === 0) {
                cell.font = { size: 9, bold: true };
                cell.alignment = { vertical: "middle" };
              } else {
                cell.alignment = { horizontal: "right", vertical: "middle" };
                cell.numFmt = "#,##0";
              }
              if (ci >= 3 && ci < 3 + weekDaysMoSa.length && typeof v === "number") {
                cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT_BLUE } };
              }
            });
            dataRow.height = 16;
            row++;
          }

          // ── Totals row ──
          const totRow = sh.getRow(row);
          const totVals: (string | number | null)[] = [
            "TOTAL",
            Math.round(weekTotalBalance),
            weekTotalStockIn > 0.5 ? Math.round(weekTotalStockIn) : null,
            ...weekTotalByDay.map((v) => (Math.round(v) > 0 ? Math.round(v) : null)),
            Math.round(weekTotalTotal) > 0 ? Math.round(weekTotalTotal) : null,
            Math.round(weekTotalRemains),
          ];
          totVals.forEach((v, ci) => {
            const cell = totRow.getCell(ci + 1);
            cell.value = v;
            cell.font = { bold: true, size: 9 };
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TOTAL_BG } };
            cell.border = BORDER_ALL;
            if (ci === 0) {
              cell.alignment = { vertical: "middle" };
            } else {
              cell.alignment = { horizontal: "right", vertical: "middle" };
              cell.numFmt = "#,##0";
            }
          });
          totRow.height = 18;
          row++;

          row++; // blank gap between weeks
        }

        const xlsBuffer3 = Buffer.from(await wb.xlsx.writeBuffer());
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="weekly-production-report.xlsx"`);
        res.setHeader("Content-Length", xlsBuffer3.byteLength);
        return res.end(xlsBuffer3);
      }

      // PDF format
      if (format === "pdf") {
        const PDFDocument = (await import("pdfkit")).default;
        const doc = new PDFDocument({ margin: 30, size: "A4", layout: "landscape" });
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="weekly-production-report.pdf"`);
        doc.pipe(res);

        const pageW = doc.page.width - 60;
        const rowH = 14;
        const wpLogoPath = path.join(process.cwd(), "server", "hmd-logo.png");

        // Show "no data" page when the selected period has no weeks
        if (displayWeekKeys.length === 0) {
          const hasLogo = fs.existsSync(wpLogoPath);
          if (hasLogo) {
            try {
              doc.image(wpLogoPath, (doc.page.width - 220) / 2, 10, { width: 220 });
            } catch {
              // Failure here is non-fatal and the surrounding flow continues deliberately.
            }
            if (doc.y < 130) doc.y = 130;
            doc.moveDown(0.5);
          }
          doc
            .fontSize(13)
            .font("Helvetica-Bold")
            .text(`No production data found for period: ${periodLabel}`, 30, doc.y, { width: pageW, align: "center" });
          doc.end();
          return;
        }

        for (let wi = 0; wi < displayWeekKeys.length; wi++) {
          const wk = displayWeekKeys[wi];
          if (wi > 0) doc.addPage({ layout: "landscape" });

          // On the first page, place logo at top then continue below it.
          // On subsequent pages start from the top margin.
          let startY = 30; // default top margin
          if (wi === 0 && fs.existsSync(wpLogoPath)) {
            try {
              doc.image(wpLogoPath, (doc.page.width - 220) / 2, 10, { width: 220 });
              // Ensure we start below the logo — use whichever is lower: doc.y or a minimum clearance
              startY = Math.max(doc.y + 8, 130);
            } catch {
              startY = 30;
            }
          }

          const dates = weekMap.get(wk)!;
          const monDate = mondayOfWeek(dates[0]);
          const monD = new Date(monDate + "T00:00:00");
          const weekDaysMoSa: string[] = [];
          for (let di = 0; di < 7; di++) {
            const d = new Date(monD);
            d.setUTCDate(monD.getUTCDate() + di);
            weekDaysMoSa.push(d.toISOString().slice(0, 10));
          }

          const nDays = 7;
          const fixedW = 120 + 65 + 55 + 58 + 65;
          const dayW = Math.max(36, Math.floor((pageW - fixedW) / nDays));
          const colWidths = [120, 65, 55, ...Array(nDays).fill(dayW), 58, 65];
          const colX: number[] = [30];
          for (let i = 1; i < colWidths.length; i++) colX.push(colX[i - 1] + colWidths[i - 1]);

          const titleText = `Week ${wk}  |  ${fmtDate(monDate)} – ${fmtDate(weekDaysMoSa[6])}`;
          doc.fontSize(11).font("Helvetica-Bold").text(titleText, 30, startY, { width: pageW, align: "center" });
          doc.moveDown(0.3);

          const headers = [
            "CATEGORY",
            "Balance",
            "Stock In",
            ...weekDaysMoSa.map((d) => `${dayName(d)}\n${fmtDate(d)}`),
            "TOTAL",
            "REMAINS",
          ];
          const hy = doc.y;
          doc.fontSize(7).font("Helvetica-Bold");
          headers.forEach((h, i) => {
            const lines = h.split("\n");
            lines.forEach((line, li) => {
              doc.text(line, colX[i], hy + li * 8, {
                width: colWidths[i] - 2,
                align: i === 0 ? "left" : "right",
                lineBreak: false,
              });
            });
          });
          const hh = rowH + (headers.some((h) => h.includes("\n")) ? 8 : 0);
          const lineY = hy + hh;
          doc
            .moveTo(30, lineY)
            .lineTo(30 + colWidths.reduce((a, b) => a + b, 0), lineY)
            .stroke();

          const opening = openingBalances.get(wk)!;
          const sMap = weekStockIn.get(wk)!;
          const activeCats = allCatKeys
            .filter((ck) => (weekConsumption.get(wk)!.get(ck) || 0) > 0 || (sMap.get(ck) || 0) > 0)
            .sort((a, b) => (catBalMap.get(a)?.name || "").localeCompare(catBalMap.get(b)?.name || ""));

          let weekTotalBalance = 0,
            weekTotalStockIn = 0,
            weekTotalTotal = 0,
            weekTotalRemains = 0;
          const weekTotalByDay = Array(nDays).fill(0);
          let rowY = lineY + 3;
          doc.font("Helvetica").fontSize(7);

          for (const ck of activeCats) {
            const info = catBalMap.get(ck)!;
            const openBal = opening.get(ck) || 0;
            const stockIn = sMap.get(ck) || 0;
            const dayVals = weekDaysMoSa.map((d) => consumptionByDate.get(d)?.get(ck) || 0);
            // Use authoritative weekConsumption (includes all 7 days) for TOTAL and REMAINS
            const total = weekConsumption.get(wk)!.get(ck) || 0;
            const remains = openBal + stockIn - total;
            weekTotalBalance += openBal;
            weekTotalStockIn += stockIn;
            weekTotalTotal += total;
            weekTotalRemains += remains;
            dayVals.forEach((v, i) => {
              weekTotalByDay[i] += v;
            });

            const rowVals = [
              info.name,
              Math.round(openBal).toLocaleString(),
              stockIn > 0.5 ? Math.round(stockIn).toLocaleString() : "-",
              ...dayVals.map((v) => (v > 0.5 ? Math.round(v).toLocaleString() : "-")),
              total > 0.5 ? Math.round(total).toLocaleString() : "-",
              Math.round(remains).toLocaleString(),
            ];
            rowVals.forEach((v, i) => {
              doc.text(String(v), colX[i], rowY, {
                width: colWidths[i] - 2,
                align: i === 0 ? "left" : "right",
                lineBreak: false,
              });
            });
            rowY += rowH;
          }

          doc
            .moveTo(30, rowY)
            .lineTo(30 + colWidths.reduce((a, b) => a + b, 0), rowY)
            .strokeColor("#000000")
            .stroke();
          rowY += 3;
          doc.font("Helvetica-Bold").fontSize(7);
          const totVals = [
            "TOTAL",
            Math.round(weekTotalBalance).toLocaleString(),
            weekTotalStockIn > 0.5 ? Math.round(weekTotalStockIn).toLocaleString() : "-",
            ...weekTotalByDay.map((v) => (v > 0.5 ? Math.round(v).toLocaleString() : "-")),
            weekTotalTotal > 0.5 ? Math.round(weekTotalTotal).toLocaleString() : "-",
            Math.round(weekTotalRemains).toLocaleString(),
          ];
          totVals.forEach((v, i) => {
            doc.text(String(v), colX[i], rowY, {
              width: colWidths[i] - 2,
              align: i === 0 ? "left" : "right",
              lineBreak: false,
            });
          });
        }

        doc.end();
        return;
      }

      return res.status(400).json({ message: "Invalid format." });
    } catch (error: unknown) {
      logger.error("Error generating weekly report:", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

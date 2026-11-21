// Extracted from ./preview.ts
import { styleUniversalFinancialWorkbook } from "@shared/universal-excel/financialWorkbookStyle";
import { toArrayBuffer } from "../../../lib/bufferCompatibility";
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { eq } from "drizzle-orm";
import path from "path";
import fs from "fs";
import ExcelJS from "exceljs";
import { companies } from "@shared/schema";
import { getFactoryCompanyId } from "./_helpers";

export function registerPayrollPreviewRoutesPart1(app: Express) {
  // POST /api/factory/payrolls/preview-excel — styled ExcelJS export of the payroll preview
  app.post("/api/factory/payrolls/preview-excel", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId: number = req.body.companyId || getFactoryCompanyId(req);
      const { periodStart, periodEnd, rows } = req.body as {
        periodStart: string;
        periodEnd: string;
        rows: Array<{
          employeeCode: string | null;
          name: string;
          position: string | null;
          presentDays: number;
          totalWorkingDays: number;
          absentDays: number;
          base: number;
          bonus: number;
          transportMonthly: number;
          transportPaid: number;
          salaryDeduction: number;
          advanceDeduction: number;
          net: number;
        }>;
      };
      if (!companyId || !periodStart || !periodEnd || !Array.isArray(rows)) {
        return res.status(400).json({ message: "companyId, periodStart, periodEnd and rows required" });
      }

      const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
      const companyName = company?.name || "Company";

      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Payroll");

      // ── Logo ─────────────────────────────────────────────────────────────
      const logoPath = path.join(process.cwd(), "server", "hmd-logo.png");
      let logoId: number | null = null;
      try {
        if (fs.existsSync(logoPath)) {
          const buf = fs.readFileSync(logoPath);
          logoId = wb.addImage({ buffer: toArrayBuffer(buf), extension: "jpeg" });
        }
      } catch {
        // Failure here is non-fatal and the surrounding flow continues deliberately.
      }

      const NUM_COLS = 13;

      // Row 1 — logo placeholder
      const logoRow = ws.addRow([]);
      logoRow.height = 72;
      if (logoId !== null) ws.addImage(logoId, { tl: { col: 0, row: 0 }, ext: { width: 260, height: 72 } });

      // Row 2 — company name
      const rCo = ws.addRow([companyName]);
      rCo.getCell(1).font = { bold: true, size: 15, color: { argb: "FF1F3864" } };
      rCo.getCell(1).alignment = { horizontal: "center" };
      ws.mergeCells(rCo.number, 1, rCo.number, NUM_COLS);

      // Row 3 — report title
      const rTitle = ws.addRow(["Payroll Preview"]);
      rTitle.getCell(1).font = { bold: true, size: 12, color: { argb: "FF1F3864" } };
      rTitle.getCell(1).alignment = { horizontal: "center" };
      ws.mergeCells(rTitle.number, 1, rTitle.number, NUM_COLS);

      // Row 4 — period
      const rPeriod = ws.addRow([`Period: ${periodStart}  →  ${periodEnd}`]);
      rPeriod.getCell(1).font = { size: 10, color: { argb: "FF555555" }, italic: true };
      rPeriod.getCell(1).alignment = { horizontal: "center" };
      ws.mergeCells(rPeriod.number, 1, rPeriod.number, NUM_COLS);

      ws.addRow([]); // spacer

      // ── Column definitions ────────────────────────────────────────────────
      ws.columns = [
        { key: "code", width: 14 },
        { key: "name", width: 28 },
        { key: "position", width: 20 },
        { key: "present", width: 14 },
        { key: "total", width: 13 },
        { key: "absent", width: 13 },
        { key: "base", width: 13 },
        { key: "bonus", width: 12 },
        { key: "transMo", width: 16 },
        { key: "transPaid", width: 16 },
        { key: "salDed", width: 18 },
        { key: "advDed", width: 18 },
        { key: "net", width: 14 },
      ];

      // ── Header row ────────────────────────────────────────────────────────
      const HDR_BG = "FF1F3864";
      const HDR_FG = "FFFFFFFF";
      const hdr = ws.addRow([
        "Code",
        "Name",
        "Position",
        "Present Days",
        "Total Days",
        "Absent Days",
        "Base ($)",
        "Bonus ($)",
        "Transport/mo ($)",
        "Transport Paid ($)",
        "Salary Deduction ($)",
        "Advance Deduction ($)",
        "Net Pay ($)",
      ]);
      hdr.height = 22;
      hdr.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HDR_BG } };
        cell.font = { bold: true, color: { argb: HDR_FG }, size: 10 };
        cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
        cell.border = {
          top: { style: "thin", color: { argb: "FFB8CCE4" } },
          bottom: { style: "thin", color: { argb: "FFB8CCE4" } },
          left: { style: "thin", color: { argb: "FFB8CCE4" } },
          right: { style: "thin", color: { argb: "FFB8CCE4" } },
        };
      });

      // ── Data rows ─────────────────────────────────────────────────────────
      const MONEY_FMT = "#,##0.00";
      const DAYS_FMT = "#,##0.0";
      const EVEN_BG = "FFFFFFFF";
      const ODD_BG = "FFF0F4FA"; // very light blue

      let totalBase = 0,
        totalBonus = 0,
        totalTransMo = 0,
        totalTransPaid = 0;
      let totalSalDed = 0,
        totalAdvDed = 0,
        totalNet = 0;

      rows.forEach((r, idx) => {
        const bg = idx % 2 === 0 ? EVEN_BG : ODD_BG;
        const dataRow = ws.addRow({
          code: r.employeeCode || "—",
          name: r.name,
          position: r.position || "—",
          present: r.presentDays,
          total: r.totalWorkingDays,
          absent: r.absentDays,
          base: r.base,
          bonus: r.bonus,
          transMo: r.transportMonthly,
          transPaid: r.transportPaid,
          salDed: r.salaryDeduction,
          advDed: r.advanceDeduction,
          net: r.net,
        });
        dataRow.height = 18;
        dataRow.eachCell((cell) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bg } };
          cell.alignment = { vertical: "middle" };
          cell.border = {
            top: { style: "hair", color: { argb: "FFDDDDDD" } },
            bottom: { style: "hair", color: { argb: "FFDDDDDD" } },
            left: { style: "hair", color: { argb: "FFDDDDDD" } },
            right: { style: "hair", color: { argb: "FFDDDDDD" } },
          };
        });

        // Align text cols left, numbers right
        dataRow.getCell("code").alignment = { horizontal: "left", vertical: "middle" };
        dataRow.getCell("name").alignment = { horizontal: "left", vertical: "middle" };
        dataRow.getCell("position").alignment = { horizontal: "left", vertical: "middle" };

        // Money / days formats
        (["present", "total", "absent"] as const).forEach((k) => {
          dataRow.getCell(k).numFmt = DAYS_FMT;
          dataRow.getCell(k).alignment = { horizontal: "center", vertical: "middle" };
        });
        (["base", "bonus", "transMo", "transPaid", "salDed", "advDed", "net"] as const).forEach((k) => {
          dataRow.getCell(k).numFmt = MONEY_FMT;
          dataRow.getCell(k).alignment = { horizontal: "right", vertical: "middle" };
        });

        // Accumulate totals
        totalBase += r.base;
        totalBonus += r.bonus;
        totalTransMo += r.transportMonthly;
        totalTransPaid += r.transportPaid;
        totalSalDed += r.salaryDeduction;
        totalAdvDed += r.advanceDeduction;
        totalNet += r.net;
      });

      // ── Totals row ────────────────────────────────────────────────────────
      ws.addRow([]); // thin gap
      const totRow = ws.addRow({
        code: "",
        name: "TOTAL",
        position: "",
        present: "",
        total: "",
        absent: "",
        base: totalBase,
        bonus: totalBonus,
        transMo: totalTransMo,
        transPaid: totalTransPaid,
        salDed: totalSalDed,
        advDed: totalAdvDed,
        net: totalNet,
      });
      totRow.height = 22;
      totRow.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3864" } };
        cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
        cell.alignment = { horizontal: "right", vertical: "middle" };
        cell.border = {
          top: { style: "medium", color: { argb: "FF4472C4" } },
          bottom: { style: "medium", color: { argb: "FF4472C4" } },
          left: { style: "thin", color: { argb: "FF4472C4" } },
          right: { style: "thin", color: { argb: "FF4472C4" } },
        };
      });
      totRow.getCell("name").alignment = { horizontal: "left", vertical: "middle" };
      (["base", "bonus", "transMo", "transPaid", "salDed", "advDed", "net"] as const).forEach((k) => {
        totRow.getCell(k).numFmt = MONEY_FMT;
      });

      // ── Worker count sub-label ────────────────────────────────────────────
      const rCount = ws.addRow([`${rows.length} worker${rows.length !== 1 ? "s" : ""}`]);
      rCount.getCell(1).font = { size: 9, italic: true, color: { argb: "FF888888" } };
      ws.mergeCells(rCount.number, 1, rCount.number, NUM_COLS);

      // ── Freeze pane below header ──────────────────────────────────────────
      ws.views = [{ state: "frozen", ySplit: hdr.number, activeCell: "A" + (hdr.number + 1) }];

      // ── Stream out ───────────────────────────────────────────────────────
      styleUniversalFinancialWorkbook(wb, [{ name: "Payroll", headerRow: hdr.number }]);
      const buf = Buffer.from(await wb.xlsx.writeBuffer());
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="Payroll_${periodStart}_${periodEnd}.xlsx"`);
      res.setHeader("Content-Length", buf.byteLength);
      res.end(buf);
    } catch (err) {
      logger.error("preview-excel error", { error: err });
      if (!res.headersSent) res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}

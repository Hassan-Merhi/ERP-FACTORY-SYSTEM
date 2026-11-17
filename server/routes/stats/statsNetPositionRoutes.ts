import { styleUniversalFinancialWorkbook } from "@shared/universal-excel/financialWorkbookStyle";
import type { Request, Response } from "express";
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { requireAuth, requireNonPOS } from "../../auth";
import { logAudit } from "../_helpers";
import { getClientDate } from "../../lib/dateUtils";
import { handleGetStatsNetPositionExcelStep1 } from "./handleGetStatsNetPositionExcelStep1";

export function registerStatsNetPositionRoutes(app: Express) {
  app.get("/api/stats/net-position-excel", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const step1Result = await handleGetStatsNetPositionExcelStep1(req, res);
      if (step1Result.done) return step1Result.value;
      const { DARK_RED, LIGHT_RED, NUM_FMT, companyId, liabTotalRow, wb } = step1Result;
      await handleGetStatsNetPositionExcelStep2(
        { DARK_RED, LIGHT_RED, NUM_FMT, companyId, liabTotalRow, wb },
        req,
        res
      );
    } catch (error: unknown) {
      logger.error("Net position Excel error:", { error: error });
      if (!res.headersSent) res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Get monthly sales and profit data for Dashboard charts
}

async function handleGetStatsNetPositionExcelStep2(
  {
    DARK_RED,
    LIGHT_RED,
    NUM_FMT,
    companyId,
    liabTotalRow,
    wb,
  }: Pick<
    Extract<Awaited<ReturnType<typeof handleGetStatsNetPositionExcelStep1>>, { done: false }>,
    "DARK_RED" | "LIGHT_RED" | "NUM_FMT" | "companyId" | "liabTotalRow" | "wb"
  >,
  req: Request,
  res: Response
) {
  liabTotalRow.eachCell((c) => {
    c.font = { bold: true, color: { argb: DARK_RED } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT_RED } };
  });
  liabTotalRow.getCell("value").numFmt = NUM_FMT;
  liabTotalRow.getCell("value").alignment = { horizontal: "right" };

  // ── Send file ─────────────────────────────────────────────────────────
  const dateTag = getClientDate(req);
  styleUniversalFinancialWorkbook(wb, wb.worksheets?.map((ws) => ({ name: ws.name })) ?? []);
  const xlsBuffer = Buffer.from(await wb.xlsx.writeBuffer());
  // Non-fatal: audit write must not block the Excel download
  try {
    await logAudit({
      userId: req.session.userId!,
      username: req.session.username || req.session.userId!,
      companyId: companyId!,
      action: "export",
      tableName: "reports",
      recordId: null,
      recordIdentifier: `Net Position Excel — ${dateTag}`,
      changes: { format: { old: null, new: "xlsx" } },
    });
  } catch (auditErr) {
    logger.error("[NetPositionExcel] audit write failed:", { error: auditErr });
  }
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="Net_Position_${dateTag}.xlsx"`);
  res.setHeader("Content-Length", xlsBuffer.byteLength);
  res.end(xlsBuffer);
  return {};
}

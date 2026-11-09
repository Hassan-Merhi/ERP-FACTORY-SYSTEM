/**
 * Phase 7: scoped read-only report payloads and genuine Excel exports.
 * Printable manifests are rendered by the frontend from the same JSON.
 * No writes to loading, inventory, stock, invoices or accounting.
 */
import type { Express, Request, Response } from "express";
import { requireAuth } from "../../../auth";
import { getFactoryAccessState, requireFactoryTabAccess } from "../../../lib/factoryAccessControl";
import { parseId } from "../../../lib/parseId";
import { buildSafeFilename } from "../../../lib/contentDisposition";
import { writeWorkbookToResponse } from "../../../excelHelper";
import { logger } from "../../../lib/logger";
import { loadFactoryDispatchReport, DispatchReportError } from "./loadingDispatchReportData";
import { buildFactoryLoadingDispatchWorkbook } from "./loadingDispatchReportWorkbook";

const access = requireFactoryTabAccess("factory/invoicing", "hide_invoicing_loadings_tab");

async function sendReport(req: Request, res: Response, scope: "overall" | "trip", excel: boolean) {
  try {
    const state = await getFactoryAccessState(req);
    if (!state) return res.status(403).json({ message: "Factory company access unavailable" });
    const orderId = parseId(req.params.id);
    if (orderId === null) return res.status(400).json({ message: "Invalid loading order ID" });
    const dispatchId = scope === "trip" ? parseId(req.params.dispatchId) : undefined;
    if (scope === "trip" && dispatchId == null) {
      return res.status(400).json({ message: "Invalid truck dispatch ID" });
    }
    const rawClosure = req.query.closureId;
    let closureId: number | undefined;
    if (rawClosure !== undefined) {
      if (scope !== "trip" || typeof rawClosure !== "string" ||
          !/^[1-9]\d*$/.test(rawClosure) || !Number.isSafeInteger(Number(rawClosure))) {
        return res.status(400).json({ message: "Invalid closureId. Historical reports require a selected dispatch" });
      }
      closureId = Number(rawClosure);
    }
    const report = await loadFactoryDispatchReport({
      companyId: state.companyId, orderId,
      ...(dispatchId == null ? {} : { dispatchId }),
      ...(closureId === undefined ? {} : { closureId }),
    });
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!excel) return res.json(report);

    const name = buildSafeFilename([
      "Factory_Dispatch",
      report.loading.containerNumber ?? "loading_" + orderId,
      report.trip ? "trip_" + report.trip.dispatchNumber : "all_trips",
      report.closure ? "closure_" + report.closure.revision : "live",
    ], "xlsx");
    const workbook = buildFactoryLoadingDispatchWorkbook(report);
    await writeWorkbookToResponse(workbook, res, name);
    return;
  } catch (error) {
    if (res.headersSent || res.writableEnded || res.destroyed) {
      logger.error("Dispatch report failed after response started", { error });
      return;
    }
    if (error instanceof DispatchReportError) {
      return res.status(error.httpStatus).json({ code: error.code, message: error.message });
    }
    logger.error("Factory dispatch reporting failed", { error });
    return res.status(500).json({ message: "Unable to generate dispatch report" });
  }
}

export function registerFactoryLoadingDispatchReportRoutes(app: Express) {
  const prefix = "/api/factory/customer-orders/:id/loading-dispatches";
  // Static overall routes must precede the dynamic :dispatchId paths.
  app.get(prefix + "/reports/overall", requireAuth, access, (req, res) => {
    void sendReport(req, res, "overall", false);
  });
  app.get(prefix + "/reports/overall.xlsx", requireAuth, access, (req, res) => {
    void sendReport(req, res, "overall", true);
  });
  app.get(prefix + "/:dispatchId/reports/manifest", requireAuth, access, (req, res) => {
    void sendReport(req, res, "trip", false);
  });
  app.get(prefix + "/:dispatchId/reports/manifest.xlsx", requireAuth, access, (req, res) => {
    void sendReport(req, res, "trip", true);
  });
}

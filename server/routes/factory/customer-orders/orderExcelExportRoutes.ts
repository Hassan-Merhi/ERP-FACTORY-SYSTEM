import type { Express, Request, Response } from "express";
import { requireAuth } from "../../../auth";
import { getExportPriceVisibility } from "../../../helpers/exportVisibility";
import { contentDisposition } from "../../../lib/contentDisposition";
import { getErrorMessage, getErrorStack } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { parseId } from "../../../lib/parseId";
import {
  buildCanonicalInvoiceExcel,
  getCanonicalInvoiceDocument,
} from "../../../services/factoryInvoiceDocumentService";
import { logAudit } from "../../helpers/auditHelpers";

async function exportInvoiceExcel(req: Request, res: Response) {
  try {
    const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
    if (!companyId) return res.status(400).json({ message: "No company selected" });

    const orderId = parseId(req.params.id);
    if (orderId === null) return res.status(400).json({ message: "Invalid order ID" });

    const document = await getCanonicalInvoiceDocument(orderId, companyId);
    if (!document) return res.status(404).json({ message: "Order not found" });

    const { hideSelling } = await getExportPriceVisibility(req);
    const { buffer, fileName } = await buildCanonicalInvoiceExcel(document, {
      hideSelling,
      noCharges: req.query.noCharges === "1",
      language: "en",
    });

    try {
      await logAudit({
        userId: req.session.userId!,
        username: req.session.username || req.session.userId!,
        companyId,
        action: "export",
        tableName: "factory_customer_orders",
        recordId: orderId,
        recordIdentifier: `Customer Order #${document.invoiceNumber || orderId} Excel`,
        changes: { format: { old: null, new: "xlsx" }, orderId: { old: null, new: orderId } },
      });
    } catch (auditError) {
      logger.error("[ExcelExport] audit write failed:", { error: auditError });
    }

    res.status(200);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", contentDisposition(fileName));
    res.setHeader("Content-Length", String(buffer.length));
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(buffer);
    logger.info(`[ExcelExport] orderId=${orderId} canonical=true bytes=${buffer.length}`);
  } catch (error: unknown) {
    logger.error("[ExcelExport] canonical invoice export failed:", {
      error: getErrorMessage(error),
      stack: getErrorStack(error),
    });
    if (!res.headersSent) res.status(500).json({ message: getErrorMessage(error) });
  }
}

export function registerOrderExcelExportRoutes(app: Express) {
  // Both legacy URLs intentionally share one implementation. This prevents
  // browser downloads, invoice detail downloads and shipping ZIP generation
  // from drifting into different invoice calculations.
  app.get("/api/factory/customer-orders/:id/export/excel", requireAuth, exportInvoiceExcel);
  app.get("/api/factory/customer-orders/:id/export-excel", requireAuth, exportInvoiceExcel);
}

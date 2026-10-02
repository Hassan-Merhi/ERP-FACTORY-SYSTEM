import type { Express, Request, Response } from "express";
import { requireAuth } from "../../../../auth";
import { getExportPriceVisibility } from "../../../../helpers/exportVisibility";
import { contentDisposition } from "../../../../lib/contentDisposition";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { parseId } from "../../../../lib/parseId";
import {
  buildCanonicalInvoicePdf,
  getCanonicalInvoiceDocument,
} from "../../../../services/factoryInvoiceDocumentService";
import { logAudit } from "../../../helpers/auditHelpers";

export function registerOrderPdfRoutes(app: Express) {
  app.get("/api/factory/customer-orders/:id/export-pdf", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const orderId = parseId(req.params.id);
      if (orderId === null) return res.status(400).json({ message: "Invalid order ID" });

      const document = await getCanonicalInvoiceDocument(orderId, companyId);
      if (!document) return res.status(404).json({ message: "Order not found" });

      const { hideSelling } = await getExportPriceVisibility(req);
      const { buffer, fileName } = await buildCanonicalInvoicePdf(document, {
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
          recordIdentifier: `Customer Order #${document.invoiceNumber || orderId} PDF`,
          changes: { format: { old: null, new: "pdf" }, orderId: { old: null, new: orderId } },
        });
      } catch (auditError) {
        logger.error("[PdfExport] audit write failed:", { error: auditError });
      }

      res.status(200);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", contentDisposition(fileName));
      res.setHeader("Content-Length", String(buffer.length));
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(buffer);
    } catch (error: unknown) {
      logger.error("Error exporting canonical order PDF:", { error });
      if (!res.headersSent) res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

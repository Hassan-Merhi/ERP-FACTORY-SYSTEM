/**
 * factoryInvoiceLoadingRoutes: InvoiceLoadingReport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { requireAuth } from "../../../auth";

import { buildLoadingSummary, getCompanyId } from "./_helpers";
import { renderInvoiceLoadingReportHtml } from "./reportHtml";
import { registerInvoiceLoadingReportRoutesPart1 } from "./registerInvoiceLoadingReportRoutesPart1";

export function registerInvoiceLoadingReportRoutes(app: Express) {
  registerInvoiceLoadingReportRoutesPart1(app);

  // GET /api/factory/invoices/:invoiceId/loading-report/export/pdf
  app.get(
    "/api/factory/invoices/:invoiceId/loading-report/export/pdf",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const invoiceId = parseId(req.params.invoiceId);

        if (invoiceId === null) return res.status(400).json({ message: "Invalid id" });
        if (isNaN(invoiceId)) return res.status(400).json({ message: "Invalid invoice ID" });

        const summary = await buildLoadingSummary(invoiceId, companyId);
        if (!summary) return res.status(404).json({ message: "Invoice not found" });

        const html = renderInvoiceLoadingReportHtml(summary);

        res.setHeader("Content-Type", "text/html");
        res.send(html);
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}

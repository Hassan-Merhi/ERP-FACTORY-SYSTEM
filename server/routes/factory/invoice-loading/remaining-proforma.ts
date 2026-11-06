/**
 * factoryInvoiceLoadingRoutes: InvoiceRemainingProforma endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { customerProformas, customerProformaLines } from "@shared/schema";
import { syncProformaReservations } from "../_stockReservationHelper";

import { buildLoadingSummary, getCompanyId } from "./_helpers";

export function registerInvoiceRemainingProformaRoutes(app: Express) {
  // POST /api/factory/invoices/:invoiceId/create-remaining-proforma
  // Creates a new proforma with all lines that still have remaining (unloaded) bales.
  app.post(
    "/api/factory/invoices/:invoiceId/create-remaining-proforma",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const invoiceId = parseId(req.params.invoiceId);
        if (invoiceId === null) return res.status(400).json({ message: "Invalid invoice ID" });

        const summary = await buildLoadingSummary(invoiceId, companyId);
        if (!summary) return res.status(404).json({ message: "Invoice not found" });

        const pendingLines = summary.lines.filter((l) => l.remaining > 0);
        if (pendingLines.length === 0) {
          return res.status(400).json({ message: "No remaining bales — all lines are fully loaded." });
        }

        const inv = summary.invoice;
        const invoiceLabel = inv.invoiceNumber || `Order #${inv.id}`;
        const today = new Date().toISOString().slice(0, 10);
        const proformaName = `Remaining - ${invoiceLabel} - ${today}`;

        const result = await db.transaction(async (tx) => {
          const [proforma] = await tx
            .insert(customerProformas)
            .values({
              companyId,
              customerId: inv.customerId,
              name: proformaName,
              destination: inv.destination,
              isActive: true,
            })
            .returning();

          // Build lines from the original invoice order lines
          const originalLines = summary.lines;
          const lineValues = pendingLines.map((pl) => {
            const orig = originalLines.find((l) => l.articleCode === pl.articleCode);
            return {
              proformaId: proforma.id,
              articleCode: pl.articleCode,
              productName: pl.productName,
              quantity: pl.remaining,
              pricePerBale: orig?.pricePerBale ?? "0",
              productionPricePerBale: "0",
              pricingMode: "per_bale" as const,
              pricePerKg: null as string | null,
            };
          });

          await tx.insert(customerProformaLines).values(lineValues);
          return proforma;
        });

        // Sync reservations outside transaction
        await syncProformaReservations(db, companyId, result.id).catch(() => {});

        res.json({ proformaId: result.id, proformaName });
      } catch (error: unknown) {
        logger.error("create-remaining-proforma error:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}

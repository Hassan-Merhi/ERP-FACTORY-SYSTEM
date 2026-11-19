import { parseId } from "../lib/parseId";
import { getErrorMessage } from "../lib/httpHandlers";
import { Express } from "express";
import type { Request, Response, RequestHandler } from "express";
import { db } from "../db";
import { eq, and, ne, sql } from "drizzle-orm";
import { supplierProformas } from "@shared/schema";
import { registerSupplierProformaRoutesPart1 } from "./registerSupplierProformaRoutesPart1";
import { registerSupplierProformaRoutesPart3 } from "./registerSupplierProformaRoutesPart3";

export function registerSupplierProformaRoutes(app: Express, requireAuth: RequestHandler) {
  registerSupplierProformaRoutesPart1(app, requireAuth);
  registerSupplierProformaRoutesPart2(app, requireAuth);
}

function registerSupplierProformaRoutesPart2(app: Express, requireAuth: RequestHandler) {
  registerSupplierProformaRoutesPart3(app, requireAuth);

  // ── Star / unstar a proforma ──────────────────────────────────────────────
  // PATCH /api/suppliers/:supplierId/proformas/:proformaId/star
  // Toggles the default proforma per supplier and destination company.
  app.patch(
    "/api/suppliers/:supplierId/proformas/:proformaId/star",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const supplierId = parseId(req.params.supplierId);
        const proformaId = parseId(req.params.proformaId);
        if (supplierId === null || proformaId === null) return res.status(400).json({ message: "Invalid id" });

        const [current] = await db
          .select({
            id: supplierProformas.id,
            isStarred: supplierProformas.isStarred,
            destinationCompanyId: supplierProformas.destinationCompanyId,
            supplierId: supplierProformas.supplierId,
          })
          .from(supplierProformas)
          .where(and(eq(supplierProformas.id, proformaId), eq(supplierProformas.companyId, companyId)));
        if (!current || current.supplierId !== supplierId)
          return res.status(404).json({ message: "Proforma not found" });
        const newStarred = !current.isStarred;

        if (newStarred) {
          // Only unstar defaults within the same destination. Legacy NULL means owner company.
          await db
            .update(supplierProformas)
            .set({ isStarred: false })
            .where(
              and(
                eq(supplierProformas.companyId, companyId),
                eq(supplierProformas.supplierId, supplierId),
                current.destinationCompanyId == null || current.destinationCompanyId === companyId
                  ? sql`(${supplierProformas.destinationCompanyId} IS NULL OR ${supplierProformas.destinationCompanyId} = ${companyId})`
                  : eq(supplierProformas.destinationCompanyId, current.destinationCompanyId),
                ne(supplierProformas.id, proformaId)
              )
            );
        }

        const [updated] = await db
          .update(supplierProformas)
          .set({ isStarred: newStarred })
          .where(eq(supplierProformas.id, proformaId))
          .returning();

        res.json(updated);
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}

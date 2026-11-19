// Extracted from ./balesReportRoutes.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { parseOptionalId } from "../../../lib/parseId";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { baleLabelPrints, factoryBales } from "@shared/schema";
import { and, eq, inArray, not, or } from "drizzle-orm";
import { registerBalesReportRoutesPart3 } from "./registerBalesReportRoutesPart3";

export function registerBalesReportRoutesPart2(app: Express) {
  registerBalesReportRoutesPart3(app);

  app.get("/api/factory/bales/lookup/:barcode", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const barcode = req.params.barcode.toUpperCase();
      const batchId = req.query.batchId ? parseOptionalId(req.query.batchId) : null;
      const excludeIdsStr = req.query.excludeIds as string;
      const excludeIds = excludeIdsStr
        ? excludeIdsStr
            .split(",")
            .map(Number)
            .filter((n) => !isNaN(n))
        : [];

      let results = [];

      const baseConditions = [
        eq(factoryBales.companyId, companyId),
        or(
          eq(factoryBales.referenceNumber, barcode),
          eq(factoryBales.baleCode, barcode),
          eq(factoryBales.articleCode, barcode)
        ),
      ];
      if (batchId) {
        baseConditions.push(eq(factoryBales.pressingBatchId, batchId));
        baseConditions.push(eq(factoryBales.status, "PENDING_PRESSING"));
      } else {
        // General scan lookup — never surface deleted or removed bales
        baseConditions.push(not(inArray(factoryBales.status, ["DELETED", "REMOVED"])));
      }
      results = await db
        .select()
        .from(factoryBales)
        .where(and(...baseConditions))
        .orderBy(factoryBales.id);

      if (results.length === 0) {
        const labelResults = await db
          .select()
          .from(baleLabelPrints)
          .where(and(eq(baleLabelPrints.companyId, companyId), eq(baleLabelPrints.referenceNumber, barcode)));

        if (labelResults.length > 0 && labelResults[0].productionBaleId) {
          const labelBale = await db
            .select()
            .from(factoryBales)
            .where(eq(factoryBales.id, labelResults[0].productionBaleId));
          if (labelBale.length > 0) {
            if (!batchId || labelBale[0].pressingBatchId === batchId) {
              results = labelBale;
            }
          }
        }
      }

      if (excludeIds.length > 0) {
        results = results.filter((b) => !excludeIds.includes(b.id));
      }

      if (results.length === 0) return res.status(404).json({ message: "Bale not found" });
      res.json(results[0]);
    } catch (error: unknown) {
      logger.error("Error looking up bale:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

/**
 * factoryProductsRoutes: FactoryProductWrite endpoints.
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
import { factoryBaleProducts } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { registerFactoryProductWriteRoutesPart1 } from "./registerFactoryProductWriteRoutesPart1";

export function registerFactoryProductWriteRoutes(app: Express) {
  registerFactoryProductWriteRoutesPart1(app);

  app.patch("/api/factory/bale-products/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const [updated] = await db
        .update(factoryBaleProducts)
        .set({ ...req.body, updatedAt: new Date() })
        .where(and(eq(factoryBaleProducts.id, id), eq(factoryBaleProducts.companyId, companyId)))
        .returning();

      if (!updated) return res.status(404).json({ message: "Product not found" });
      res.json(updated);
    } catch (error: unknown) {
      logger.error("Error updating factory bale product:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}

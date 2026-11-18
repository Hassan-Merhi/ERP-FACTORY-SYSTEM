import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { factoryContainerCommissions } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { registerRawStockContainerRoutesPart1 } from "./registerRawStockContainerRoutesPart1";
import { registerRawStockContainerRoutesPart2 } from "./registerRawStockContainerRoutesPart2";
import { registerRawStockContainerRoutesPart3 } from "./registerRawStockContainerRoutesPart3";

export function registerRawStockContainerRoutes(app: Express) {
  registerRawStockContainerRoutesPart1(app);
  registerRawStockContainerRoutesPart2(app);
  registerRawStockContainerRoutesPart3(app);

  app.get("/api/factory/container-commissions/:containerId", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const containerId = parseId(req.params.containerId);

      if (containerId === null) return res.status(400).json({ message: "Invalid id" });
      const results = await db
        .select()
        .from(factoryContainerCommissions)
        .where(
          and(
            eq(factoryContainerCommissions.companyId, companyId),
            eq(factoryContainerCommissions.containerId, containerId)
          )
        );

      res.json(results);
    } catch (error: unknown) {
      logger.error("Error fetching commissions:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

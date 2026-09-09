import type { Express } from "express";

import { requireAuth } from "../../auth";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { getInventoryPage } from "./inventoryQueryService";
import { getActiveInventoryCompanyId, parseInventoryListFilters } from "./inventoryRequestContext";

export function registerInventoryListRoutes(app: Express) {
  app.get("/api/inventory", requireAuth, async (req, res) => {
    try {
      // POS inventory access must stay location-scoped via
      // /api/locations/:locationId/inventory, where assigned-location and cost
      // permissions are both enforced. The company-wide list is not safe for POS.
      if (req.user?.role === "POS") return res.status(403).json({ message: "Forbidden" });

      const companyId = getActiveInventoryCompanyId(req);
      const filters = parseInventoryListFilters(req);
      return res.json(await getInventoryPage(companyId, filters));
    } catch (error: unknown) {
      logger.error("Inventory fetch failed", {
        module: "inventory",
        action: "getInventory",
        companyId: req.session.currentCompanyId,
        error,
      });
      const status = error instanceof Error && "statusCode" in error ? Number(error.statusCode) || 500 : 500;
      return res.status(status).json({ message: getErrorMessage(error) });
    }
  });
}

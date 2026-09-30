/**
 * adminRepairRoutes route composition.
 *
 * Registration order matches the original single-file module exactly.
 * Express resolves first-match, so reordering these calls can change which
 * handler serves a request - config/route-manifest.json pins the result.
 */
import type { Express } from "express";
import { registerAdminEquityRepairRoutes } from "./equity";
import { registerAdminOrphanedPosRoutes } from "./orphaned-pos";
import { registerAdminRebuildInventoryRoutes } from "./rebuild-inventory";
import { registerAdminNegativeInventoryRoutes } from "./negative-inventory";
import { registerAdminRepairMiscRoutes } from "./misc";
import { registerAdminInventoryValueRepairRoutes } from "./inventory-values";
import { registerAdminOrphanedBaleRoutes } from "./orphaned-bales";
import { registerHistoricalSalesCostRepairRoutes } from "./historical-sales-cost";

export function registerAdminRepairRoutes(app: Express) {
  registerAdminEquityRepairRoutes(app);
  registerAdminOrphanedPosRoutes(app);
  registerAdminRebuildInventoryRoutes(app);
  registerAdminNegativeInventoryRoutes(app);
  registerAdminRepairMiscRoutes(app);
  registerAdminInventoryValueRepairRoutes(app);
  registerAdminOrphanedBaleRoutes(app);
  registerHistoricalSalesCostRepairRoutes(app);
}

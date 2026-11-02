/**
 * factoryStockRoutes route composition.
 *
 * Registration order matches the original single-file module exactly.
 * Express resolves first-match, so reordering these calls can change which
 * handler serves a request - config/route-manifest.json pins the result.
 */
import type { Express } from "express";
import { registerFactoryStockEntryRoutes } from "./stockEntryRoutes";
import { registerFactoryStockRemovalRoutes } from "./stockRemovalRoutes";
import { registerAuthoritativeInventoryStockMiddleware } from "./authoritativeInventoryStockMiddleware";
import { registerFactoryLocationInventoryRoutes } from "./locationInventoryRoutes";
import { registerFactoryLocationInventoryExportRoutes } from "./locationInventoryExportRoutes";
import { registerFactoryStockQueryRoutes } from "./stockQueryRoutes";
import { registerFactoryStockQueryReportRoutes } from "./stockQueryReportRoutes";

export function registerFactoryStockRoutes(app: Express) {
  registerFactoryStockEntryRoutes(app);
  registerFactoryStockRemovalRoutes(app);
  registerAuthoritativeInventoryStockMiddleware(app);
  registerFactoryLocationInventoryRoutes(app);
  registerFactoryLocationInventoryExportRoutes(app);
  registerFactoryStockQueryRoutes(app);
  registerFactoryStockQueryReportRoutes(app);
}

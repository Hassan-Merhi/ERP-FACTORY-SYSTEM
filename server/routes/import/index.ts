/**
 * importRoutes route composition.
 *
 * Registration order matches the original single-file module exactly.
 * Express resolves first-match, so reordering these calls can change which
 * handler serves a request - config/route-manifest.json pins the result.
 */
import type { Express } from "express";
import { registerPoImportRoutes } from "./po-import";
import { registerIntercompanyContainerTradingRoutes } from "./intercompany-container-trading";
import { registerImportTemplateRoutes } from "./templates";
import { registerSilentTransferRoutes } from "./silent-transfer";
import { registerSilentProductionRoutes } from "./silent-production";

export function registerImportRoutes(app: Express) {
  registerPoImportRoutes(app);
  registerIntercompanyContainerTradingRoutes(app);
  registerImportTemplateRoutes(app);
  registerSilentTransferRoutes(app);
  registerSilentProductionRoutes(app);
}

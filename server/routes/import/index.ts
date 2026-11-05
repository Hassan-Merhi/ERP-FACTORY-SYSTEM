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
import { registerIntercompanyPhase3Routes } from "./intercompany-phase3";
import { registerIntercompanyPhase4Routes } from "./intercompany-phase4";
import { registerIntercompanyPhase5Routes } from "./intercompany-phase5";
import { registerImportTemplateRoutes } from "./templates";
import { registerSilentTransferRoutes } from "./silent-transfer";
import { registerSilentProductionRoutes } from "./silent-production";

export function registerImportRoutes(app: Express) {
  registerPoImportRoutes(app);
  registerIntercompanyContainerTradingRoutes(app);
  registerIntercompanyPhase3Routes(app);
  registerIntercompanyPhase4Routes(app);
  registerIntercompanyPhase5Routes(app);
  registerImportTemplateRoutes(app);
  registerSilentTransferRoutes(app);
  registerSilentProductionRoutes(app);
}

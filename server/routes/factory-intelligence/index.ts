/**
 * factoryIntelligenceRoutes route composition.
 *
 * Registration order matches the original single-file module exactly.
 * Express resolves first-match, so reordering these calls can change which
 * handler serves a request - config/route-manifest.json pins the result.
 */
import type { Database } from "../../db";
import type { Express, RequestHandler } from "express";
import { registerFactorySettingsRoutes } from "./settings";
import { registerFactoryMhdViewRoutes } from "./mhd-view";
import { registerFactoryDashboardWasteRoutes } from "./dashboard-waste";
import { registerFactoryKpiRoutes } from "./kpis";
import { registerFactoryProfitabilityRoutes } from "./profitability";
import { registerFactoryAlertRoutes } from "./alerts";
import { registerFactorySupplierScoreRoutes } from "./supplier-score";
import { registerFactoryMixOptimizeRoutes } from "./mix-optimize";
import { registerFactoryBaleTracePhotoRoutes } from "./bale-trace-photos";
import { registerFactoryCashflowRoutes } from "./cashflow";

export function registerFactoryIntelligenceRoutes(app: Express, requireAuth: RequestHandler, db: Database) {
  registerFactorySettingsRoutes(app, requireAuth, db);
  registerFactoryMhdViewRoutes(app, requireAuth, db);
  registerFactoryDashboardWasteRoutes(app, requireAuth, db);
  registerFactoryKpiRoutes(app, requireAuth, db);
  registerFactoryProfitabilityRoutes(app, requireAuth, db);
  registerFactoryAlertRoutes(app, requireAuth, db);
  registerFactorySupplierScoreRoutes(app, requireAuth, db);
  registerFactoryMixOptimizeRoutes(app, requireAuth, db);
  registerFactoryBaleTracePhotoRoutes(app, requireAuth, db);
  registerFactoryCashflowRoutes(app, requireAuth, db);
}

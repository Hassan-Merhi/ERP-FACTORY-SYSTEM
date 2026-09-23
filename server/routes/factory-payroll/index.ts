/**
 * factoryPayrollRoutes route composition.
 *
 * Registration order matches the original single-file module exactly for the
 * legacy handlers. Production-bonus subroutes are additive and use distinct
 * paths below /api/factory/payroll/:id/production-bonuses.
 */
import type { Database } from "../../db";
import type { Express, RequestHandler } from "express";
import { registerFactoryPayrollReadRoutes } from "./reads";
import { registerFactoryProductionBonusRoutes } from "./production-bonuses";
import { registerFactoryPayrollUpdateRoutes } from "./update";
import { registerFactoryPayrollDeleteRoutes } from "./delete";
import { registerFactoryPayrollExportRoutes } from "./exports";

export function registerFactoryPayrollRoutes(app: Express, requireAuth: RequestHandler, db: Database) {
  registerFactoryPayrollReadRoutes(app, requireAuth, db);
  registerFactoryProductionBonusRoutes(app, requireAuth, db);
  registerFactoryPayrollUpdateRoutes(app, requireAuth, db);
  registerFactoryPayrollDeleteRoutes(app, requireAuth, db);
  registerFactoryPayrollExportRoutes(app, requireAuth, db);
}

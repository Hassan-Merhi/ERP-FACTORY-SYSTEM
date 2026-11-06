/**
 * factoryBaleExportRoutes route composition.
 *
 * Registration order matches the original single-file module exactly.
 * Express resolves first-match, so reordering these calls can change which
 * handler serves a request - config/route-manifest.json pins the result.
 */
import type { Express } from "express";
import { registerFactoryDailyReportRoutes } from "./daily-report";
import { registerFactoryWeeklyReportExportRoutes } from "./weekly-report";
import { registerFactoryWeeklyReportWhatsappRoutes } from "./weekly-report-whatsapp";
import { registerFactoryProductionValueReportRoutes } from "./production-value-report";
import { registerFactoryMonthlyProductionMatrixRoutes } from "./monthly-production-matrix";
import { registerFactoryMonthlyProductionDrilldownRoutes } from "./monthly-production-drilldown";
import { registerFactoryMonthlyProductionExcelDetailRoutes } from "./monthly-production-excel-details";

export function registerFactoryBaleExportRoutes(app: Express) {
  registerFactoryDailyReportRoutes(app);
  registerFactoryWeeklyReportExportRoutes(app);
  registerFactoryWeeklyReportWhatsappRoutes(app);
  registerFactoryProductionValueReportRoutes(app);
  registerFactoryMonthlyProductionMatrixRoutes(app);
  registerFactoryMonthlyProductionDrilldownRoutes(app);
  registerFactoryMonthlyProductionExcelDetailRoutes(app);
}

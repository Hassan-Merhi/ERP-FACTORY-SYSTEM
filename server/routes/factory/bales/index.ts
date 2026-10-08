/**
 * factoryBalesRoutes route composition.
 *
 * Registration order matches the original single-file module exactly.
 * Express resolves first-match, so reordering these calls can change which
 * handler serves a request - config/route-manifest.json pins the result.
 */
import type { Express } from "express";
import { registerBalesPressingRoutes } from "./balesPressingRoutes";
import { registerBalesFinalizeRoutes } from "./balesFinalizeRoutes";
import { registerBalesExportRoutes } from "./balesExportRoutes";
import { registerBalesReimportRoutes } from "./balesReimportRoutes";
import { registerBalesCrudRoutes } from "./balesCrudRoutes";
import { registerBalesReportRoutes } from "./balesReportRoutes";
import { registerBalesImportRoutes } from "./balesImportRoutes";
import { registerBaleRecostRoutes } from "./baleRecostRoutes";

export function registerFactoryBalesRoutes(app: Express) {
  registerBalesPressingRoutes(app);
  registerBalesFinalizeRoutes(app);
  registerBalesExportRoutes(app);
  registerBalesReimportRoutes(app);
  registerBalesCrudRoutes(app);
  registerBalesReportRoutes(app);
  registerBalesImportRoutes(app);
  registerBaleRecostRoutes(app);
}

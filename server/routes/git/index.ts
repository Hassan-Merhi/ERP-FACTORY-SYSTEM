/**
 * Goods-In-Transit (GIT) route composition.
 *
 * Registration order matches the original single-file module exactly. Express
 * resolves first-match, so reordering these calls can change which handler
 * serves a request - config/route-manifest.json pins the result.
 */
import type { Express } from "express";
import { registerGitReportRoutes } from "./gitReportRoutes";
import { registerGitImportRoutes } from "./gitImportRoutes";
import { registerGitWhatsappRoutes } from "./gitWhatsappRoutes";
import { registerGitAgentRoutes } from "./gitAgentRoutes";
import { registerSpGitTrackingRoutes } from "./spGitTrackingRoutes";
import { registerSpGitTrackingImportRoutes } from "./spGitTrackingImportRoutes";

export function registerGitRoutes(app: Express) {
  registerGitReportRoutes(app);
  registerGitImportRoutes(app);
  registerGitWhatsappRoutes(app);
  registerGitAgentRoutes(app);
  registerSpGitTrackingRoutes(app);
  registerSpGitTrackingImportRoutes(app);
}

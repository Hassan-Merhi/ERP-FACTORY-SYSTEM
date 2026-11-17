import type { Express } from "express";
import { registerBrowserSyncRoutes } from "./browserSyncRoutes";
import { registerLegacyQueueDecisionRoutes } from "./legacyQueueDecisionRoutes";
import { registerPcSyncRoutes } from "./pcSyncRoutes";

/** Offline-mode routes, in their reviewed registration order (config/route-access-manifest.json). */
export function registerOfflineRoutes(app: Express): void {
  registerLegacyQueueDecisionRoutes(app);
  registerBrowserSyncRoutes(app);
  registerPcSyncRoutes(app);
}

/**
 * containerLoadedItemsRoutes: ContainerLoadedItemReport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, RequestHandler } from "express";
import { registerContainerLoadedItemReportRoutesPart1 } from "./registerContainerLoadedItemReportRoutesPart1";
import { registerContainerLoadedItemReportRoutesPart2 } from "./registerContainerLoadedItemReportRoutesPart2";

export function registerContainerLoadedItemReportRoutes(app: Express, requireAuth: RequestHandler) {
  registerContainerLoadedItemReportRoutesPart1(app, requireAuth);
  registerContainerLoadedItemReportRoutesPart2(app, requireAuth);
}

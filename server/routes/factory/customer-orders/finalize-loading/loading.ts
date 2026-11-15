/**
 * orderFinalizeLoadingRoutes: OrderLoading endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { registerOrderLoadingRoutesPart1 } from "./registerOrderLoadingRoutesPart1";
import { registerOrderLoadingRoutesPart2 } from "./registerOrderLoadingRoutesPart2";

export function registerOrderLoadingRoutes(app: Express) {
  registerOrderLoadingRoutesPart1(app);
  registerOrderLoadingRoutesPart2(app);
}

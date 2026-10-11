/**
 * containerOffloadRoutes route composition.
 *
 * Registration order matches the original single-file module exactly.
 * Express resolves first-match, so reordering these calls can change which
 * handler serves a request - config/route-manifest.json pins the result.
 */
import type { Express } from "express";
import { registerContainerOffloadCreateRoutes } from "./create";
import { registerContainerOffloadRecalcRoutes } from "./recalc";
import { registerContainerOffloadChargeRoutes } from "./charges";

export function registerContainerOffloadRoutes(app: Express) {
  registerContainerOffloadCreateRoutes(app);
  registerContainerOffloadRecalcRoutes(app);
  // Phase 19 (A), I9: the legacy PATCH /api/containers/:id/offload (./update.ts) is
  // deleted. registerCentralContainerOffloadRoute registers the same method and path
  // with the same guards first and always answers, so the legacy handler never ran.
  registerContainerOffloadChargeRoutes(app);
}

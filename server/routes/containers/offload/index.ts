/**
 * containerOffloadRoutes route composition.
 *
 * Reverse-offload and charge read endpoints retained after the canonical
 * offload POST/PATCH handlers were moved into centralContainerOffloadRoute.
 */
import type { Express } from "express";
import { registerContainerOffloadRecalcRoutes } from "./recalc";
import { registerContainerOffloadChargeRoutes } from "./charges";

export function registerContainerOffloadRoutes(app: Express) {
  registerContainerOffloadRecalcRoutes(app);
  registerContainerOffloadChargeRoutes(app);
}

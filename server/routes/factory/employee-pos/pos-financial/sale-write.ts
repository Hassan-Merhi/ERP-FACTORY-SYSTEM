/**
 * employeePosFinancialRoutes: PosSaleWrite endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { registerPosSaleWriteRoutesPart1 } from "./registerPosSaleWriteRoutesPart1";
import { registerPosSaleWriteRoutesPart2 } from "./sale-write-helpers";

export function registerPosSaleWriteRoutes(app: Express) {
  registerPosSaleWriteRoutesPart1(app);
  registerPosSaleWriteRoutesPart2(app);
}

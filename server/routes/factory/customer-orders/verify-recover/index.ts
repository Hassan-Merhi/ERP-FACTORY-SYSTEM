/**
 * orderVerifyRecoverRoutes route composition.
 *
 * Registration order matches the original single-file module exactly.
 * Express resolves first-match, so reordering these calls can change which
 * handler serves a request - config/route-manifest.json pins the result.
 */
import type { Express } from "express";
import { registerAuthoritativeVerificationStockMiddleware } from "./authoritativeVerificationStockMiddleware";
import { registerOrderVerificationSummaryRoutes } from "./verification-summary";
import { registerOrderRecoverBalesRoutes } from "./recover";
import { registerOrderVerifyRoutes } from "./verify";
import { registerContainerExtraExpectedLineRoutes } from "./container-extra-items";

export function registerOrderVerifyRecoverRoutes(app: Express) {
  registerAuthoritativeVerificationStockMiddleware(app);
  registerOrderVerificationSummaryRoutes(app);
  registerContainerExtraExpectedLineRoutes(app);
  registerOrderRecoverBalesRoutes(app);
  registerOrderVerifyRoutes(app);
}

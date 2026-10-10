/**
 * payrollCoreRoutes route composition.
 *
 * Registration order matches the original single-file module exactly.
 * Express resolves first-match, so reordering these calls can change which
 * handler serves a request - config/route-manifest.json pins the result.
 */
import type { Express } from "express";
import { registerPayrollCoreReadRoutes } from "./reads";
import { registerPayrollPreviewRoutes } from "./preview";
import { registerPayrollGenerateRoutes } from "./generate";
import { registerPayrollMarkPaidRoutes } from "./mark-paid";
import { registerPayrollPaymentSummaryPdfRoutes } from "./payment-summary-pdf";

export function registerPayrollCoreRoutes(app: Express) {
  registerPayrollCoreReadRoutes(app);
  registerPayrollPreviewRoutes(app);
  registerPayrollGenerateRoutes(app);
  registerPayrollMarkPaidRoutes(app);
  registerPayrollPaymentSummaryPdfRoutes(app);
  // Phase 19 (A): POST /api/factory/payroll/migrate-worker-names is retired (floats,
  // hard-deleted accounts, rewrote posted lines, no audit), like migrate-city-split.
}

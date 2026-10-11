/**
 * workerStatementRoutes route composition.
 *
 * Registration order matches the original single-file module exactly.
 * Express resolves first-match, so reordering these calls can change which
 * handler serves a request - config/route-manifest.json pins the result.
 */
import type { Express } from "express";
import { registerWorkerRepaymentDeleteRoutes } from "./repayments";
import { registerWorkerStatementReadRoutes } from "./statement";
import { registerWorkerDeleteRoutes } from "./worker-delete";
import { registerOrphanedVoucherRepairRoutes } from "./repair";

export function registerWorkerStatementRoutes(app: Express) {
  registerWorkerRepaymentDeleteRoutes(app);
  // Phase 19 (A): POST /api/admin/backfill-payroll-vouchers is retired: it debited
  // salary expense again for payrolls the accrual had already expensed (double count),
  // trusted the body's company, used floats and wrote no audit.
  registerWorkerStatementReadRoutes(app);
  registerWorkerDeleteRoutes(app);
  registerOrphanedVoucherRepairRoutes(app);
}

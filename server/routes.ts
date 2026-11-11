import type { Express } from "express";
import type { Server } from "http";

import { registerApplicationRoutes } from "./routes/applicationRoutes";
import { registerOperationalMonitoringRoutes } from "./routes/admin/operationalMonitoringRoutes";
import { registerTrainingMediaRoutes } from "./routes/trainingMediaRoutes";
import { registerLegacyQueueDecisionRoutes } from "./routes/offline/legacyQueueDecisionRoutes";
import { registerSeasonalAppearanceRoutes } from "./routes/seasonalAppearanceRoutes";
import { registerTenantIsolationBoundary } from "./routes/tenantBoundaryRegistrar";
import { registerStockTransferOrderWaApprovalWebhookRoutes } from "./routes/stockTransferOrderWaApprovalWebhookRoutes";
import { registerOperationalVoucherRequestBoundary } from "./services/accounting/operationalVoucherRequestBoundary";
import { registerVoucherPathPhase5to6Boundary } from "./services/accounting/voucherPathPhase5to6Boundary";

export function registerRoutes(app: Express): Promise<Server> {
  // This machine-to-machine endpoint must be authenticated by the webhook
  // token, not by ERP browser cookies, tenant roles or session CSRF.
  // Register its exact path before human-session request boundaries.
  registerStockTransferOrderWaApprovalWebhookRoutes(app);
  registerTenantIsolationBoundary(app);
  registerOperationalVoucherRequestBoundary(app);
  registerVoucherPathPhase5to6Boundary(app);
  registerOperationalMonitoringRoutes(app);
  registerTrainingMediaRoutes(app);
  registerLegacyQueueDecisionRoutes(app);
  registerSeasonalAppearanceRoutes(app);
  return registerApplicationRoutes(app);
}

import type { Express } from "express";
import type { Server } from "http";

import { registerApplicationRoutes } from "./routes/applicationRoutes";
import { registerOperationalMonitoringRoutes } from "./routes/admin/operationalMonitoringRoutes";
import { registerTrainingMediaRoutes } from "./routes/trainingMediaRoutes";
import { registerLegacyQueueDecisionRoutes } from "./routes/offline/legacyQueueDecisionRoutes";
import { registerBrowserSyncRoutes } from "./routes/offline/browserSyncRoutes";
import { registerSeasonalAppearanceRoutes } from "./routes/seasonalAppearanceRoutes";
import { registerTenantIsolationBoundary } from "./routes/tenantBoundaryRegistrar";
import { registerOperationalVoucherRequestBoundary } from "./services/accounting/operationalVoucherRequestBoundary";
import { registerVoucherPathPhase5to6Boundary } from "./services/accounting/voucherPathPhase5to6Boundary";

export function registerRoutes(app: Express): Promise<Server> {
  registerTenantIsolationBoundary(app);
  registerOperationalVoucherRequestBoundary(app);
  registerVoucherPathPhase5to6Boundary(app);
  registerOperationalMonitoringRoutes(app);
  registerTrainingMediaRoutes(app);
  registerLegacyQueueDecisionRoutes(app);
  registerBrowserSyncRoutes(app);
  registerSeasonalAppearanceRoutes(app);
  return registerApplicationRoutes(app);
}

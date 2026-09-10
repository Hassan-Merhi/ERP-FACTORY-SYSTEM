import type { Express } from "express";
import { registerContainerListPaginationRoutes } from "./containers/containerListPaginationRoutes";
import { registerContainerCrudRoutes } from "./containers/containerCrudRoutes";
import { registerContainerTrackingRoutes } from "./containers/containerTrackingRoutes";
import { registerSupplierTrackingDefaultRoutes } from "./containers/supplierTrackingDefaultRoutes";
import { registerContainerAccountingRoutes } from "./containers/accounting";
import { registerContainerFreightRoutes } from "./containers/containerFreightRoutes";
import { registerContainerOffloadLifecycleGuard } from "./containers/containerOffloadLifecycleGuard";
import { registerCentralContainerOffloadRoute } from "./containers/centralContainerOffloadRoute";
import { registerContainerOffloadRoutes } from "./containers/offload";
import { registerContainerDocumentsRoutes } from "./containers/containerDocumentsRoutes";
import { registerContainerCostingRoutes } from "./containers/containerCostingRoutes";

export function registerContainerRoutes(app: Express) {
  // Settings/default routes and tracking literal routes must be registered before
  // containerCrudRoutes' /api/containers/:id compatibility reader.
  registerSupplierTrackingDefaultRoutes(app);
  registerContainerTrackingRoutes(app);
  // Explicit pagination requests are handled in SQL; legacy callers continue to
  // fall through to the compatibility readers below.
  registerContainerListPaginationRoutes(app);
  registerContainerCrudRoutes(app);
  registerContainerAccountingRoutes(app);
  registerContainerFreightRoutes(app);
  // Serialize and preflight the complete request, then commit reversal, inventory,
  // charge vouchers, replacement offload, and SP journals through one transaction.
  registerContainerOffloadLifecycleGuard(app);
  registerCentralContainerOffloadRoute(app);
  // Legacy reverse-offload and compatibility routes remain available; the central
  // POST/PATCH handlers above own all active offload creation and edit requests.
  registerContainerOffloadRoutes(app);
  registerContainerDocumentsRoutes(app);
  registerContainerCostingRoutes(app);
}

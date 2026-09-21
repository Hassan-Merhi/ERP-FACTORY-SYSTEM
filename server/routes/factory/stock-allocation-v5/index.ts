/**
 * factoryStockAllocationV5Routes route composition.
 *
 * Registration order matches the original single-file module exactly.
 * Express resolves first-match, so reordering these calls can change which
 * handler serves a request - config/route-manifest.json pins the result.
 */
import type { Express } from "express";
import { registerV5AllocationAvailabilityView } from "./availability-view";
import { registerV5StockAllocationRoutes } from "./allocation";
import { registerV5ProformaCreateRoutes } from "./proforma-create";
import { registerV5ProformaUpdateRoutes } from "./proforma-update";
import { registerV5LocationSummaryRoutes } from "./location-summary";
import { registerV5CancelledContainerRoutes } from "./cancelled-containers";
import { registerV5UnlinkedLoadingOrderRoutes } from "./unlinked-orders";
import { registerV5ContainerPlannerRoutes } from "./container-planner";
import { registerV5ContainerPlannerReconciliationRoutes } from "./container-planner-reconciliation";
import { registerV5ContainerPlanBaleRoutes } from "./container-plan-bales";

export function registerFactoryStockAllocationV5Routes(app: Express) {
  // Response-only middleware: the canonical allocation handler still owns all
  // arithmetic, filtering, authorization and company scoping.
  registerV5AllocationAvailabilityView(app);
  registerV5StockAllocationRoutes(app);
  registerV5ProformaCreateRoutes(app);
  registerV5ProformaUpdateRoutes(app);
  registerV5LocationSummaryRoutes(app);
  registerV5CancelledContainerRoutes(app);
  registerV5UnlinkedLoadingOrderRoutes(app);
  registerV5ContainerPlannerRoutes(app);
  registerV5ContainerPlannerReconciliationRoutes(app);
  registerV5ContainerPlanBaleRoutes(app);
}

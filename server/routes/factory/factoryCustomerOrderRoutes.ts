import type { Express } from "express";
import { registerOrderCrudRoutes } from "./customer-orders/orderCrudRoutes";
import { registerPriorityScanConfigRoutes } from "./customer-orders/priorityScanConfigRoutes";
import { registerBaleScanningRoutes } from "./customer-orders/bale-scanning";
import { registerChargeLedgerPrerequisite } from "./customer-orders/chargeLedgerPrerequisite";
import { registerOrderChargesRoutes } from "./customer-orders/orderChargesRoutes";
import { registerOrderStatusRoutes } from "./customer-orders/orderStatusRoutes";
import { registerOrderPricingRoutes } from "./customer-orders/orderPricingRoutes";
import { registerOrderDocumentsRoutes } from "./customer-orders/orderDocumentsRoutes";
import { registerOrderTrackingRoutes } from "./customer-orders/orderTrackingRoutes";

export function registerFactoryCustomerOrderRoutes(app: Express) {
  // Priority Scan owns a static /customer-orders/priority-scan-configs GET.
  // Register it before the generic /customer-orders/:id GET in CRUD routes so
  // Express never treats "priority-scan-configs" as an order id.
  registerPriorityScanConfigRoutes(app);
  registerOrderCrudRoutes(app);
  registerBaleScanningRoutes(app);
  registerChargeLedgerPrerequisite(app);
  registerOrderChargesRoutes(app);
  registerOrderStatusRoutes(app);
  registerOrderPricingRoutes(app);
  registerOrderDocumentsRoutes(app);
  registerOrderTrackingRoutes(app);
}

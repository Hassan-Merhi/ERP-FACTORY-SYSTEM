/**
 * factoryContainersRoutes route composition.
 *
 * Registration order matches the original single-file module exactly for
 * existing routes. AIS routes are appended so they cannot shadow legacy
 * container handlers.
 */
import type { Express } from "express";
import { registerFactoryContainerListRoutes } from "./list";
import { registerFactoryContainerCreateRoutes } from "./create";
import { registerFactoryContainerUpdateRoutes } from "./update";
import { registerFactoryContainerDeleteRoutes } from "./delete";
import { registerFactoryContainerOtherChargesRoutes } from "./other-charges";
import { registerFactoryContainerOtherChargesCurrencyAdminRoutes } from "./other-charges-currency-admin";
import { registerFactoryContainerImportRoutes } from "./import-excel";
import { registerFactoryContainerMoveSupplierRoutes } from "./move-supplier";
import { registerFactoryContainerRawStockDelegation } from "./raw-stock";
import { registerFactoryContainerVesselTrackingRoutes } from "./vessel-tracking";

export function registerFactoryContainersRoutes(app: Express) {
  registerFactoryContainerListRoutes(app);
  registerFactoryContainerCreateRoutes(app);
  registerFactoryContainerUpdateRoutes(app);
  registerFactoryContainerDeleteRoutes(app);
  registerFactoryContainerOtherChargesRoutes(app);
  registerFactoryContainerOtherChargesCurrencyAdminRoutes(app);
  registerFactoryContainerImportRoutes(app);
  registerFactoryContainerMoveSupplierRoutes(app);
  registerFactoryContainerRawStockDelegation(app);
  registerFactoryContainerVesselTrackingRoutes(app);
}

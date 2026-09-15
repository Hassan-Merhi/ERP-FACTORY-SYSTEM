import type { Express } from "express";
import { registerContainerFreightReadRoutes } from "./containerFreightReadRoutes";
import { registerPurchaseOrderEditConcurrencyGuard } from "./purchaseOrderEditConcurrencyGuard";
import { registerContainerFreightWriteRoutes } from "./containerFreightWriteRoutes";

export function registerContainerFreightRoutes(app: Express) {
  registerContainerFreightReadRoutes(app);
  registerPurchaseOrderEditConcurrencyGuard(app);
  registerContainerFreightWriteRoutes(app);
}

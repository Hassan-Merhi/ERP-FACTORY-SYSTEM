import type { Express } from "express";
import { registerContainerFreightReadRoutes } from "./containerFreightReadRoutes";
import { installPurchaseOrderEditConcurrencyGuard } from "./purchaseOrderEditConcurrencyGuard";
import { registerContainerFreightWriteRoutes } from "./containerFreightWriteRoutes";

export function registerContainerFreightRoutes(app: Express) {
  registerContainerFreightReadRoutes(app);
  registerContainerFreightWriteRoutes(app);
  installPurchaseOrderEditConcurrencyGuard(app);
}

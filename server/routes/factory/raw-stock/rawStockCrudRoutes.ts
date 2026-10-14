import type { Express } from "express";
import { registerRawStockReceiptRoutes } from "./rawStockReceiptRoutes";
import { registerRawStockAvailableContainerRoutes } from "./rawStockAvailableContainerRoutes";
import { registerRawStockAdjRoutes } from "./rawStockAdjRoutes";

export function registerRawStockCrudRoutes(app: Express) {
  registerRawStockReceiptRoutes(app);
  // Canonical available-container reader; the unreachable legacy copy is retired.
  registerRawStockAvailableContainerRoutes(app);
  registerRawStockAdjRoutes(app);
}

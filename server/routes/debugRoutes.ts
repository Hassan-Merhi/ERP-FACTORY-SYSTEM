import type { Express } from "express";
import { registerFactoryOrderRepairRoutes } from "./debug/factoryOrderRepairRoutes";
import { registerImportCycleDiagnosticRoutes } from "./debug/importCycleDiagnosticRoutes";
import { registerInventoryDebugRoutes } from "./debug/inventoryDebugRoutes";
import { registerOrphanedChargeVoucherRoutes } from "./debug/orphanedChargeVoucherRoutes";
import { registerOffloadActiveVoucherGuard } from "./offloadActiveVoucherGuard";
import { registerOffloadRoutes } from "./offloadRoutes";

export function registerDebugRoutes(app: Express) {
  registerInventoryDebugRoutes(app);
  registerImportCycleDiagnosticRoutes(app);
  registerOrphanedChargeVoucherRoutes(app);
  registerOffloadActiveVoucherGuard(app);
  registerOffloadRoutes(app);
  registerFactoryOrderRepairRoutes(app);
}

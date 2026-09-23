import type { Express } from "express";
import { registerUserManagementRoutes } from "./admin/userManagementRoutes";
import { registerCompanySettingsRoutes } from "./admin/companySettingsRoutes";
import { registerAccountMigrationRoundTripRoutes } from "./admin/accountMigrationRoundTripRoutes";
import { registerAccountMigrationSafeRoutes } from "./admin/accountMigrationSafeRoutes";
import { registerImportExportRoutes } from "./admin/import-export";
import { registerAdminPoFixRoutes } from "./admin/adminPoFixRoutes";
import { registerAdminRepairRoutes } from "./admin/repair";
import { registerDependentDeletedItemPermanentRoutes } from "./admin/dependentDeletedItemPermanentRoutes";
import { registerDeletedItemsRoutes } from "./admin/deleted-items";
import { registerSecurityAnomalyRoutes } from "./admin/securityAnomalyRoutes";
import { registerSecurityPermissionRoutes } from "./admin/securityPermissionRoutes";
import { registerSchemaDiagnosticRoutes } from "./admin/schemaDiagnosticRoutes";
import { registerConvergenceReconciliationRoutes } from "./admin/convergenceReconciliationRoutes";
import { requirePrivilegedOperation } from "../services/security/privilegedOperationEnforcementAdapter";
import {
  inventoryRebuildInputSchema,
  requireValidatedUnsafeInput,
} from "../services/security/unsafeInputEnforcementAdapter";
import { requireStoredFileAccess } from "../services/security/storedFileAccessAdapter";
import { enforceAdminCompanyScope } from "../middleware/adminCompanyScopeGuard";

export function registerAdminRoutes(app: Express) {
  for (const path of [
    "/api/admin",
    "/api/orphaned-records",
    "/api/location-summary",
    "/api/deleted-items",
    "/api/files",
  ]) {
    app.use(path, enforceAdminCompanyScope);
  }

  app.use(
    "/api/admin/rebuild-inventory",
    requireValidatedUnsafeInput({
      operation: "inventory.rebuild",
      schema: inventoryRebuildInputSchema,
    }),
    requirePrivilegedOperation({
      domain: "inventory",
      action: "inventory.rebuild",
      kind: "recalculate",
      requiredPermission: "administration.repair",
      sourceType: "inventory-rebuild-request",
      expectedConfirmationToken: (companyId) => `REBUILD-INVENTORY:${companyId}`,
      allowDryRun: true,
    })
  );

  app.use("/api/files/:id/download", requireStoredFileAccess("download"));
  app.use("/api/files/:id/preview", requireStoredFileAccess("read"));

  registerUserManagementRoutes(app);
  registerCompanySettingsRoutes(app);
  registerAccountMigrationRoundTripRoutes(app);
  registerAccountMigrationSafeRoutes(app);
  registerImportExportRoutes(app);
  registerAdminPoFixRoutes(app);
  registerAdminRepairRoutes(app);
  registerDependentDeletedItemPermanentRoutes(app);
  registerDeletedItemsRoutes(app);
  registerSecurityAnomalyRoutes(app);
  registerSecurityPermissionRoutes(app);
  registerSchemaDiagnosticRoutes(app);
  registerConvergenceReconciliationRoutes(app);
}

import type { Express } from "express";
import { requireExplicitCompanyContext } from "../../services/security/companyContextEnforcementAdapter";
import { requireLegacyPrivilegedWrite } from "../../services/security/legacyPrivilegedWriteGuard";
import { requirePostOffloadLedgerOwnership } from "../../services/security/postOffloadLedgerOwnershipGuard";
import { requireRawStockSensitiveInput } from "../../services/security/rawStockSensitiveInputGuard";
import { registerRawStockCrudRoutes } from "./raw-stock/rawStockCrudRoutes";
import { registerRawStockOffloadRoutes } from "./raw-stock/rawStockOffloadRoutes";
import { registerRawStockContainerRoutes } from "./raw-stock/rawStockContainerRoutes";
import { registerRawStockBalanceRoutes } from "./raw-stock/rawStockBalanceRoutes";
import { registerRawStockRecalcRoutes } from "./raw-stock/registerRawStockRecalcRoutes";
import { registerRawStockDiagnosticRoutes } from "./raw-stock/rawStockDiagnosticRoutes";
import { postOffloadHistoricalReplayMiddleware } from "./raw-stock/postOffloadHistoricalReplayMiddleware";
import { requirePostOffloadImpactPreview } from "./raw-stock/postOffloadImpactPreviewMiddleware";
import { registerPostOffloadImpactPreviewRoutes } from "./raw-stock/postOffloadImpactPreviewRoutes";
import { postOffloadReconciliationMiddleware } from "./raw-stock/postOffloadReconciliationMiddleware";
import { registerPostOffloadPhase6SafetyRoutes } from "./raw-stock/postOffloadPhase6SafetyRoutes";
import { requireValidBatchSourceDeleteInput } from "./raw-stock/batchSourceDeleteInputGuard";

const RAW_STOCK_REPAIR_PERMISSION = "factory.raw-stock.repair";

export function registerFactoryRawStockRoutes(app: Express) {
  app.use(
    "/api/factory/raw-stock",
    requireExplicitCompanyContext({
      assertionFields: ["companyId", "factoryCompanyId"],
      includeLegacyFactorySessionAssertion: true,
    })
  );

  // Validate and freeze high-impact repair payloads before permission,
  // confirmation, audit, or business logic can consume them.
  app.use("/api/factory/raw-stock", requireRawStockSensitiveInput);

  // Reject malformed batch-source delete requests before the legacy route can
  // turn missing identifiers into sentinel IDs and raise a server error.
  app.use("/api/factory/raw-stock/batch-source", requireValidBatchSourceDeleteInput);

  // Post-offload charge routes live under /api/factory/containers even though
  // they are registered by the raw-stock module. Reject foreign, inactive, or
  // deleted ledger targets before the route can derive a voucher company from them.
  app.use("/api/factory/containers", requirePostOffloadLedgerOwnership);

  // Refreshed clients bind CREATE requests to a signed, short-lived read-only
  // impact preview. Legacy callers remain compatible until they opt into v1.
  app.use("/api/factory/containers", requirePostOffloadImpactPreview);

  // This outer response wrapper is registered before historical replay so it
  // receives the replay result and then reconciles accounting, inventory,
  // reporting refresh coverage, and exact undo availability.
  app.use("/api/factory/containers", postOffloadReconciliationMiddleware);

  // After a successful post-offload CREATE/EDIT/UNDO/LEGACY_REBUILD transaction,
  // replay the affected supplier's exact historical cost timeline before sending
  // the response. This catches supplier-priced historical mix sources that the
  // direct container cascade cannot correctly reprice by itself.
  app.use("/api/factory/containers", postOffloadHistoricalReplayMiddleware);

  const directRepair = (action: string, sourceType: string) =>
    requireLegacyPrivilegedWrite({
      action,
      domain: "factory",
      kind: "recalculate",
      requiredPermission: RAW_STOCK_REPAIR_PERMISSION,
      sourceType,
      enforcement: "always",
    });

  // confirmedRepair gates removed from these endpoints — each route owns a
  // stronger cryptographic dry-run/token confirmation flow, and the frontend
  // mutations do not supply the reason/idempotencyKey provenance fields that
  // the privileged-operation policy requires. Security is enforced by
  // requireAuth + requireRole(Admin/Developer) + signRepairToken/verifyRepairToken.
  app.use(
    "/api/factory/raw-stock/recalc/auto-apply-fx",
    directRepair("factory.raw-stock.fx.auto-apply", "container-fx-repair")
  );
  app.use(
    "/api/factory/raw-stock/supplier-rate/recompute",
    directRepair("factory.raw-stock.supplier-rate.recompute", "supplier-rate-repair")
  );
  app.use(
    "/api/factory/raw-stock/recalc/fix-source-mismatches",
    directRepair("factory.raw-stock.source-mismatches.fix", "mix-batch-source-repair")
  );
  app.use(
    "/api/factory/raw-stock/recalc/undo",
    requireLegacyPrivilegedWrite({
      action: "factory.raw-stock.recalc.undo",
      domain: "factory",
      kind: "destructive",
      requiredPermission: RAW_STOCK_REPAIR_PERMISSION,
      sourceType: "raw-stock-recalc-undo",
      enforcement: "always",
      sourceId: (req) => String(req.body?.undoLogId || "recalc-undo"),
    })
  );

  registerRawStockCrudRoutes(app);
  registerRawStockOffloadRoutes(app);
  registerPostOffloadImpactPreviewRoutes(app);
  registerPostOffloadPhase6SafetyRoutes(app);
  registerRawStockContainerRoutes(app);
  registerRawStockBalanceRoutes(app);
  registerRawStockRecalcRoutes(app);
  registerRawStockDiagnosticRoutes(app);
}

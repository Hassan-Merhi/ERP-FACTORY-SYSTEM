import type { Express } from "express";
import { logger } from "../../lib/logger";
import { registerSpAccessControl } from "./spAccessControl";
import { registerSpPermissionRoutes } from "./spPermissionRoutes";
import { registerSpSetupRoutes } from "./spSetupRoutes";
import { registerSpGoldenCoastSetupRoutes } from "./spGoldenCoastSetupRoutes";
import { registerSpGoldenCoastExistingPositionCarryForwardRoutes } from "./spGoldenCoastExistingPositionCarryForwardRoutes";
import { registerSpGoldenCoastPhase3CutoverRoutes } from "./spGoldenCoastPhase3CutoverRoutes";
import { registerSpGoldenCoastPhase4CutoverFifoRoutes } from "./spGoldenCoastPhase4CutoverFifoRoutes";
import { registerSpGoldenCoastPhase6PosSaleRoutes } from "./spGoldenCoastPhase6PosSaleRegistration";
import { registerSpGoldenCoastPhase16HadiTransferGuard } from "./spGoldenCoastPhase16HadiTransferGuard";
import { registerSpGoldenCoastPhase7HadiTransferRoutes } from "./spGoldenCoastPhase7HadiTransferRoutes";
import { registerSpGoldenCoastFreshStartHadiPaymentRoutes } from "./spGoldenCoastFreshStartHadiPaymentRoutes";
import { registerSpGoldenCoastPhase8ContainerOffloadRoutes } from "./spGoldenCoastPhase8ContainerOffloadRoutes";
import { registerSpGoldenCoastPhase9HassanSavingsWithdrawalRoutes } from "./spGoldenCoastPhase9HassanSavingsWithdrawalRoutes";
import { registerSpGoldenCoastPhase10SalesCashSettlementRoutes } from "./spGoldenCoastPhase10SalesCashSettlementRoutes";
import { registerSpGoldenCoastEquitySalesCashSettlementRoutes } from "./spGoldenCoastEquitySalesCashSettlementRoutes";
import { registerSpGoldenCoastPhase11MonthlyCloseRoutes } from "./spGoldenCoastPhase11MonthlyCloseRoutes";
import { registerSpGoldenCoastLegacySalesGuard } from "./spGoldenCoastLegacySalesGuard";
import { registerSpContainerRoutes } from "./spContainerRoutes";
import { registerSpLifecycleGuards } from "./spLifecycleGuards";
import { registerSpReoffloadPreparationGuard } from "./spReoffloadPreparationGuard";
import { registerSpOffloadConcurrencyGuard } from "./spOffloadConcurrencyGuard";
import { registerSpOffloadRoutes } from "./spOffloadRoutes";
import { registerSpOffloadLifecycleRoutes } from "./spOffloadLifecycleRoutes";
import { registerSpChargeReconciliationRoutes } from "./spChargeReconciliationRoutes";
import { registerSpFullReconciliationRoutes } from "./spFullReconciliationRoutes";
import { registerSpProductionClosureRoutes } from "./spProductionClosureRoutes";
import { ensureSpProductionClosureStorage } from "./spProductionClosureStorage";
import { registerSpSalesRoutes } from "./spSalesRoutes";
import { registerSpLifecycleRoutes } from "./spLifecycleRoutes";
import { registerSpOpeningStockRoutes } from "./spOpeningStockRoutes";
import { registerSpAliasRoutes } from "./spAliasRoutes";
import { registerSpReportRoutes } from "./spReportRoutes";
import { registerSpExportRoutes } from "./spExportRoutes";
import { registerSpMigrationPhase2Routes } from "./spMigrationPhase2Routes";
import { registerSpMigrationCutoverRoutes } from "./spMigrationCutoverRoutes";
import { registerSpMigrationFinalVerificationRoutes } from "./spMigrationFinalVerification";
import { registerSpMigrationPhase4Routes } from "./spMigrationPhase4Routes";
import { ensureCutoverHardening, installExplicitCompanyWriteGuard } from "./spMigrationCutoverHardening";
import { runSpSupplierVoucherStartup } from "./spSupplierVoucherStartup";

export function registerSpRoutes(app: Express) {
  registerSpAccessControl(app);
  registerSpPermissionRoutes(app);

  installExplicitCompanyWriteGuard(app);
  registerSpMigrationPhase4Routes(app);
  registerSpMigrationCutoverRoutes(app);
  registerSpMigrationPhase2Routes(app);
  registerSpMigrationFinalVerificationRoutes(app);
  void ensureCutoverHardening().catch((error) => {
    logger.warn("[SP Cutover] Hardening indexes deferred", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  void ensureSpProductionClosureStorage().catch((error) => {
    logger.warn("[SP Production Closure] Storage initialization deferred", {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  void runSpSupplierVoucherStartup()
    .then((repairedCount) => {
      if (repairedCount > 0) {
        logger.info("[SP] Repaired Goods-OTW voucher supplier links", {
          repairedCount,
        });
      }
    })
    .catch((error) => {
      logger.warn("[SP] Supplier voucher synchronization deferred until Setup", {
        error: error instanceof Error ? error.message : String(error),
      });
    });

  registerSpSetupRoutes(app);
  registerSpGoldenCoastSetupRoutes(app);
  registerSpGoldenCoastExistingPositionCarryForwardRoutes(app);
  registerSpGoldenCoastPhase3CutoverRoutes(app);
  registerSpGoldenCoastPhase4CutoverFifoRoutes(app);
  // Phase 6 supersedes the Phase 5 mutation surface: it keeps the same FIFO
  // revenue/COGS behavior and atomically routes Golden Coast sale proceeds into
  // the configured HADI company before Phase 15 creates the credit payable.
  registerSpGoldenCoastPhase6PosSaleRoutes(app);
  // Phase 16 leaves the Phase 7 readiness probe available for HADI discovery,
  // but fail-closes the obsolete manual debit-model POST before its legacy
  // handler can run. HADI-held sales proceeds are paid through the Fresh Start
  // settlement route below.
  registerSpGoldenCoastPhase16HadiTransferGuard(app);
  registerSpGoldenCoastPhase7HadiTransferRoutes(app);
  registerSpGoldenCoastFreshStartHadiPaymentRoutes(app);
  registerSpGoldenCoastPhase8ContainerOffloadRoutes(app);
  registerSpGoldenCoastPhase9HassanSavingsWithdrawalRoutes(app);
  registerSpGoldenCoastPhase10SalesCashSettlementRoutes(app);
  registerSpGoldenCoastEquitySalesCashSettlementRoutes(app);
  // Mount before generic SP reports so Golden Coast's legacy client-calculated
  // profit-split mutation is retired before the old handler can run.
  registerSpGoldenCoastPhase11MonthlyCloseRoutes(app);
  registerSpLifecycleGuards(app);
  registerSpContainerRoutes(app);
  registerSpReoffloadPreparationGuard(app);
  registerSpOffloadConcurrencyGuard(app);
  registerSpOffloadRoutes(app);
  registerSpOffloadLifecycleRoutes(app);
  registerSpChargeReconciliationRoutes(app);
  registerSpFullReconciliationRoutes(app);
  registerSpProductionClosureRoutes(app);
  // Fail closed before the generic SP sales route: Golden Coast must stay on
  // the Phase 6 atomic sale + HADI collection path even for stale clients.
  registerSpGoldenCoastLegacySalesGuard(app);
  registerSpSalesRoutes(app);
  registerSpLifecycleRoutes(app);
  registerSpOpeningStockRoutes(app);
  registerSpAliasRoutes(app);
  registerSpReportRoutes(app);
  registerSpExportRoutes(app);
}

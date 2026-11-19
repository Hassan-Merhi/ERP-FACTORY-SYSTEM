import type { Express } from "express";
import { registerSpAccessControl } from "./spAccessControl";
import { registerSpPermissionRoutes } from "./spPermissionRoutes";
import { registerSpSetupRoutes } from "./spSetupRoutes";
import { registerSpGoldenCoastSetupRoutes } from "./spGoldenCoastSetupRoutes";
import { registerSpGoldenCoastExistingPositionCarryForwardRoutes } from "./spGoldenCoastExistingPositionCarryForwardRoutes";
import { registerSpGoldenCoastPhase3CutoverRoutes } from "./spGoldenCoastCutoverRoutes";
import { registerSpGoldenCoastPhase4CutoverFifoRoutes } from "./spGoldenCoastCutoverFifoRoutes";
import { registerSpGoldenCoastPhase6PosSaleRoutes } from "./spGoldenCoastPosSaleRegistration";
import { registerSpGoldenCoastPhase16HadiTransferGuard } from "./spGoldenCoastHadiTransferGuard";
import { registerSpGoldenCoastPhase7HadiTransferRoutes } from "./spGoldenCoastHadiTransferRoutes";
import { registerSpGoldenCoastFreshStartHadiPaymentRoutes } from "./spGoldenCoastFreshStartHadiPaymentRoutes";
import { registerSpGoldenCoastPhase8ContainerOffloadRoutes } from "./spGoldenCoastContainerOffloadRoutes";
import { registerSpGoldenCoastPhase9HassanSavingsWithdrawalRoutes } from "./spGoldenCoastHassanSavingsWithdrawalRoutes";
import { registerSpGoldenCoastPhase10SalesCashSettlementRoutes } from "./spGoldenCoastSalesCashSettlementRoutes";
import { registerSpGoldenCoastEquitySalesCashSettlementRoutes } from "./spGoldenCoastEquitySalesCashSettlementRoutes";
import { registerSpGoldenCoastPhase11MonthlyCloseRoutes } from "./spGoldenCoastMonthlyCloseRoutes";
import { registerSpGoldenCoastLegacySalesGuard } from "./spGoldenCoastLegacySalesGuard";
import { registerSpContainerRoutes } from "./spContainerRoutes";
import { registerSpLifecycleGuards } from "./spLifecycleGuards";
import { registerSpReoffloadPreparationGuard } from "./spReoffloadPreparationGuard";
import { registerSpOffloadConcurrencyGuard } from "./spOffloadConcurrencyGuard";
import { registerSpOffloadPrepaidCompanyGuard } from "./spOffloadPrepaidCompanyGuard";
import { registerSpOffloadRoutes } from "./spOffloadRoutes";
import { registerSpOffloadLifecycleRoutes } from "./spOffloadLifecycleRoutes";
import { registerSpChargeReconciliationRoutes } from "./spChargeReconciliationRoutes";
import { registerSpFullReconciliationRoutes } from "./spFullReconciliationRoutes";
import { registerSpProductionClosureRoutes } from "./spProductionClosureRoutes";
import { registerSpSalesRoutes } from "./spSalesRoutes";
import { registerSpLifecycleRoutes } from "./spLifecycleRoutes";
import { registerSpOpeningStockRoutes } from "./spOpeningStockRoutes";
import { registerSpAliasRoutes } from "./spAliasRoutes";
import { registerSpReportRoutes } from "./spReportRoutes";
import { registerSpExportRoutes } from "./spExportRoutes";
import { registerSpMigrationPhase2Routes } from "./spMigrationRehearsalRoutes";
import { registerSpMigrationCutoverRoutes } from "./spMigrationCutoverRoutes";
import { registerSpMigrationPhase4Routes } from "./spMigrationFinalCutoverRoutes";
import { installExplicitCompanyWriteGuard } from "./spMigrationCutoverHardening";
import { registerSpSupplierVoucherLinkRepairRoutes } from "./spSupplierVoucherLinkRepairRoutes";

export function registerSpRoutes(app: Express) {
  registerSpAccessControl(app);
  registerSpPermissionRoutes(app);

  installExplicitCompanyWriteGuard(app);
  registerSpMigrationPhase4Routes(app);
  registerSpMigrationCutoverRoutes(app);
  registerSpMigrationPhase2Routes(app);

  registerSpSupplierVoucherLinkRepairRoutes(app);

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
  // Fail closed before the legacy offload handler can touch a prepaid row from
  // another company. This preserves tenant isolation for prepaid charge usage.
  registerSpOffloadPrepaidCompanyGuard(app);
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

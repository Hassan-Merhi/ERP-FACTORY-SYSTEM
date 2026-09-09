import type { Express } from "express";
import { createServer, type Server } from "http";

import { requireAuth } from "../auth";
import { db } from "../db";
import { broadcast } from "../wsServer";
import { classifyRealtimeWrite } from "../../shared/realtimeInvalidation";
import { registerAccountRoutes } from "./accounts";
import { registerAdminRoutes } from "./adminRoutes";
import { registerApprovalRoutes } from "./approvalRoutes";
import { registerAuthRoutes } from "./authRoutes";
import { registerBalanceRepairRoutes } from "./balance-repair";
import { registerBaleRoutes } from "./baleRoutes";
import { registerBarcodeImageBandwidthMiddleware } from "./barcodeImageBandwidthMiddleware";
import { registerBankAssetRoutes } from "./bankAssetRoutes";
import { registerBusinessAlertRoutes } from "./businessAlertsRoutes";
import { registerContainerRoutes } from "./containerRoutes";
import { registerCreditNoteRoutes } from "./creditNoteRoutes";
import { registerCustomerRoutes } from "./customerRoutes";
import { registerDebugRoutes } from "./debugRoutes";
import { registerEmployeeRoutes } from "./employeeRoutes";
import { registerErpRentalRoutes } from "./erpRentalRoutes";
import { registerFactoryAttendanceRoutes } from "./factoryAttendanceRoutes";
import { registerFactoryIntelligenceRoutes } from "./factory-intelligence";
import { registerFactoryPayrollRoutes } from "./factory-payroll";
import { registerFactoryRentalRoutes } from "./factoryRentalRoutes";
import { registerFactoryReportRoutes } from "./factory-reports";
import { registerFactoryRoutes } from "./factoryRoutes";
import { registerFactoryWorkerRoutes } from "./factory-workers";
import { registerFactoryWhatsappRoutes } from "./factoryWhatsappRoutes";
import { registerFiscalTransferRoutes } from "./fiscal-transfers";
import { registerGlobalTransactionRoutes } from "./globalTransactionRoutes";
import { registerGoldenCoastAccountingRoutes } from "./goldenCoastAccountingRoutes";
import { registerGoldenCoastLegacyPostingRetirement } from "./goldenCoastLegacyPostingRetirement";
import { registerImportCycleRoutes } from "./import-cycle";
import { registerImportRoutes } from "./import";
import { registerIntercompanyNotificationRoutes } from "./intercompanyNotificationRoutes";
import { registerInventoryRoutes } from "./inventoryRoutes";
import { registerLazyRouteModule } from "./lazyRouteRegistrar";
import { registerLedgerRoutes } from "./ledgerRoutes";
import { registerLocationRoutes } from "./locationRoutes";
import { registerNotificationRoutes } from "./notificationRoutes";
import { registerPasskeyRoutes } from "./passkeyRoutes";
import { registerPosRoutes } from "./posRoutes";
import { registerPropertiesRentalRoutes } from "./propertiesRentalRoutes";
import { registerRemoteControlSessionRoutes } from "./remoteControlSessionRoutes";
import { registerRemoteKeyboardControlRoutes } from "./remoteKeyboardControlRoutes";
import { registerRemoteSupportAuditRoutes } from "./remoteSupportAuditRoutes";
import { registerRemoteSupportRolloutRoutes } from "./remoteSupportRolloutRoutes";
import { phase4LazyRoutes } from "./renderPhase4LazyRoutes";
import { installRemoteSupportSessionStopAudit } from "../services/remoteSupportAuditService";
import { registerReportsRoutes } from "./reportsRoutes";
import { registerScreenFeedRoutes } from "./screenFeedRoutes";
import { registerScreenFeedTransportHardening } from "./screenFeedTransportHardening";
import { registerSpRoutes } from "./sp";
import { registerSpMigrationRoutes } from "./sp-migration";
import { registerStatsRoutes } from "./statsRoutes";
import { registerStockRoutes } from "./stockRoutes";
import { registerStockSummaryRoutes } from "./stockSummaryRoutes";
import { registerSupplierProformaRoutes } from "./supplierProformaRoutes";
import { registerSupplierRoutes } from "./supplierRoutes";
import { registerTransporterStatementRoutes } from "./transporterStatementRoutes";
import { registerUserNotesRoutes } from "./userNotesRoutes";
import { registerVoucherEntryRoutes } from "./voucher-entries";
import { registerVoucherRoutes } from "./voucherRoutes";
import { registerWhatsAppFastSendRoutes } from "./whatsappFastSendRoutes";
import { registerWhatsAppRoutes } from "./whatsappRoutes";
import { registerDispatchBatchRoutes } from "./factory/dispatch-batches";
import { registerFactoryInvoiceLoadingRoutes } from "./factory/invoice-loading";
import { registerFactoryInsuranceRoutes } from "./factory/factoryInsuranceRoutes";
import { registerInsuranceHistoricalRepairRoutes } from "./factory/insuranceHistoricalRepairRoutes";
import { registerAttributionHistoricalRepairRoutes } from "./factory/attributionHistoricalRepairRoutes";
import { registerFactorySheetsAndSacksRoutes } from "./factory/factorySheetsAndSacksRoutes";
import { registerFactorySheetsRoutes } from "./factory/factorySheetsRoutes";
import { registerFactoryStatusBuilderRoutes } from "./factory/factoryStatusBuilderRoutes";
import { registerFactoryStatusBuilderSheetsRoutes } from "./factory/factoryStatusBuilderSheetsRoutes";
import { registerFactoryStockAllocationV3Routes } from "./factory/factoryStockAllocationV3Routes";
import { registerFactoryTransporterRoutes } from "./factory/factoryTransporterRoutes";
import { registerProductionPlannerRoutes } from "./factory/factoryProductionPlannerRoutes";
import { registerEndProductionRoutes } from "./factory/endProductionRoutes";
import { registerLabelBannersRoutes } from "./factory/labelBannersRoutes";
import { registerErpWorkerDocumentRoutes } from "./employees/erpWorkerDocumentRoutes";
import { registerSalaryAdvanceRoutes } from "./employees/salaryAdvanceRoutes";
import { registerLegacyHealthRoutes } from "./core/healthRoutes";
import { registerPermissionBoundaryRoutes } from "./core/permissionBoundaryRoutes";
import { registerIntercompanyPosConfigRoutes } from "./pos/intercompanyPosConfigRoutes";
import { resolveActiveCompanyId } from "./helpers/resolveActiveCompanyId";
import { registerBandwidthPhase3FactoryReads } from "./performance/bandwidthPhase3FactoryReads";

function usesDedicatedRealtimeEvents(url: string): boolean {
  const path = url.split("?", 1)[0];
  return path === "/api/chat" || path.startsWith("/api/chat/");
}

function registerWriteInvalidationSignal(app: Express): void {
  app.use((req, res, next) => {
    const url = req.originalUrl || req.url;
    if (["POST", "PATCH", "PUT", "DELETE"].includes(req.method) && !usesDedicatedRealtimeEvents(url)) {
      const companyId = resolveActiveCompanyId(req);
      const invalidation = classifyRealtimeWrite(url, req.body);
      res.on("finish", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          broadcast({ type: "invalidate", ...invalidation }, { companyId });
        }
      });
    }
    next();
  });
}

export async function registerApplicationRoutes(app: Express): Promise<Server> {
  installRemoteSupportSessionStopAudit();
  registerWriteInvalidationSignal(app);
  registerPermissionBoundaryRoutes(app);
  registerWhatsAppFastSendRoutes(app);
  registerBandwidthPhase3FactoryReads(app);
  registerFactoryRoutes(app, requireAuth, db);
  registerFactoryWorkerRoutes(app, requireAuth, db);
  registerFactoryPayrollRoutes(app, requireAuth, db);
  registerFactoryReportRoutes(app, requireAuth, db);
  registerFactoryIntelligenceRoutes(app, requireAuth, db);
  registerFactoryAttendanceRoutes(app, requireAuth, db);
  registerSupplierProformaRoutes(app, requireAuth);
  await phase4LazyRoutes.supplierProfitCheck(app, requireAuth);
  registerGlobalTransactionRoutes(app, requireAuth);
  registerGoldenCoastLegacyPostingRetirement(app);
  registerGoldenCoastAccountingRoutes(app);
  registerPropertiesRentalRoutes(app);
  registerErpRentalRoutes(app);
  registerFactoryRentalRoutes(app);
  registerProductionPlannerRoutes(app);
  registerFactorySheetsRoutes(app);
  registerFactoryStockAllocationV3Routes(app);
  registerFactoryInvoiceLoadingRoutes(app);
  registerFactoryWhatsappRoutes(app, requireAuth);
  registerEndProductionRoutes(app, requireAuth);
  registerFactoryStatusBuilderRoutes(app);
  registerFactoryStatusBuilderSheetsRoutes(app);
  registerDispatchBatchRoutes(app);
  registerLabelBannersRoutes(app, requireAuth);
  registerFactoryTransporterRoutes(app);
  registerFactoryInsuranceRoutes(app);
  registerInsuranceHistoricalRepairRoutes(app);
  registerAttributionHistoricalRepairRoutes(app);
  registerFactorySheetsAndSacksRoutes(app);
  registerLegacyHealthRoutes(app);
  registerAuthRoutes(app);
  registerPasskeyRoutes(app);
  registerScreenFeedTransportHardening(app);
  registerScreenFeedRoutes(app);
  registerRemoteControlSessionRoutes(app);
  registerRemoteKeyboardControlRoutes(app);
  registerRemoteSupportAuditRoutes(app);
  registerRemoteSupportRolloutRoutes(app);
  registerLocationRoutes(app);
  registerInventoryRoutes(app);
  registerLedgerRoutes(app);
  registerEmployeeRoutes(app);
  registerSupplierRoutes(app);
  registerCustomerRoutes(app);
  registerIntercompanyPosConfigRoutes(app);
  registerErpWorkerDocumentRoutes(app);
  registerSalaryAdvanceRoutes(app);
  registerStockRoutes(app);
  registerBankAssetRoutes(app);
  registerContainerRoutes(app);
  registerImportRoutes(app);
  registerAccountRoutes(app);
  registerVoucherRoutes(app);
  registerVoucherEntryRoutes(app);
  registerFiscalTransferRoutes(app);
  registerPosRoutes(app);
  registerStatsRoutes(app);
  registerImportCycleRoutes(app);
  registerDebugRoutes(app);
  registerReportsRoutes(app);
  registerBarcodeImageBandwidthMiddleware(app);
  registerBaleRoutes(app);
  registerAdminRoutes(app);
  registerBalanceRepairRoutes(app);
  registerStockSummaryRoutes(app);
  await registerLazyRouteModule(app, {
    prefixes: ["/api/chatbot", "/api/users"],
    load: async () => (await import("./chatbot")).registerChatbotRoutes,
  });
  registerCreditNoteRoutes(app);
  await registerLazyRouteModule(app, {
    prefixes: ["/api/reports/net-profit-excel"],
    load: async () => (await import("./netProfitExcelRoute")).registerNetProfitExcelRoute,
  });
  await registerLazyRouteModule(app, {
    prefixes: ["/api/reports/net-position-monthly-excel"],
    load: async () => (await import("./netPositionMonthlyExcelRoute")).registerNetPositionMonthlyExcelRoute,
  });
  registerWhatsAppRoutes(app);
  await registerLazyRouteModule(app, {
    prefixes: ["/api/export"],
    load: async () => (await import("./exportRoutes")).registerExportRoutes,
  });
  await phase4LazyRoutes.git(app);
  await phase4LazyRoutes.containerTracking(app);
  registerUserNotesRoutes(app);
  registerSpRoutes(app);
  registerSpMigrationRoutes(app);
  await registerLazyRouteModule(app, {
    prefixes: ["/api/ai-import"],
    load: async () => (await import("./ai-import")).registerAiImportRoutes,
  });
  await registerLazyRouteModule(app, {
    prefixes: ["/api/ai-validation"],
    load: async () => (await import("./aiValidationRoutes")).registerAiValidationRoutes,
  });
  await registerLazyRouteModule(app, {
    prefixes: ["/api/ai-agent"],
    load: async () => (await import("./aiAgentRoutes")).registerAiAgentRoutes,
  });
  registerApprovalRoutes(app);
  registerBusinessAlertRoutes(app);
  registerIntercompanyNotificationRoutes(app);
  registerNotificationRoutes(app);
  registerTransporterStatementRoutes(app);

  return createServer(app);
}

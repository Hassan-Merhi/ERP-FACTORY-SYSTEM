/**
 * Unified accounting (Phases 3–15) report and metadata routes for ERP, Factory
 * and Properties. Registered as one group from applicationRoutes.ts; the
 * fail-closed rollout middleware (enforceUnifiedAccountingRollout) is mounted
 * there ahead of every route, and none of these replaces an existing posting
 * route.
 */
import type { Express } from "express";

import { registerAccountingOpenItemRoutes } from "./accountingOpenItemRoutes";
import { registerCashBankReconciliationRoutes } from "./cashBankReconciliationRoutes";
import { registerErpInventoryAccountingRoutes } from "./erpInventoryAccountingRoutes";
import { registerFactoryProductionAccountingRoutes } from "./factoryProductionAccountingRoutes";
import { registerFiscalReviewRoutes } from "./fiscalReviewRoutes";
import { registerGroupConsolidationRoutes } from "./groupConsolidationRoutes";
import { registerHistoricalAccountingRoutes } from "./historicalAccountingRoutes";
import { registerMonetaryFxRoutes } from "./monetaryFxRoutes";
import { registerProfessionalFinancialStatementRoutes } from "./professionalFinancialStatementRoutes";
import { registerUnifiedAccountingDashboardRoutes } from "./unifiedAccountingDashboardRoutes";
import { registerUnifiedAccountingRolloutRoutes } from "./unifiedAccountingRolloutRoutes";
import { registerUnifiedRentalAccountingRoutes } from "./unifiedRentalAccountingRoutes";

export function registerUnifiedAccountingRoutes(app: Express): void {
  registerAccountingOpenItemRoutes(app);
  registerCashBankReconciliationRoutes(app);
  registerMonetaryFxRoutes(app);
  registerErpInventoryAccountingRoutes(app);
  registerFactoryProductionAccountingRoutes(app);
  registerUnifiedRentalAccountingRoutes(app);
  registerGroupConsolidationRoutes(app);
  registerHistoricalAccountingRoutes(app);
  registerProfessionalFinancialStatementRoutes(app);
  registerFiscalReviewRoutes(app);
  registerUnifiedAccountingDashboardRoutes(app);
  registerUnifiedAccountingRolloutRoutes(app);
}

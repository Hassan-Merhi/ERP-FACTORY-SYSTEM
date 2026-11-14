/** Idempotent pre-listen schema safeguards, preserving exact startup order. */
import { pool } from "../db";
import { logger } from "../lib/logger";
import { getErrorMessage } from "../lib/httpHandlers";
import { readFactoryEdgeConfiguration, shouldStartEdgeBackgroundJobs } from "../edge/edgeRuntimePolicy.mjs";
import { ensureFinancialOperationRequests, ensureCanonicalStockMovementJournal } from "../startup-schema";
import { ensureRuntimeSchema } from "./ensureRuntimeSchema";
import { ensureEdgeVoucherOutboxSchema } from "../edge/edgeVoucherOutbox";
import { ensureCloudEdgeStageSchema } from "../edge/edgeCloudStaging";
import { readCloudSyncStageConfiguration } from "../edge/edgeSyncStageProtocol.mjs";
import { ensureClosedPeriodGuard } from "../services/accounting/closedPeriodGuard";
import { ensureOpeningBalanceLock } from "../services/accounting/openingBalanceLock";
import { ensureLedgerIntegrityGuard } from "../services/accounting/ledgerIntegrityGuard";
import { ensureCurrencyNormalizationGuard } from "../services/accounting/currencyNormalizationGuard";
import { ensureInventoryCutoverSchema } from "../services/accounting/perpetualInventory/cutover";
import { ensureInventoryFidelitySchema } from "../services/inventory/inventoryFidelitySchema";
import { ensureFactoryCostBasisSchema } from "../services/factory/factoryCostBasisSchema";
import { ensureVoucherBalanceGuard } from "../services/accounting/voucherBalanceGuard";
import { ensureAuditLogAppendOnlyGuard } from "../services/audit/auditLogAppendOnlyGuard";
import { ensureVoucherAuditTrigger } from "../services/audit/voucherAuditTrigger";
import { ensureFactoryRowHistory } from "../services/audit/factoryRowHistory";
import { ensureRequiredSystemAccountsForAllCompanies } from "../services/accounting/systemAccounts";
import { ensureSupplierTrackingShopDutyDefaults } from "./ensureSupplierTrackingShopDutyDefaults";
import { ensureZambiaHistoricalPurchaseCost } from "./ensureZambiaHistoricalPurchaseCost";
import { ensureRecurringJournalSchema } from "../services/accounting/ensureRecurringJournalSchema";
import { ensurePriorityScanSchema } from "./priorityScanSchema";
import { ensureContainerExtraExpectedLines } from "./ensureContainerExtraExpectedLines";
import { ensureFactoryLoadingDispatchSchema } from "./ensureFactoryLoadingDispatchSchema";
import { ensureDispatchLoadingBaleScanGuard } from "./ensureDispatchLoadingBaleScanGuard";
import { ensureStockTransferOrderWhatsAppApprovalSchema } from "./ensureStockTransferOrderWhatsAppApprovalSchema";
import { ensureFactoryInvoiceDocumentSnapshotStore } from "../services/factoryInvoiceDocumentService";
import { ensureFactorySheetsSacksSchema } from "./factorySheetsSacksSchema";
import { bootstrapRecurringJournalFromEnvironment } from "../services/accounting/recurringJournalBootstrap";
import { ensureFactoryStaffTrackingSchema } from "./factoryStaffTrackingSchema";
import { ensureFactoryTargetBonusPaymentSchema } from "./ensureFactoryTargetBonusPaymentSchema";
import { applyApprovedZakariaOpeningCredit } from "./applyApprovedZakariaOpeningCredit";
import { applyApprovedEmployeeOpeningCredits } from "./applyApprovedEmployeeOpeningCredits";
import { inspectHistoricalProductionBonusExpenseAccounts } from "../services/factory/productionBonusExpenseReclassification";
import { ensureFactoryContainerPlannerSchemaOnBoot } from "./factoryContainerPlannerSchema";
import { ensureFactoryBaleOrderIntegrity } from "./ensureFactoryBaleOrderIntegrity";

export async function runCoreStartupSchemaGuards(): Promise<void> {
  // Always-running schema repairs (exchange-rate index, multi-currency
  // columns, fiscal/factory tables) — see startup/ensureRuntimeSchema.ts.
  await ensureCanonicalStockMovementJournal(pool);
  await ensureRuntimeSchema(pool);
  await ensureEdgeVoucherOutboxSchema(pool);
  await ensureCloudEdgeStageSchema(pool, readCloudSyncStageConfiguration().enabled);
  // Needs fiscal_period_closures from ensureRuntimeSchema. Fatal on failure:
  // serving writes without the closed-period lock would let closed books change.
  await ensureClosedPeriodGuard(pool);
  // Opening balances locked once a fiscal period is closed (wave 12); fatal on failure.
  await ensureOpeningBalanceLock(pool);
  await ensureLedgerIntegrityGuard(pool);
  // Voucher-entry currency normalization (migrations/20260720_005, as production has it;
  // wave 14). Fatal on failure; skipped with a warning only if a column is missing.
  await ensureCurrencyNormalizationGuard(pool);
  await ensureInventoryCutoverSchema(pool);
  // Wave 11 columns read by full-row selects of sales and stock lines (fatal on failure);
  // the average_rate widening is retried on the next boot if it cannot get its lock.
  await ensureInventoryFidelitySchema(pool);
  // Wave 11 factory cost basis tables (POS sale bales, stock value events, re-cost runs); fatal on failure.
  await ensureFactoryCostBasisSchema(pool);
  // Needs gl_inventory_cutovers and the ledger guard's bypass function. Fatal on
  // failure (wave 12): serving writes without it would let unbalanced vouchers commit.
  await ensureVoucherBalanceGuard(pool);
  // audit_log append-only (wave 12 B); fatal on failure.
  await ensureAuditLogAppendOnlyGuard(pool);
  // Phase 21 (A): voucher/line audit trigger, actor columns, audit_log hash chain; fatal on failure.
  await ensureVoucherAuditTrigger(pool);
  // Factory row history and its baseline snapshot (historical Net Position);
  // a table it cannot lock is retried on the next boot, never fatal.
  await ensureFactoryRowHistory(pool);
  await ensureRequiredSystemAccountsForAllCompanies().catch((error: unknown) => {
    logger.error("[startup] ✗ System account provisioning failed", { error: getErrorMessage(error) });
  });
  await ensureFinancialOperationRequests(pool);
  await ensureSupplierTrackingShopDutyDefaults(pool);
  logger.info("[startup] ✓ Supplier Tracking Shop/Duty defaults ensured");
  // Zambia Phase 8: native Kwacha purchase evidence columns (startup stage 036
  // mirrored for production, which disables the bulk startup pass); fatal on failure.
  await ensureZambiaHistoricalPurchaseCost(pool);
  await ensureRecurringJournalSchema(pool);
  await ensurePriorityScanSchema(pool);
  logger.info("[startup] ✓ Priority Scan schema ensured");
  // Loading-only expected items must exist even when bulk migrations are disabled.
  await ensureContainerExtraExpectedLines(pool);
  await ensureFactoryLoadingDispatchSchema(pool);
  // Replace the overbroad Phase 4 guard before the new server accepts scans.
  // Fatal on failure: never report healthy while normal loading is blocked.
  await ensureDispatchLoadingBaleScanGuard(pool);
  logger.info("[startup] ✓ Factory loading dispatch schema and scan guard ensured");
  // Stock Transfer Orders require the verified, idempotent approval schema before service.
  await ensureStockTransferOrderWhatsAppApprovalSchema(pool);
  logger.info("[startup] ✓ Stock Transfer Order WhatsApp approval foundation ensured");
  await ensureFactoryInvoiceDocumentSnapshotStore(pool);
  logger.info("[startup] ✓ Factory invoice document snapshot store ensured");
  try {
    await ensureFactorySheetsSacksSchema(pool);
    logger.info("[startup] ✓ Sheets & Sacks schema ensured");
  } catch (err: unknown) {
    logger.error("[startup] Sheets & Sacks schema ensure failed", { error: String(err) });
  }
  if (shouldStartEdgeBackgroundJobs(readFactoryEdgeConfiguration())) {
    await bootstrapRecurringJournalFromEnvironment();
  }
  try {
    // Factory Production Targets and Attendance Register must be available
    // even when production skips the bulk startup migration pass.
    await ensureFactoryStaffTrackingSchema(pool);
    logger.info("[startup] ✓ Factory staff tracking schema ensured");
  } catch (staffTrackingSchemaErr: unknown) {
    logger.error("[startup] ✗ Could not ensure Factory staff tracking schema:", {
      error: getErrorMessage(staffTrackingSchemaErr),
    });
  }
  // Financial payout table must exist before any posting route becomes reachable.
  // Fatal on error: never serve a deployment with accounting schema missing.
  await ensureFactoryTargetBonusPaymentSchema(pool);
  // Owner-confirmed: HADI L'SHI Zakaria El Ali #103's $9,930.12
  // opening is Cr, not Dr. Scoped, audited and idempotent; never alters
  // salary/bonus postings or other employees.
  await applyApprovedZakariaOpeningCredit();
  // The historical payroll import used positive openings for employee
  // credits; several records still carry the default Dr side. Correct the
  // verified records once with before/after audit; never alter vouchers.
  try {
    await applyApprovedEmployeeOpeningCredits();
  } catch (openingRepairError: unknown) {
    logger.error("[startup] Historical employee openings were not fully corrected", {
      error: getErrorMessage(openingRepairError),
    });
    // Do not take the whole ERP offline for a historical correction.
    // Failed database transactions roll back; errors remain visible here.
  }
  // The one-time historical bonus reclassification has already been applied.
  // Never rerun a historical voucher mutation on every server startup.
  // A later legitimate voucher edit can change a paid amount while its old
  // claim still reflects the original value. Report that discrepancy for
  // audited reconciliation; do not change accounting or take ERP offline.
  if (process.env.RENDER_SERVICE_ID === "srv-d6kibgtactks739u7vl0") {
    try {
      const database = await pool.query<{ name: string }>("SELECT current_database() AS name");
      if (database.rows[0]?.name !== "erp_db_qscj_64lv_e7rz_8744_2lm3") {
        logger.warn("[startup] Historical bonus inspection skipped on unexpected database");
      } else {
        const inspection = await inspectHistoricalProductionBonusExpenseAccounts();
        if (inspection.inspected !== 9 || inspection.discrepancies.length > 0) {
          logger.warn("[startup] Historical production bonus claims require manual reconciliation", inspection);
        } else {
          logger.info("[startup] Historical production bonus expense accounts reconciled", inspection);
        }
      }
    } catch (inspectionError: unknown) {
      logger.warn(
        "[startup] Historical production bonus inspection unavailable; serving without changing posted vouchers",
        {
          error: getErrorMessage(inspectionError),
        }
      );
    }
  }
  // The Container Planner's registered migrations are never applied by
  // production's boot path, so ensure its tables here unconditionally. A
  // failure after retries is fatal: the previous deployment stays live rather
  // than a new one reporting healthy with the planner broken.
  await ensureFactoryContainerPlannerSchemaOnBoot(pool);
  logger.info("[startup] ✓ Factory container planner schema ensured");
  // Before accepting requests, repair old completed-order bales and install
  // the DB guard even when bulk migrations are disabled.
  await ensureFactoryBaleOrderIntegrity(pool);
}

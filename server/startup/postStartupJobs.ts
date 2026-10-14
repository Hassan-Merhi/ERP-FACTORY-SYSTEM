/**
 * Post-startup background jobs, run once the port is open.
 */
import { pool } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { checkAndRecoverDailyExport } from "../services/scheduler";

let installed = false;
let hungCleanupInFlight = false;

function unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  (timer as unknown as { unref?: () => void }).unref?.();
}

export function runPostStartupJobs(): void {
  if (installed) return;
  installed = true;

  // One-time, explicitly gated historical GL backfill for the audited 63 invoices.
  // This is OFF by default and uses the centralized posting engine with
  // per-invoice transaction rollback if the customer combined balance shifts.
  if (process.env.ERP_RECONCILE_INVOICES_20261014 === "company-12-approved-63") {
    const accountingReconciliationTimer = setTimeout(async () => {
      try {
        const { reconcileFactoryInvoices20261014 } = await import("../../scripts/reconcile-factory-invoices-20261014");
        await reconcileFactoryInvoices20261014(true);
        logger.info("[AccountingRepair] Historical invoice reconciliation finished");
      } catch (error: unknown) {
        logger.error("[AccountingRepair] Invoice reconciliation stopped", { error: getErrorMessage(error) });
      }
    }, 12000);
    unrefTimer(accountingReconciliationTimer);
  }

  if (process.env.ERP_RECONCILE_SUPPLIERS_20261014 === "company-12-approved-87") {
    const supplierTimer = setTimeout(async () => {
      try {
        const { reconcileFactorySuppliers20261014 } =
          await import("../../scripts/reconcile-factory-suppliers-20261014");
        await reconcileFactorySuppliers20261014(true);
        logger.info("[SupplierRepair] Historical factory supplier journals completed");
      } catch (error: unknown) {
        logger.error("[SupplierRepair] Historical supplier reconciliation halted", { error: getErrorMessage(error) });
      }
    }, 12000);
    unrefTimer(supplierTimer);
  }

  // Single-use accounting repair approved for company 12: EUR=1.18,
  // AUD=0.75 (USD per native unit). Guarded by an exact environment switch,
  // source-count snapshot, plan hash, company scope, and transactional audit.
  if (process.env.ERP_RECONCILE_FACTORY_HISTORICAL_FX_20261014 === "company-12-eur-118-aud-075") {
    const fixedFxRepairTimer = setTimeout(async () => {
      try {
        const { reconcileFixedFactoryHistoricalFx20261014 } =
          await import("../../scripts/reconcile-fixed-factory-historical-fx-20261014");
        const result = await reconcileFixedFactoryHistoricalFx20261014();
        logger.info("[FactoryFxRepair] Fixed EUR/AUD historical reconciliation finished", result);
      } catch (error: unknown) {
        logger.error("[FactoryFxRepair] Fixed EUR/AUD reconciliation stopped without completing", {
          error: getErrorMessage(error),
        });
      }
    }, 18000);
    unrefTimer(fixedFxRepairTimer);
  }

  // Explicitly enabled once: repair only the source references of two legacy
  // supplier-payment daybook rows. No vouchers, payments, or balances change.
  if (process.env.ERP_REPAIR_SUPPLIER_PAYMENTS_20261014 === "company-12-confirmed-links") {
    const paymentLinkTimer = setTimeout(async () => {
      try {
        const { repairSupplierPaymentDaybookLinks20261014 } =
          await import("../../scripts/repair-supplier-payment-daybook-links-20261014");
        const changed = await repairSupplierPaymentDaybookLinks20261014();
        logger.info("[SupplierPaymentLinks] Historical daybook references reconciled", { count: changed });
      } catch (error: unknown) {
        logger.error("[SupplierPaymentLinks] Daybook link repair refused", {
          error: getErrorMessage(error),
        });
      }
    }, 12000);
    unrefTimer(paymentLinkTimer);
  }

  // One-time, audited 56-record FX settlement reconciliation for company 12.
  // Disabled by default. Each voucher posts in its own guarded transaction.
  const supplierFxReconciliationMode = process.env.ERP_RECONCILE_SUPPLIER_FX_20261014;
  if (
    supplierFxReconciliationMode === "company-12-audited-56" ||
    supplierFxReconciliationMode === "company-12-dry-run"
  ) {
    const supplierFxTimer = setTimeout(async () => {
      try {
        const fxRepair = await import("../../scripts/reconcile-factory-supplier-fx-20261014");
        await fxRepair.reconcileFactorySupplierFx20261014(supplierFxReconciliationMode === "company-12-audited-56");
        logger.info("[SupplierFxRepair] Historical supplier FX reconciliation finished");
      } catch (error: unknown) {
        logger.error("[SupplierFxRepair] Historical supplier FX reconciliation halted", {
          error: getErrorMessage(error),
        });
      }
    }, 12000);
    unrefTimer(supplierFxTimer);
  }

  // Company 12 FX source-reference reconciliation; does not modify vouchers.
  const fxDaybookRepairMode = process.env.ERP_RECONCILE_FX_DAYBOOK_20261014;
  if (fxDaybookRepairMode === "company-12-preview" || fxDaybookRepairMode === "company-12-apply") {
    const fxDaybookTimer = setTimeout(async () => {
      try {
        const repair = await import("../../scripts/reconcile-factory-fx-daybook-20261014");
        await repair.reconcileSupplierFxDaybook20261014(fxDaybookRepairMode === "company-12-apply");
        logger.info("[SupplierFxDaybook] Company 12 reconciliation finished");
      } catch (error: unknown) {
        logger.error("[SupplierFxDaybook] Company 12 reconciliation halted", {
          error: getErrorMessage(error),
        });
      }
    }, 12000);
    unrefTimer(fxDaybookTimer);
  }

  // Company 12 historical post-offload charge voucher/daybook LINKS ONLY.
  // No voucher posting or inventory cost rewrite. Disabled normally.
  const chargeLinkRepairMode = process.env.ERP_REPAIR_POST_OFFLOAD_LINKS_20261014;
  if (chargeLinkRepairMode === "company-12-preview" || chargeLinkRepairMode === "company-12-apply") {
    const linkRepairTimer = setTimeout(async () => {
      try {
        const repair = await import("../../scripts/repair-post-offload-charge-links-20261014");
        await repair.reconcileContainerChargeLinks20261014(chargeLinkRepairMode === "company-12-apply");
        logger.info("[ContainerChargeLinks] Historical accounting-link repair completed");
      } catch (error: unknown) {
        logger.error("[ContainerChargeLinks] Historical accounting-link repair refused", {
          error: getErrorMessage(error),
        });
      }
    }, 12000);
    unrefTimer(linkRepairTimer);
  }

  // Audited company 12 historical freight corrections, dated 14 Oct 2026.
  // Explicit preview/apply switch. Keeps original vouchers intact.
  const freightReviewMode = process.env.ERP_RECONCILE_FREIGHT_HISTORY_20261014;
  if (freightReviewMode === "company-12-preview" || freightReviewMode === "company-12-apply") {
    const freightReviewTimer = setTimeout(async () => {
      try {
        const review = await import("../../scripts/reconcile-factory-freight-20261014");
        await review.reconcileFactoryFreight20261014(freightReviewMode === "company-12-apply");
        logger.info("[FactoryFreightCorrection] Historical freight review completed");
      } catch (error: unknown) {
        logger.error("[FactoryFreightCorrection] Historical freight review stopped", {
          error: getErrorMessage(error),
        });
      }
    }, 12000);
    unrefTimer(freightReviewTimer);
  }

  // Company 12: recover 36 verified historical freight suppliers from
  // existing balanced vouchers; no money or inventory mutation.
  const payeeLinkMode = process.env.ERP_REPAIR_FREIGHT_PAYEES_20261014;
  if (payeeLinkMode === "company-12-preview" || payeeLinkMode === "company-12-apply") {
    const payeeLinkTimer = setTimeout(async () => {
      try {
        const repair = await import("../../scripts/reconcile-legacy-freight-payee-links-20261014");
        await repair.reconcileLegacyFreightPayeeLinks20261014(payeeLinkMode === "company-12-apply");
        logger.info("[LegacyFreightPayees] Audited freight supplier metadata repair completed");
      } catch (error: unknown) {
        logger.error("[LegacyFreightPayees] Audited freight supplier metadata repair refused", {
          error: getErrorMessage(error),
        });
      }
    }, 12000);
    unrefTimer(payeeLinkTimer);
  }

  // Live vessel/AIS tracking is intentionally disabled. Container movement is
  // maintained manually or through Excel imports.

  // Defense in depth: clear legacy enable flags on both container systems at
  // every startup. No provider calls are made; manual/Excel fields are untouched.
  void (async () => {
    try {
      const [erp, factory] = await Promise.all([
        pool.query(
          `UPDATE containers
             SET tracking_enabled = false, tracking_auto_update = false
           WHERE tracking_enabled = true OR tracking_auto_update = true`
        ),
        pool.query(
          `UPDATE factory_containers
             SET tracking_enabled = false, tracking_auto_update = false
           WHERE tracking_enabled = true OR tracking_auto_update = true`
        ),
      ]);
      const disabled = (erp.rowCount ?? 0) + (factory.rowCount ?? 0);
      if (disabled > 0) {
        logger.info(`[ContainerTracking] Disabled automated tracking on ${disabled} legacy container row(s)`);
      }
    } catch (e: unknown) {
      logger.warn("[ContainerTracking] Could not enforce disabled tracking flags:", { error: getErrorMessage(e) });
    }
  })();

  const migrationDiagTimer = setTimeout(async () => {
    try {
      const [posRows, posWithStation, normalUserRows, oldRoleRows, canDeleteCol] = await Promise.all([
        pool.query(`SELECT COUNT(*) AS n FROM user_company_roles WHERE role = 'POS'`),
        pool.query(`SELECT COUNT(*) AS n FROM user_company_roles WHERE role = 'POS' AND pos_station IS NOT NULL`),
        pool.query(`SELECT COUNT(*) AS n FROM user_company_roles WHERE role = 'Normal User'`),
        pool.query(
          `SELECT COUNT(*) AS n FROM user_company_roles WHERE role IN ('POS1','POS2','POS3','POS4','POS5','POS6','User')`
        ),
        pool.query(
          `SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_name = 'user_company_roles' AND column_name = 'can_delete_records'`
        ),
      ]);
      const posCount = parseInt(posRows.rows[0]?.n ?? "0", 10);
      const posWithStn = parseInt(posWithStation.rows[0]?.n ?? "0", 10);
      const normalCount = parseInt(normalUserRows.rows[0]?.n ?? "0", 10);
      const oldRoleCount = parseInt(oldRoleRows.rows[0]?.n ?? "0", 10);
      const canDeleteOk = parseInt(canDeleteCol.rows[0]?.n ?? "0", 10) > 0;
      logger.info(
        `[MigrationDiag] POS roles: ${posCount} (${posWithStn} with pos_station set) | Normal User roles: ${normalCount} | Old roles remaining: ${oldRoleCount} | can_delete_records column: ${canDeleteOk ? "✓ present" : "✗ MISSING"}`
      );
      if (oldRoleCount > 0)
        logger.warn(
          `[MigrationDiag] ⚠️  ${oldRoleCount} row(s) still have old roles (POS1–POS6 or User) — check /api/admin/deployment-diagnostics`
        );
    } catch (e: unknown) {
      logger.warn("[MigrationDiag] Could not run startup diagnostic:", { error: getErrorMessage(e) });
    }
  }, 30000);
  unrefTimer(migrationDiagTimer);

  void (async () => {
    try {
      const r = await pool.query(`
      UPDATE factory_bales
         SET status = 'DELETED', updated_at = NOW()
       WHERE deleted_at IS NOT NULL
         AND status != 'DELETED'
      RETURNING id, reference_number
    `);
      if (r.rowCount && r.rowCount > 0) {
        logger.info(`[BaleStatusFix] Fixed ${r.rowCount} bale(s) with deletedAt set but status != DELETED`, {
          detail: r.rows.map((x) => x.reference_number).join(", "),
        });
      }
    } catch (e: unknown) {
      logger.warn("[BaleStatusFix] Could not fix inconsistent bale statuses:", { error: getErrorMessage(e) });
    }
  })();

  const cleanupOrphanedRuns = async () => {
    try {
      const r = await pool.query(`
      UPDATE daily_export_runs
         SET status         = 'failed',
             finished_at    = NOW(),
             skipped_reason = 'Server restarted or timed out while export was in progress'
       WHERE status         = 'running'
         AND started_at     < NOW() - INTERVAL '5 minutes'
      RETURNING id, run_type
    `);
      if (r.rowCount && r.rowCount > 0) {
        logger.info(`[ExportRun] Startup: marked ${r.rowCount} orphaned run(s) as failed`, {
          detail: r.rows.map((x) => `#${x.id} ${x.run_type}`).join(", "),
        });
      }
    } catch (e: unknown) {
      logger.warn("[ExportRun] Startup orphan-cleanup failed:", { error: getErrorMessage(e) });
    }
  };

  const cleanupHungRuns = async () => {
    if (hungCleanupInFlight) {
      logger.warn("[ExportRun] Periodic hung-run cleanup skipped because the previous sweep is still running.");
      return;
    }
    hungCleanupInFlight = true;
    try {
      const r = await pool.query(`
      UPDATE daily_export_runs
         SET status         = 'failed',
             finished_at    = NOW(),
             skipped_reason = 'Export timed out — exceeded 3-hour safety limit'
       WHERE status         = 'running'
         AND started_at     < NOW() - INTERVAL '3 hours'
      RETURNING id, run_type
    `);
      if (r.rowCount && r.rowCount > 0) {
        logger.info(`[ExportRun] Periodic: timed out ${r.rowCount} hung run(s)`, {
          detail: r.rows.map((x) => `#${x.id} ${x.run_type}`).join(", "),
        });
      }
    } catch (e: unknown) {
      logger.warn("[ExportRun] Periodic hung-run cleanup failed:", { error: getErrorMessage(e) });
    } finally {
      hungCleanupInFlight = false;
    }
  };

  const orphanCleanupTimer = setTimeout(() => void cleanupOrphanedRuns(), 3000);
  const hungCleanupTimer = setInterval(() => void cleanupHungRuns(), 30 * 60 * 1000);
  unrefTimer(orphanCleanupTimer);
  unrefTimer(hungCleanupTimer);

  const exportRecoveryTimer = setTimeout(async () => {
    try {
      await checkAndRecoverDailyExport();
    } catch (e: unknown) {
      logger.warn("[DailyExport] Startup recovery call failed:", { error: getErrorMessage(e) });
    }
  }, 90 * 1000);
  unrefTimer(exportRecoveryTimer);
}

import cron from "node-cron";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { pool } from "../../db";
import { createSchedulerTick } from "./schedulerTickGuard";

// Guards startScheduler against a double start.
let schedulerStarted = false;

async function checkAndRunScheduledDailyExport(): Promise<void> {
  try {
    const { hasTodayExportSucceeded, isTodayExportRunning } = await import("./daily-export-state");
    const r = await pool.query(
      `SELECT schedule_enabled, schedule_hour, schedule_timezone FROM export_settings WHERE id = 1`
    );
    if (!r.rows.length) return;
    const row = r.rows[0];

    if (!row.schedule_enabled) return;

    const configuredHour: number = row.schedule_hour ?? 18;
    const tz: string = row.schedule_timezone || "America/New_York";

    const nowInTz = new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
    const currentHour = nowInTz.getHours();

    if (currentHour !== configuredHour) return;

    if (await hasTodayExportSucceeded()) {
      logger.info("[DailyExport] Hourly check: today's export already succeeded — skipping.");
      return;
    }
    if (await isTodayExportRunning()) {
      logger.info("[DailyExport] Hourly check: export is currently running — skipping.");
      return;
    }

    logger.info(`[DailyExport] Scheduled check: time matches (${configuredHour}:00 ${tz}) — starting export attempt.`);
    const { runDailyExport } = await import("./daily-export");
    const ok = await runDailyExport();
    if (!ok) {
      logger.warn("[DailyExport] Attempt failed; the next 15-minute scheduler tick will retry within this hour.");
    }
  } catch (err: unknown) {
    logger.error("[DailyExport] checkAndRunScheduledDailyExport error:", { error: getErrorMessage(err) || err });
  }
}

/**
 * Daily rental catch-up for every active contract across all modules/companies.
 * Contracts can bill on any day of the month, so a once-a-month cron cannot
 * reliably recognise prepaid rent on the correct billing date. This job is
 * idempotent: already-recognised/accrued rows are skipped.
 */
async function runDailyRentalAccrual() {
  logger.info("[RentalAccrual] Daily billing-date catch-up started.");
  try {
    const [{ ensureMonthlyForCompany, postRentAccrualForCompany }, { getUtcTodayString }, repairModule] =
      await Promise.all([
        import("../../routes/rental/shared"),
        import("../rental/rentalPeriodService"),
        import("../rental/legacyPrepaidRecognitionRepair"),
      ]);
    const { repairLegacyFullyPrepaidRentRecognition } = repairModule;
    const asOfDate = getUtcTodayString();
    const { rows } = await pool.query<{ id: number }>("SELECT id FROM companies");
    const modules: Array<{ module: string; income: string; expense: string }> = [
      { module: "ERP", income: "Rental Income - ERP", expense: "Rent Expense - ERP Shops" },
      { module: "FACTORY", income: "Rental Income - Factory", expense: "Rent Expense - Factory Shops" },
      { module: "PROPERTIES", income: "Rental Income - Properties", expense: "Rent Expense - Property Shops" },
    ];

    let totalRepaired = 0;
    let totalAccrued = 0;
    for (const { id: companyId } of rows) {
      for (const { module, income, expense } of modules) {
        try {
          await ensureMonthlyForCompany(
            companyId,
            module as unknown as Parameters<typeof ensureMonthlyForCompany>[1],
            asOfDate
          );

          if (module === "ERP" || module === "FACTORY") {
            const { repaired } = await repairLegacyFullyPrepaidRentRecognition(companyId, module, expense, asOfDate);
            totalRepaired += repaired;
          }

          const { accrued } = await postRentAccrualForCompany(companyId, expense, module, income, asOfDate);
          totalAccrued += accrued;
        } catch (err: unknown) {
          logger.error(`[RentalAccrual] company=${companyId} module=${module}: ${getErrorMessage(err)}`);
        }
      }
    }
    logger.info(
      `[RentalAccrual] Daily billing-date catch-up complete — ${totalRepaired} legacy row(s) repaired, ${totalAccrued} row(s) accrued/recognised.`
    );
  } catch (err: unknown) {
    logger.error("[RentalAccrual] Fatal error:", { error: getErrorMessage(err) });
  }
}

export function startScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;

  // Run on the 1st of every month at 7:00 AM EST — send net-position Excel via WhatsApp
  cron.schedule(
    "0 7 1 * *",
    createSchedulerTick("monthlyNetPosition", async () => {
      const { runMonthlyWhatsAppNetPosition } = await import("./net-position");
      await runMonthlyWhatsAppNetPosition();
    }),
    {
      timezone: "America/New_York",
    }
  );

  // Run every day at 6:00 AM ET. Rental contracts can bill on the 1st, 20th,
  // or any other day, so daily catch-up is required for correct monthly expense
  // recognition. The posting functions are idempotent and skip completed rows.
  cron.schedule("0 6 * * *", createSchedulerTick("dailyRentalAccrual", runDailyRentalAccrual), {
    timezone: "America/New_York",
  });

  // The configurable daily export gets four independent chances during its
  // configured hour (at :00, :15, :30, :45). Keeping retries on scheduler ticks
  // avoids sleeping inside the hourly composite job and blocking the next hour.
  cron.schedule(
    "*/15 * * * *",
    createSchedulerTick("scheduledDailyExport", checkAndRunScheduledDailyExport, { quiet: true }),
    {
      timezone: "America/New_York",
    }
  );

  // Every hour: check stock report, net position export, and container WhatsApp.
  // Individual modules are loaded only when this tick executes instead of at process startup.
  cron.schedule(
    "0 * * * *",
    createSchedulerTick("hourlyChecks", async () => {
      const stockReport = await import("./stock-report");
      await stockReport.checkAndRunStockReport();
      await stockReport.checkAndRunNetPositionExport();
      const { checkAndRunContainersWhatsApp } = await import("./maintenance");
      await checkAndRunContainersWhatsApp();
    }),
    {
      timezone: "America/New_York",
    }
  );

  // Wave I: every day at 3:30 AM ET, reconcile accounting/inventory evidence
  // for every company. The runner is read-only and reports mismatches; it never
  // mutates or auto-repairs accounting or inventory data. Each company is read
  // from one repeatable-read snapshot so live posting cannot create false drift.
  cron.schedule(
    "30 3 * * *",
    createSchedulerTick("convergenceReconciliation", async () => {
      const { runScheduledConvergenceReconciliation } =
        await import("../accounting/scheduledConvergenceReconciliation");
      await runScheduledConvergenceReconciliation();
    }),
    {
      timezone: "America/New_York",
    }
  );

  // Overdue customer payment reminder — runs every day at 9:00 AM EST
  cron.schedule(
    "0 9 * * *",
    createSchedulerTick("overdueCheck", async () => {
      const { checkOverdueCustomers } = await import("./net-position");
      await checkOverdueCustomers();
    }),
    {
      timezone: "America/New_York",
    }
  );

  // Purge soft-deleted items older than 30 days — runs daily at 2:00 AM EST
  cron.schedule(
    "0 2 * * *",
    createSchedulerTick("softDeletePurge", async () => {
      const { purgeOldSoftDeletes } = await import("./maintenance");
      await purgeOldSoftDeletes();
    }),
    {
      timezone: "America/New_York",
    }
  );

  // Container auto-tracking — runs every 6 hours (00:00, 06:00, 12:00, 18:00 EST)
  cron.schedule(
    "0 */6 * * *",
    createSchedulerTick("containerTracking", async () => {
      // ERP and factory tracking are reported separately on purpose: one
      // failing is not a reason to skip the other.
      try {
        const { trackDueContainers } = await import("../container-tracking");
        await trackDueContainers();
      } catch (err: unknown) {
        logger.error("cron containerTracking (ERP) failed", {
          module: "scheduler",
          action: "containerTracking",
          error: err,
        });
      }
      const { trackDueFactoryContainers } = await import("../factory-container-tracking");
      await trackDueFactoryContainers();
    }),
    {
      timezone: "America/New_York",
    }
  );

  logger.info("All scheduled jobs registered", {
    module: "scheduler",
    action: "start",
    jobs: [
      "monthlyNetPositionWhatsApp(1st 07:00 EST)",
      "dailyRentalAccrual(daily 06:00 ET)",
      "scheduledDailyExport(every 15m; active only in configured hour)",
      "hourlyChecks(stock/net-position/containers)",
      "convergenceReconciliation(daily 03:30 ET)",
      "overdueCustomers(daily 09:00 EST)",
      "softDeletePurge(daily 02:00 EST)",
      "containerTracking(every 6h EST)",
    ],
  });
}

/**
 * Permanently delete all soft-deleted records older than 30 days.
 * Handles FK dependencies in the correct order.
 */

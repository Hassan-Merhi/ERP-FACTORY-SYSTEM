import cron from "node-cron";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { pool } from "../../db";
import { createSchedulerTick } from "./schedulerTickGuard";
import {
  scheduledReportIsDue,
  shouldLoadStockReportModule,
  shouldLoadContainersWhatsAppModule,
  checkAndRunScheduledDailyExport,
} from "./scheduled-jobs-helpers";

// Guards startScheduler against a double start.
let schedulerStarted = false;

const SCHEDULER_IMPORT_TIMEOUT_MS = 20_000;

async function shouldLoadNetPositionExportModule(): Promise<boolean> {
  const { rows } = await pool.query<{
    enabled: boolean | null;
    auto_send: boolean | null;
    frequency: string | null;
    send_hour: number | null;
    send_day_of_week: number | null;
    last_sent_at: Date | string | null;
  }>(
    `SELECT enabled, auto_send, frequency, send_hour, send_day_of_week, last_sent_at
       FROM net_position_export_settings
      WHERE id = 1`
  );
  const row = rows[0];
  return Boolean(row && scheduledReportIsDue(row));
}

async function importWithSchedulerDeadline<T>(label: string, operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} import timed out after ${SCHEDULER_IMPORT_TIMEOUT_MS}ms`)),
      SCHEDULER_IMPORT_TIMEOUT_MS
    );
    timer.unref();
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Daily rental catch-up for every active contract across all modules/companies.
 * Contracts can bill on any day of the month, so a once-a-month cron cannot
 * reliably recognise prepaid rent on the correct billing date. This job is
 * idempotent: already-recognised/accrued rows are skipped.
 *
 * Wave 18 A: the companies are listed from the scheduler's maintenance scope,
 * but each company posts in its own tenant scope (closed-period guard and
 * opening lock apply), dated by its business date, through the same code path
 * as the Admin/Owner "post due accruals now" action: due scheduled payments,
 * then accruals. A posting in a closed period is skipped and reported here.
 * The legacy prepaid recognition no longer runs here (an Owner tool now).
 */
export async function runDailyRentalAccrual(): Promise<{
  accrued: number;
  scheduledPaymentsPosted: number;
  skipped: number;
  failed: number;
}> {
  logger.info("[RentalAccrual] Daily billing-date catch-up started.");
  const totals = { accrued: 0, scheduledPaymentsPosted: 0, skipped: 0, failed: 0 };
  try {
    const { postDueRentalForCompany } = await import("../rental/dueRentalPosting");
    const { rows } = await pool.query<{ id: number }>("SELECT id FROM companies ORDER BY id");
    const modules = ["ERP", "FACTORY", "PROPERTIES"] as const;

    for (const { id: companyId } of rows) {
      for (const module of modules) {
        try {
          const result = await postDueRentalForCompany(companyId, module, { trigger: "scheduler" });
          totals.accrued += result.accrued;
          totals.scheduledPaymentsPosted += result.scheduledPaymentsPosted;
          totals.failed += result.scheduledPaymentsFailed;
          totals.skipped += result.skipped.length;
        } catch (err: unknown) {
          totals.failed += 1;
          logger.error(`[RentalAccrual] company=${companyId} module=${module}: ${getErrorMessage(err)}`);
        }
      }
    }
    logger.info(
      `[RentalAccrual] Daily billing-date catch-up complete — ${totals.scheduledPaymentsPosted} scheduled payment group(s) posted, ${totals.accrued} row(s) accrued/recognised, ${totals.skipped} posting(s) skipped (closed period), ${totals.failed} failure(s).`
    );
  } catch (err: unknown) {
    logger.error("[RentalAccrual] Fatal error:", { error: getErrorMessage(err) });
  }
  return totals;
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

  // Recurring journal catch-up. Run hourly so month-end posting follows each
  // template's own timezone and a deploy/restart cannot permanently miss the
  // boundary. The posting key is deterministic per recurrence + scheduled date,
  // so retries or overlapping instances cannot create a duplicate voucher.
  cron.schedule(
    "20 * * * *",
    createSchedulerTick("recurringJournals", async () => {
      const { runDueRecurringJournals } = await import("../accounting/recurringJournalService");
      await runDueRecurringJournals();
    }),
    { timezone: "UTC" }
  );

  // Run every day at 6:00 AM ET. Rental contracts can bill on the 1st, 20th,
  // or any other day, so daily catch-up is required for correct monthly expense
  // recognition. The posting functions are idempotent and skip completed rows.
  cron.schedule(
    "0 6 * * *",
    createSchedulerTick("dailyRentalAccrual", async () => {
      await runDailyRentalAccrual();
    }),
    {
      timezone: "America/New_York",
    }
  );

  // Keep the hourly maintenance checks isolated. A slow WhatsApp upload/export
  // must never hold one shared in-process lock and suppress every other hourly
  // responsibility for the lifetime of the process. Staggering the jobs also
  // avoids four cold database/report workloads hitting the pool at once.
  cron.schedule(
    "0 * * * *",
    createSchedulerTick("hourlyStockReport", async () => {
      if (!(await shouldLoadStockReportModule())) return;
      const { checkAndRunStockReport } = await importWithSchedulerDeadline(
        "hourlyStockReport",
        import("./stock-report")
      );
      await checkAndRunStockReport();
    }),
    { timezone: "America/New_York" }
  );

  cron.schedule(
    "5 * * * *",
    createSchedulerTick("hourlyNetPositionExport", async () => {
      if (!(await shouldLoadNetPositionExportModule())) return;
      const { checkAndRunNetPositionExport } = await importWithSchedulerDeadline(
        "hourlyNetPositionExport",
        import("./stock-report")
      );
      await checkAndRunNetPositionExport();
    }),
    { timezone: "America/New_York" }
  );

  // Give the configured daily export four independent attempts inside its
  // configured hour without sleeping under one scheduler lock. Offset from
  // the other hourly jobs to avoid stacking report workloads on the same minute.
  cron.schedule(
    "10,25,40,55 * * * *",
    createSchedulerTick("scheduledDailyExport", checkAndRunScheduledDailyExport, { quiet: true }),
    { timezone: "America/New_York" }
  );

  cron.schedule(
    "15 * * * *",
    createSchedulerTick("hourlyContainersWhatsApp", async () => {
      if (!(await shouldLoadContainersWhatsAppModule())) return;
      const { checkAndRunContainersWhatsApp } = await importWithSchedulerDeadline(
        "hourlyContainersWhatsApp",
        import("./maintenance")
      );
      await checkAndRunContainersWhatsApp();
    }),
    { timezone: "America/New_York" }
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

  // Container carrier auto-tracking is intentionally disabled system-wide.
  // Container status/ETA/location are maintained manually or through Excel imports.
  logger.info("Container carrier auto-tracking is disabled by product policy", {
    module: "scheduler",
    action: "containerTracking",
  });

  logger.info("All scheduled jobs registered", {
    module: "scheduler",
    action: "start",
    jobs: [
      "monthlyNetPositionWhatsApp(1st 07:00 EST)",
      "dailyRentalAccrual(daily 06:00 ET)",
      "recurringJournals(hourly :20 UTC; per-template timezone)",
      "hourlyStockReport(hourly :00 ET)",
      "hourlyNetPositionExport(hourly :05 ET)",
      "scheduledDailyExport(:10/:25/:40/:55 ET; active only in configured hour)",
      "hourlyContainersWhatsApp(hourly :15 ET)",
      "convergenceReconciliation(daily 03:30 ET)",
      "overdueCustomers(daily 09:00 EST)",
      "softDeletePurge(daily 02:00 EST)",
    ],
  });
}

/**
 * Permanently delete all soft-deleted records older than 30 days.
 * Handles FK dependencies in the correct order.
 */

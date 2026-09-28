import cron from "node-cron";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { pool } from "../../db";
import { createSchedulerTick } from "./schedulerTickGuard";

// Guards startScheduler against a double start.
let schedulerStarted = false;

const SCHEDULER_IMPORT_TIMEOUT_MS = 20_000;

function nowInNewYork(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
}

function sameIsoWeek(left: Date, right: Date): boolean {
  const monday = (value: Date) => {
    const copy = new Date(value);
    const day = copy.getDay();
    const diff = (day === 0 ? -6 : 1) - day;
    copy.setDate(copy.getDate() + diff);
    copy.setHours(0, 0, 0, 0);
    return copy;
  };
  return monday(left).getTime() === monday(right).getTime();
}

function scheduledReportIsDue(row: {
  enabled: boolean | null;
  auto_send: boolean | null;
  frequency: string | null;
  send_hour: number | null;
  send_day_of_week: number | null;
  last_sent_at: Date | string | null;
}): boolean {
  if (!row.enabled || !row.auto_send) return false;

  const now = nowInNewYork();
  const sendHour = row.send_hour ?? 18;
  if (now.getHours() !== sendHour) return false;

  const frequency = row.frequency ?? "daily";
  if (row.last_sent_at) {
    const last = new Date(
      new Date(row.last_sent_at).toLocaleString("en-US", { timeZone: "America/New_York" })
    );
    if (frequency === "daily" && last.toDateString() === now.toDateString()) return false;
    if (frequency === "weekly" && sameIsoWeek(last, now)) return false;
    if (
      frequency === "monthly" &&
      last.getFullYear() === now.getFullYear() &&
      last.getMonth() === now.getMonth()
    ) {
      return false;
    }
  }

  if (frequency === "daily") return true;
  if (frequency === "weekly") return now.getDay() === (row.send_day_of_week ?? 1);
  if (frequency === "monthly") return now.getDate() === 1;
  return false;
}

async function hasRetryableWhatsAppOccurrence(jobType: string): Promise<boolean> {
  try {
    const result = await pool.query(
      `SELECT 1
         FROM scheduled_whatsapp_occurrences o
        WHERE o.job_type = $1
          AND o.created_at >= now() - interval '36 hours'
          AND (
            o.status IN ('partial', 'failed')
            OR (
              o.status = 'claimed'
              AND o.delivery_started_at IS NULL
              AND o.claim_expires_at < now()
            )
          )
          AND NOT EXISTS (
            SELECT 1
              FROM scheduled_whatsapp_attachments a
             WHERE a.occurrence_id = o.id
               AND a.status = 'sending'
          )
        LIMIT 1`,
      [jobType]
    );
    return Boolean(result.rowCount);
  } catch (error: unknown) {
    // During a rolling deployment the code can briefly run before the startup
    // migration has created the durable delivery tables. Fall back to the
    // existing due-time check for that short window.
    if ((error as { code?: string })?.code === "42P01") return false;
    throw error;
  }
}

async function shouldLoadStockReportModule(): Promise<boolean> {
  const { rows } = await pool.query<{
    company_id: number | null;
    recipient_id: number | null;
    enabled: boolean | null;
    auto_send: boolean | null;
    frequency: string | null;
    send_hour: number | null;
    send_day_of_week: number | null;
    last_sent_at: Date | string | null;
  }>(
    `SELECT company_id, recipient_id, enabled, auto_send, frequency,
            send_hour, send_day_of_week, last_sent_at
       FROM whatsapp_stock_settings
      WHERE id = 1`
  );
  const row = rows[0];
  if (!row?.company_id || !row?.recipient_id || !row.enabled || !row.auto_send) return false;
  if (await hasRetryableWhatsAppOccurrence("stock_report")) return true;
  return scheduledReportIsDue(row);
}

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

async function shouldLoadContainersWhatsAppModule(): Promise<boolean> {
  const { rows } = await pool.query<{
    instance_id: string | null;
    api_token: string | null;
    enabled: boolean | null;
    group_chat_id: string | null;
    schedule_enabled: boolean | null;
    schedule_hour: number | null;
    last_sent_at: Date | string | null;
  }>(
    `SELECT instance_id, api_token, enabled,
            containers_wa_group_chat_id AS group_chat_id,
            containers_wa_schedule_enabled AS schedule_enabled,
            containers_wa_schedule_hour AS schedule_hour,
            containers_wa_last_sent_at AS last_sent_at
       FROM whatsapp_settings
      WHERE id = 1`
  );
  const row = rows[0];
  if (
    !row?.enabled ||
    !row.instance_id ||
    !row.api_token ||
    !row.group_chat_id ||
    !row.schedule_enabled
  ) {
    return false;
  }

  if (await hasRetryableWhatsAppOccurrence("containers_report")) return true;

  const now = nowInNewYork();
  if (now.getHours() !== (row.schedule_hour ?? 8)) return false;

  if (row.last_sent_at) {
    const hoursSince = (Date.now() - new Date(row.last_sent_at).getTime()) / (60 * 60 * 1000);
    if (hoursSince < 12) return false;
  }

  return true;
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
      logger.info("[DailyExport] Scheduled check: today's export already succeeded — skipping.");
      return;
    }
    if (await isTodayExportRunning()) {
      logger.info("[DailyExport] Scheduled check: export is currently running — skipping.");
      return;
    }

    logger.info(`[DailyExport] Scheduled check: time matches (${configuredHour}:00 ${tz}) — starting export attempt.`);
    const { runDailyExport } = await import("./daily-export");
    const ok = await runDailyExport();
    if (!ok) {
      logger.warn("[DailyExport] Attempt failed; the next scheduled tick will retry within this hour.");
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
      "hourlyStockReport(hourly :00 ET)",
      "hourlyNetPositionExport(hourly :05 ET)",
      "scheduledDailyExport(:10/:25/:40/:55 ET; active only in configured hour)",
      "hourlyContainersWhatsApp(hourly :15 ET)",
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

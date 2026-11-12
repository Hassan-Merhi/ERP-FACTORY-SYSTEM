/**
 * Scheduler entrypoint.
 *
 * Keep this module intentionally light: server/index.ts imports it at process
 * startup, so static imports or barrel re-exports here become permanent
 * baseline RSS even when the corresponding scheduled job is not due.
 */
import cron from "node-cron";
import { logger } from "../../lib/logger";
import { startScheduler as startCoreScheduler } from "./scheduled-jobs";
import { createSchedulerTick } from "./schedulerTickGuard";

let locationStockCronStarted = false;

/**
 * Scheduler disabling is a process-wide safety switch, not merely a convention
 * for server/index.ts. Keeping the check here means tests, scripts, or future
 * startup paths cannot accidentally register cron jobs when the deployment has
 * explicitly disabled them.
 */
export function schedulersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ENABLE_SCHEDULERS !== "false";
}

/**
 * Register the existing schedules without eagerly evaluating their report,
 * export, WhatsApp, or accounting dependency graphs. The actual job module is
 * loaded on the tick that needs it; schedules and job behavior are unchanged.
 */
export function startScheduler(): void {
  if (!schedulersEnabled()) {
    logger.info("Schedulers disabled; cron registration skipped", {
      module: "scheduler",
      action: "start",
    });
    return;
  }

  startCoreScheduler();
  if (locationStockCronStarted) return;
  locationStockCronStarted = true;

  const locationStockTick = createSchedulerTick(
    "locationStockWhatsApp",
    async () => {
      const { checkAndRunLocationStockReports } = await import("./location-stock-report");
      await checkAndRunLocationStockReports();
    },
    { quiet: true }
  );

  cron.schedule("* * * * *", locationStockTick);

  const customMessageTick = createSchedulerTick(
    "scheduledWhatsAppCustomMessages",
    async () => {
      const { runScheduledWhatsAppMessages } = await import("../scheduledWhatsAppMessages");
      await runScheduledWhatsAppMessages();
    },
    { quiet: true }
  );
  cron.schedule("* * * * *", customMessageTick);

  const propertiesStatementTick = createSchedulerTick(
    "propertiesAccountStatementWhatsApp",
    async () => {
      const { runScheduledPropertiesWaStatements } = await import("../propertiesAccountStatementWhatsApp");
      await runScheduledPropertiesWaStatements();
    },
    { quiet: true }
  );
  cron.schedule("* * * * *", propertiesStatementTick);

  // Ticket dispatch, retries of unconfigured channels, and 24-hour overdue reminders.
  // Environment-gated until migrations and recipient opt-ins are configured.
  const ticketTick = createSchedulerTick(
    "ticketNotifications",
    async () => {
      const { runTicketNotificationTick } = await import("../ticketNotifications");
      await runTicketNotificationTick();
    },
    { quiet: true }
  );
  if (process.env.TICKET_NOTIFICATIONS_ENABLED === "true") {
    cron.schedule("* * * * *", ticketTick);
  }

  // Perpetual inventory (wave 8.4): the factory stock journal, every evening (UTC),
  // for each company whose cut-over is applied.
  const factoryStockTick = createSchedulerTick("factoryStockJournal", async () => {
    const { runFactoryStockJournals } = await import("../accounting/perpetualInventory/factoryStockJournal");
    await runFactoryStockJournals();
  });
  cron.schedule("45 23 * * *", factoryStockTick, { timezone: "UTC" });

  // Phase 7: daily read-only Factory mix scans. The module is lazy-loaded
  // only at 01:35 UTC; it writes only diagnostic state and Factory Alerts.
  // ENABLE_SCHEDULERS=false and the optional feature flag disable this.
  if (process.env.FACTORY_MIX_INTEGRITY_MONITOR_ENABLED !== "false") {
    const mixIntegrityTick = createSchedulerTick("factoryMixIntegrityMonitor", async () => {
      const { runScheduledFactoryMixIntegrityMonitoring } = await import("../factory/mixPhase7IntegrityMonitor");
      const result = await runScheduledFactoryMixIntegrityMonitoring();
      if (result.failed > 0) {
        throw new Error("Factory mix integrity scan failed for " + result.failed + " company(s)");
      }
    });
    cron.schedule("35 1 * * *", mixIntegrityTick, { timezone: "UTC" });
  }

  logger.info("Location stock WhatsApp scheduler registered", {
    module: "scheduler",
    action: "start",
    jobs: [
      "locationStockWhatsApp(every minute; per-location timezone/time/day rules)",
      "scheduledWhatsAppCustomMessages(every minute; per-message timezone and weekday times)",
      "propertiesAccountStatementWhatsApp(every minute; only enabled Properties account schedules)",
      "factoryStockJournal(23:45 UTC daily)",
      "factoryMixIntegrityMonitor(01:35 UTC daily; if enabled)",
    ],
  });
}

/**
 * Startup recovery is mostly a lightweight schedule/state probe. Keep the
 * heavy ZIP/Excel/email stack out of startup unless a missed export truly has
 * to run.
 */
export async function checkAndRecoverDailyExport(): Promise<void> {
  const recovery = await import("./daily-export-state");
  await recovery.checkAndRecoverDailyExport();
}

/** Preserve the existing public scheduler API used by the WhatsApp route. */
export async function triggerDailyWhatsAppSendNow(fromDate?: string, toDate?: string): Promise<{ message: string }> {
  const maintenance = await import("./maintenance");
  return maintenance.triggerDailyWhatsAppSendNow(fromDate, toDate);
}

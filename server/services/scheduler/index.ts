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

  logger.info("Location stock WhatsApp scheduler registered", {
    module: "scheduler",
    action: "start",
    jobs: ["locationStockWhatsApp(every minute; per-location timezone/time/day rules)"],
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

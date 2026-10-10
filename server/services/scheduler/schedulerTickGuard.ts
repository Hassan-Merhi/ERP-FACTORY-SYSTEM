import { logger } from "../../lib/logger";
import { nameSchedulerCallback } from "../../lib/schedulerObservability";
import { runWithDatabaseMaintenanceScope } from "../security/databaseScopeRuntimeContext";

/**
 * Wraps a scheduled job so a slow run cannot be overtaken by the next tick.
 *
 * node-cron fires on the clock, not on completion: an hourly job that takes
 * seventy minutes is already running when the next hour arrives, and the daily
 * export deliberately waits fifteen minutes between retries, so this is not a
 * theoretical case. Without a guard the runs pile up — each one re-reading the
 * same due work, competing for the same connections, and reporting durations
 * that no longer mean anything.
 *
 * The guard is per process. It is not a distributed lock and does not pretend to
 * be one: jobs whose work must not be repeated across processes claim their work
 * in the database (the location report claims the calendar day, the daily export
 * checks whether today's run is already in flight). This closes the much more
 * common case of one process tripping over its own previous tick.
 *
 * A skipped tick is logged rather than dropped silently, because a job that is
 * always still running is a problem someone needs to see.
 */
export interface SchedulerTickOptions {
  /**
   * Suppress the per-run started/succeeded lines. Used by jobs that fire every
   * minute and normally find nothing to do, where routine success logging would
   * bury everything else. Skips and failures are always logged.
   */
  quiet?: boolean;
}

export function createSchedulerTick(
  action: string,
  run: () => Promise<void>,
  options: SchedulerTickOptions = {}
): () => Promise<void> {
  let startedAt: number | null = null;

  const tick = async function tick(): Promise<void> {
    if (startedAt !== null) {
      logger.warn("cron tick skipped: previous run still in progress", {
        module: "scheduler",
        action,
        inFlightMs: Date.now() - startedAt,
      });
      return;
    }

    startedAt = Date.now();
    const runStartedAt = startedAt;
    if (!options.quiet) logger.info(`cron ${action} started`, { module: "scheduler", action });
    try {
      // Scheduled jobs are process-owned rather than request-owned. They may
      // legitimately enumerate multiple companies, but that access must be an
      // explicit maintenance capability now that missing RLS scope fails closed.
      // Maintenance scope bypasses the closed-period guard and the opening lock,
      // so jobs that write vouchers (recurring journals, rental accruals and
      // scheduled payments, factory stock journal) only list companies here and
      // post each company in its tenant scope (accounting/scheduledPostingScope.ts,
      // wave 18 A).
      await runWithDatabaseMaintenanceScope(`scheduler:${action}`, run);
      if (!options.quiet) {
        logger.info(`cron ${action} succeeded`, {
          module: "scheduler",
          action,
          durationMs: Date.now() - runStartedAt,
        });
      }
    } catch (error: unknown) {
      // Cron has nowhere to send a rejection, so the tick absorbs it. Rethrowing
      // would surface as an unhandled rejection and, in a process configured to
      // exit on those, take the server down for a failed report.
      logger.error(`cron ${action} failed`, {
        module: "scheduler",
        action,
        durationMs: Date.now() - runStartedAt,
        error,
      });
    } finally {
      // Released on every path, or one failed run would silence the job for the
      // lifetime of the process.
      startedAt = null;
    }
  };

  return nameSchedulerCallback(tick, action);
}

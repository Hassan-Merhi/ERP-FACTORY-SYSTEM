const SCHEDULER_JOB_NAME = Symbol.for("erp.scheduler.job-name");

type NamedSchedulerCallback = ((...args: unknown[]) => unknown) & {
  [SCHEDULER_JOB_NAME]?: string;
};

function normalizeJobName(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return normalized || "unnamed";
}

/**
 * Attaches a stable operational name to a cron callback without wrapping it.
 * node-cron can then retain the callback's overlap guard while observability
 * groups failures and latency by business job instead of by cron expression.
 */
export function nameSchedulerCallback<T extends (...args: never[]) => unknown>(callback: T, jobName: string): T {
  Object.defineProperty(callback, SCHEDULER_JOB_NAME, {
    configurable: false,
    enumerable: false,
    value: normalizeJobName(jobName),
    writable: false,
  });
  return callback;
}

export function getSchedulerCallbackName(callback: unknown): string | undefined {
  if (typeof callback !== "function") return undefined;
  const value = (callback as NamedSchedulerCallback)[SCHEDULER_JOB_NAME];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function resolveSchedulerMetricName(expression: string, callback: unknown): string {
  const callbackName = getSchedulerCallbackName(callback);
  return callbackName ? `cron:${callbackName}` : `cron-expression:${String(expression).slice(0, 80)}`;
}

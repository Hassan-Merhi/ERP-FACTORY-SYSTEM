import { randomUUID } from "node:crypto";
import cron from "node-cron";
import { logger } from "./logger";
import { installOperationalAlertRuntime } from "./operationalAlertRuntime";
import { captureRuntimeFailures, recordRuntimePerformance } from "./runtimePerformance";
import { resolveSchedulerMetricName } from "./schedulerObservability";
import { getTraceContext, runWithTraceContext, withTraceSpan } from "./traceContext";

const BOOTSTRAP_KEY = "__erpObservabilityBootstrapInstalled";
const originalFetch = globalThis.fetch?.bind(globalThis);

function safeDependencyName(input: RequestInfo | URL): string | undefined {
  try {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (host === "api.green-api.com") return "green-api";
    if (host.includes("maersk")) return "maersk";
    if (host.includes("cma-cgm") || host.includes("cmacgm")) return "cma-cgm";
    if (host.includes("msc.com")) return "msc";
    if (host.includes("hapag") || host.includes("hlag")) return "hapag-lloyd";
    return undefined;
  } catch {
    return undefined;
  }
}

function installExternalFetchTracing(): void {
  if (!originalFetch) return;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const dependency = safeDependencyName(input);
    if (!dependency) return originalFetch(input, init);
    const startedAt = performance.now();
    try {
      const response = await originalFetch(input, init);
      const durationMs = performance.now() - startedAt;
      const failed = !response.ok;
      const trace = getTraceContext();
      recordRuntimePerformance({
        kind: "dependency",
        name: dependency,
        durationMs,
        failed,
        source: trace?.source || "background",
      });
      const configured = Number(process.env.EXTERNAL_DEPENDENCY_SLOW_MS);
      const thresholdMs = Number.isFinite(configured) ? Math.max(0, configured) : 1_500;
      const slow = durationMs >= thresholdMs;
      if (failed || slow) {
        const isServerFailure = response.status >= 500;
        // Scheduler tracking deliberately tries fallbacks. A provider attempt can
        // fail while the overall job succeeds, so keep those attempts visible as
        // warnings and reserve error-level scheduler logs for the final job failure.
        const level = isServerFailure && trace?.source !== "scheduler" ? "error" : "warn";
        logger[level]("External dependency operation", {
          module: "dependency",
          action: failed ? "request_failed" : "slow_request",
          dependency,
          durationMs: Math.round(durationMs),
          status: response.status,
          requestId: trace?.requestId,
          source: trace?.source,
        });
      }
      return response;
    } catch (error) {
      const durationMs = performance.now() - startedAt;
      const trace = getTraceContext();
      recordRuntimePerformance({
        kind: "dependency",
        name: dependency,
        durationMs,
        failed: true,
        source: trace?.source || "background",
      });
      const log = trace?.source === "scheduler" ? logger.warn.bind(logger) : logger.error.bind(logger);
      log("External dependency operation", {
        module: "dependency",
        action: "request_failed",
        dependency,
        durationMs: Math.round(durationMs),
        requestId: trace?.requestId,
        source: trace?.source,
        error,
      });
      throw error;
    }
  }) as typeof globalThis.fetch;
}

function installCronTracing(): void {
  const cronAny = cron as unknown as { __erpTracePatched: unknown } & { schedule: unknown };
  if (cronAny.__erpTracePatched) return;
  cronAny.__erpTracePatched = true;
  const originalSchedule = cron.schedule.bind(cron);
  cronAny.schedule = (
    expression: string,
    callback: (...args: unknown[]) => unknown,
    options?: Record<string, unknown>
  ) => {
    const jobName = resolveSchedulerMetricName(expression, callback);
    const wrapped = (...args: unknown[]) => {
      const requestId = `scheduler-${randomUUID()}`;
      let loggedFailure = false;
      return runWithTraceContext(
        {
          requestId,
          routeTemplate: jobName,
          buildVersion: process.env.BUILD_VERSION || process.env.RENDER_GIT_COMMIT?.substring(0, 8) || "dev",
          source: "scheduler",
        },
        () =>
          withTraceSpan(
            jobName,
            async () => {
              const outcome = await captureRuntimeFailures(() => callback(...args));
              loggedFailure = outcome.failed;
              return outcome.result;
            },
            ({ durationMs, failed }) =>
              recordRuntimePerformance({
                kind: "background",
                name: jobName,
                durationMs,
                failed: failed || loggedFailure,
                source: "scheduler",
              })
          )
      );
    };
    return originalSchedule(expression, wrapped, options);
  };
}

const globalState = globalThis as typeof globalThis & Record<string, unknown>;
if (!globalState[BOOTSTRAP_KEY]) {
  globalState[BOOTSTRAP_KEY] = true;
  installExternalFetchTracing();
  installCronTracing();
  installOperationalAlertRuntime();
}

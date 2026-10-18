import fs from "node:fs";

const requiredFiles = [
  "server/lib/logger.ts",
  "server/lib/traceContext.ts",
  "server/lib/observabilityBootstrap.ts",
  "server/lib/requestPerformanceContext.ts",
  "server/lib/performanceDashboard.ts",
  "server/lib/runtimePerformance.ts",
  "server/lib/operationalAlerts.ts",
  "server/lib/operationalAlertRuntime.ts",
  "server/middleware/requestLogger.ts",
  "server/middleware/clientObservability.ts",
  "server/wsServer.ts",
  "server/index.ts",
  "client/src/main.tsx",
  "client/src/lib/clientObservability.ts",
  "client/src/components/ObservabilityErrorBoundary.tsx",
  "docs/archive/program-1-observability-roadmap.md",
  "docs/program-1-incident-response-runbook.md",
];
for (const file of requiredFiles) if (!fs.existsSync(file)) throw new Error(`Program 1 missing required file: ${file}`);
const read = (file) => fs.readFileSync(file, "utf8");
const logger = read("server/lib/logger.ts");
const trace = read("server/lib/traceContext.ts");
const bootstrap = read("server/lib/observabilityBootstrap.ts");
const dashboard = read("server/lib/performanceDashboard.ts");
const runtime = read("server/lib/runtimePerformance.ts");
const alerts = read("server/lib/operationalAlerts.ts");
const alertRuntime = read("server/lib/operationalAlertRuntime.ts");
const requestLogger = read("server/middleware/requestLogger.ts");
const intake = read("server/middleware/clientObservability.ts");
const roadmap = read("docs/archive/program-1-observability-roadmap.md");
const runbook = read("docs/program-1-incident-response-runbook.md");
const checks = [
  [logger.includes("SENSITIVE_KEY_PATTERN") && logger.includes("JSON.stringify(entry)"), "logger must remain structured and redacted"],
  [trace.includes("AsyncLocalStorage") && trace.includes("normaliseRouteTemplate"), "trace context must remain concurrency safe and normalized"],
  [bootstrap.includes('host === "api.green-api.com"') && bootstrap.includes("maersk"), "supported dependencies must remain traced"],
  [bootstrap.includes("response.ok") && bootstrap.includes("captureRuntimeFailures"), "HTTP and swallowed scheduler failures must be captured"],
  [bootstrap.includes("installOperationalAlertRuntime"), "alert runtime must be installed"],
  [requestLogger.includes("recordPerformanceSample") && requestLogger.includes("X-Request-Id"), "HTTP requests must feed correlated performance samples"],
  [dashboard.includes("PERFORMANCE_DASHBOARD_MAX_SAMPLES") && dashboard.includes("Number.isFinite"), "dashboard retention config must fail safe"],
  [runtime.includes("PERFORMANCE_DASHBOARD_RUNTIME_MAX_SAMPLES") && runtime.includes("Number.isFinite"), "runtime retention config must fail safe"],
  [dashboard.includes("/api/health/performance.json") && dashboard.includes("/api/health/incidents.json"), "protected performance and incident endpoints must remain available"],
  [alerts.includes("OBSERVABILITY_ALERT_COOLDOWN_MS") && alerts.includes("OBSERVABILITY_ALERT_HISTORY_LIMIT"), "alerts must remain cooled down and bounded"],
  [alerts.includes("OBSERVABILITY_ALERT_JOB_FAILURES") && alerts.includes("OBSERVABILITY_ALERT_DEPENDENCY_FAILURES"), "job and dependency alerts must remain configurable"],
  [alerts.includes("if (!response.ok)") && alerts.includes("Operational alert delivery failed"), "webhook HTTP failures must fail open"],
  [alertRuntime.includes("Number.isFinite") && alertRuntime.includes('OBSERVABILITY_ALERTS_ENABLED !== "true"'), "alert evaluation must use a safe interval and remain disabled by default"],
  [intake.includes("CLIENT_ERROR_RATE_LIMIT") && intake.includes("CLIENT_ERROR_DEDUPE_MS"), "browser intake must remain bounded"],
  [roadmap.includes("Program status: complete") && roadmap.includes("Phase 4 — Alerts and operational response"), "Program 1 roadmap must remain complete"],
  [runbook.includes("First response") && runbook.includes("Recovery verification"), "runbook must cover response and recovery"],
  [roadmap.includes("Never send request bodies") && roadmap.includes("Monitoring dependencies must fail open"), "privacy and fail-open boundaries must remain documented"],
];
for (const [passed, message] of checks) if (!passed) throw new Error(`Program 1 observability verification failed: ${message}`);
console.log("Program 1 observability Phases 1-4 contract verified.");

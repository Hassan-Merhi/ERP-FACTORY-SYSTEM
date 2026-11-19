/** Shared structured logger for server-side use. */
import { redactLogString, redactLogValue } from "./logRedaction";
import { markRuntimeFailure } from "./runtimePerformance";
import { getTraceContext } from "./traceContext";
import {
  LEVEL_WEIGHT,
  SENSITIVE_KEY_PATTERN,
  MAX_DEPTH,
  formatBytes,
  formatDuration,
  formatRankedEndpoints,
  parseAccessDeniedMessage,
  humanizeLegacyMessage,
  type LogLevel,
  type LogFormat,
  type LogContext,
} from "./loggerHelpers";
export type { LogLevel, LogFormat, LogContext } from "./loggerHelpers";

const isDev = process.env.NODE_ENV !== "production";
const isRender = process.env.RENDER === "true" || Boolean(process.env.RENDER_SERVICE_ID);

const configuredLevel = String(process.env.LOG_LEVEL || (isDev ? "debug" : "info")).toLowerCase();
const minimumLevel: LogLevel = configuredLevel in LEVEL_WEIGHT ? (configuredLevel as LogLevel) : "info";
const configuredFormat = String(process.env.LOG_FORMAT || "").toLowerCase();
const outputFormat: LogFormat =
  configuredFormat === "json" || configuredFormat === "pretty"
    ? configuredFormat
    : isDev || isRender
      ? "pretty"
      : "json";
const redactionEnabled = process.env.NODE_ENV === "production" || process.env.LOG_REDACT_SENSITIVE !== "false";
const MAX_STRING_LENGTH = 2_000;

function safeError(err: unknown, depth = 0): Record<string, unknown> | undefined {
  if (err == null) return undefined;
  if (!(err instanceof Error)) return { message: redactLogString(String(err)).slice(0, MAX_STRING_LENGTH) };
  const value = err as Error & { code?: unknown; detail?: unknown; cause?: unknown };
  const out: Record<string, unknown> = { message: redactLogString(value.message).slice(0, MAX_STRING_LENGTH) };
  if (isDev) out.stack = redactLogString(value.stack || "");
  if (typeof value.code === "string") out.code = value.code;
  if (typeof value.detail === "string") out.detail = redactLogString(value.detail).slice(0, MAX_STRING_LENGTH);
  if (depth < 3 && value.cause != null) out.cause = safeError(value.cause, depth + 1);
  return out;
}

function sanitiseValue(value: unknown, key = "", depth = 0, seen = new WeakSet<object>()): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const redacted = redactionEnabled ? String(redactLogValue(value, key)) : value;
    return redacted.length > MAX_STRING_LENGTH ? `${redacted.slice(0, MAX_STRING_LENGTH)}…` : redacted;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return String(value);
  if (value instanceof Error) return safeError(value);
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (depth >= MAX_DEPTH) return "[MaxDepth]";
  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 50).map((entry) => sanitiseValue(entry, key, depth + 1, seen));
    const output: Record<string, unknown> = {};
    for (const [childKey, entry] of Object.entries(value as Record<string, unknown>)) {
      output[childKey] = SENSITIVE_KEY_PATTERN.test(childKey)
        ? "[REDACTED]"
        : sanitiseValue(entry, childKey, depth + 1, seen);
    }
    return output;
  }
  return String(value);
}

function sanitiseContext(ctx: LogContext): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(ctx)) {
    if (key === "error" || value === undefined) continue;
    output[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : sanitiseValue(value, key);
  }
  return output;
}

function ensureSentence(message: string): string {
  const value = message.trim().replace(/\s+/g, " ");
  if (!value) return "Application event recorded.";
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function resolveEvent(ctx: LogContext): string | undefined {
  const explicit = typeof ctx.event === "string" ? ctx.event.trim() : "";
  if (explicit)
    return explicit
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "_")
      .slice(0, 120);
  if (ctx.module === "operational_events" && typeof ctx.code === "string")
    return `operational.${ctx.code.toLowerCase().replace(/[^a-z0-9_.-]+/g, "_")}`.slice(0, 120);
  const parts = [ctx.module, ctx.action].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0
  );
  return parts.length
    ? parts
        .join(".")
        .toLowerCase()
        .replace(/[^a-z0-9_.-]+/g, "_")
        .slice(0, 120)
    : undefined;
}

function resolveEffectiveLevel(level: LogLevel, message: string, ctx: LogContext): LogLevel {
  if (level !== "info") return level;
  // Security events keep their level: their text can carry request-controlled
  // values (a blocked URI ending in /heartbeat) that must not demote them.
  if (typeof ctx.event === "string" && ctx.event.startsWith("security.")) return level;
  const text = message.trim();
  const moduleName = String(ctx.module || "").toLowerCase();
  const actionName = String(ctx.action || "").toLowerCase();
  const startup = /(?:startup|server|scheduler|migration|bootstrap)/.test(moduleName);
  if (
    !startup &&
    (/(?:^|\s)(?:started|starting|beginning)$/i.test(text) ||
      /(?:^|[_.-])(?:start|started|begin|beginning)$/.test(actionName))
  )
    return "debug";
  if (/^\[getLocationInventory\]/i.test(text) || /\[express\]\s*\[SLOW API\]/i.test(text)) return "debug";
  if (
    /\b(?:polling?|heartbeat|keepalive|cache hit|cache miss|query started|query completed|auth check|session check|reference data loaded)\b/i.test(
      text
    )
  )
    return "debug";
  if (/(?:poll|heartbeat|keepalive|cache_hit|cache_miss|auth_check|session_check|reference_data)/.test(actionName))
    return "debug";
  const denied = parseAccessDeniedMessage(text);
  if (denied?.reason === "SESSION_REQUIRED" && denied.path === "/api/auth/me") return "debug";
  return level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[minimumLevel];
}
function formatPrettyValue(value: unknown): string {
  if (value != null && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function formatPrettyContext(ctx: Record<string, unknown>): string[] {
  const keys = [
    "event",
    "requestId",
    "routeTemplate",
    "userId",
    "companyId",
    "factoryCompanyId",
    "locationId",
    "voucherId",
    "containerId",
    "orderId",
    "status",
    "durationMs",
    "thresholdMs",
    "thresholdClass",
    "responseBytes",
    "budgetBytes",
    "dbQueryCount",
    "dbDurationMs",
    "buildVersion",
    "issueCount",
    "issueCodes",
    "issues",
    "checked",
    "discrepancyCount",
    "discrepancyCodes",
    "accountingSnapshots",
    "stockSnapshots",
    "companies",
    "clean",
    "withDiscrepancies",
    "rejected",
    "failed",
    "discrepancies",
  ];
  return keys.flatMap((key) => {
    const value = ctx[key];
    if (value == null || value === "") return [];
    if (["durationMs", "dbDurationMs", "thresholdMs"].includes(key)) return [`${key}=${formatDuration(value)}`];
    if (["responseBytes", "budgetBytes"].includes(key)) return [`${key}=${formatBytes(value)}`];
    return [`${key}=${formatPrettyValue(value)}`];
  });
}

function emit(level: LogLevel, message: string, ctx: LogContext = {}): void {
  const effectiveLevel = resolveEffectiveLevel(level, message, ctx);
  if (!shouldLog(effectiveLevel)) return;
  if (effectiveLevel === "error") markRuntimeFailure();
  const merged: LogContext = { ...(getTraceContext() || {}), ...ctx };
  const event = resolveEvent(merged);
  if (event) merged.event = event;
  const readableMessage = ensureSentence(
    redactionEnabled ? redactLogString(humanizeLegacyMessage(message, merged)) : humanizeLegacyMessage(message, merged)
  );
  const safeContext = sanitiseContext(merged);
  const error = safeError(merged.error);
  if (outputFormat === "pretty") {
    const line = [
      `[${effectiveLevel.toUpperCase()}]`,
      readableMessage,
      ...formatPrettyContext(safeContext),
      ...(error ? [`error=${String(error.message)}`] : []),
    ].join(" ");
    if (effectiveLevel === "error") console.error(line);
    else if (effectiveLevel === "warn") console.warn(line);
    else console.log(line);
    return;
  }
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level: effectiveLevel.toUpperCase(),
    message: readableMessage.slice(0, MAX_STRING_LENGTH),
    ...safeContext,
  };
  if (error) entry.error = error;
  const line = JSON.stringify(entry);
  if (effectiveLevel === "error") console.error(line);
  else if (effectiveLevel === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, ctx?: LogContext) => emit("debug", message, ctx),
  info: (message: string, ctx?: LogContext) => emit("info", message, ctx),
  warn: (message: string, ctx?: LogContext) => emit("warn", message, ctx),
  error: (message: string, ctx?: LogContext) => emit("error", message, ctx),
};

export function getLoggerConfiguration() {
  return { level: minimumLevel, format: outputFormat, redactionEnabled, renderDetected: isRender };
}

(globalThis as unknown as { __erpLogger?: typeof logger }).__erpLogger = logger;
export const __loggerTesting = {
  formatBytes,
  formatDuration,
  formatRankedEndpoints,
  humanizeLegacyMessage,
  resolveEffectiveLevel,
  resolveEvent,
  formatPrettyContext,
  sanitiseContext,
  outputFormat,
  minimumLevel,
  redactionEnabled,
};

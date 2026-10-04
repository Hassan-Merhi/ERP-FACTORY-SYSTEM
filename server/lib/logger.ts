/** Shared structured logger for server-side use. */
import { redactLogString, redactLogValue } from "./logRedaction";
import { markRuntimeFailure } from "./runtimePerformance";
import { getTraceContext } from "./traceContext";

const isDev = process.env.NODE_ENV !== "production";
const isRender = process.env.RENDER === "true" || Boolean(process.env.RENDER_SERVICE_ID);

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFormat = "json" | "pretty";
export interface LogContext {
  event?: string;
  module?: string;
  action?: string;
  code?: string;
  requestId?: string;
  userId?: number | string | null;
  companyId?: number | string | null;
  factoryCompanyId?: number | string | null;
  locationId?: number | string | null;
  voucherId?: number | string | null;
  containerId?: number | string | null;
  orderId?: number | string | null;
  durationMs?: number;
  status?: number | string;
  error?: unknown;
  [key: string]: unknown;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
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
const SENSITIVE_KEY_PATTERN =
  /(?:password|passwd|secret|token|authorization|cookie|session|csrf|api[-_]?key|private[-_]?key|credential)/i;
const MAX_STRING_LENGTH = 2_000;
const MAX_DEPTH = 4;

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

function formatBytes(value: unknown): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "an unknown amount of data";
  if (bytes < 1_024) return `${Math.round(bytes)} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(bytes >= 10_240 ? 0 : 1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(bytes >= 10_485_760 ? 1 : 2)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}

function formatDuration(value: unknown): string {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return "an unknown time";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms >= 10_000 ? 1 : 2)} seconds`;
  return `${(ms / 60_000).toFixed(1)} minutes`;
}

function ensureSentence(message: string): string {
  const value = message.trim().replace(/\s+/g, " ");
  if (!value) return "Application event recorded.";
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function plural(value: number, singular: string): string {
  return `${value} ${value === 1 ? singular : `${singular}s`}`;
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

function formatRankedEndpoints(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .slice(0, 3)
    .map((entry) => {
      const row = entry as Record<string, unknown>;
      return `${String(row.method || "HTTP").toUpperCase()} ${String(row.path || "unknown endpoint")} ${formatBytes(row.totalResponseBytes)}`;
    })
    .join("; ");
}

function parseAccessDeniedMessage(text: string): Record<string, unknown> | undefined {
  if (!text.startsWith("{") || !text.endsWith("}")) return undefined;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    return value.event === "access_denied" ? value : undefined;
  } catch {
    return undefined;
  }
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

function humanizeLegacyMessage(message: string, ctx: LogContext): string {
  const text = message.trim();
  const legacyFields = (prefix: string): Record<string, string> | undefined => {
    if (!text.startsWith(prefix)) return undefined;
    const fields: Record<string, string> = {};
    for (const token of text.slice(prefix.length).trim().split(/\s+/)) {
      const separator = token.indexOf("=");
      if (separator > 0) fields[token.slice(0, separator)] = token.slice(separator + 1);
    }
    return fields;
  };
  const inventoryFields = legacyFields("[getLocationInventory]");
  const inventoryRowsMatch = text.match(/(?:^|\s)(\d+)\s+rows(?:\s|$)/);
  if (inventoryFields?.locationId && inventoryRowsMatch?.[1] && /^\d+$/.test(inventoryFields.locationId)) {
    return `Inventory loaded for location ${inventoryFields.locationId} with ${plural(Number(inventoryRowsMatch[1]), "item")}`;
  }
  const invoiceFields = legacyFields("[WA invoice backend]");
  if (
    invoiceFields?.voucherId &&
    invoiceFields?.locationId &&
    invoiceFields?.itemCount &&
    invoiceFields?.pageCount &&
    invoiceFields?.dryRun &&
    /^\d+$/.test(invoiceFields.voucherId) &&
    /^\d+$/.test(invoiceFields.locationId) &&
    /^\d+$/.test(invoiceFields.itemCount) &&
    /^\d+$/.test(invoiceFields.pageCount) &&
    /^(?:true|false)$/.test(invoiceFields.dryRun)
  ) {
    return `${invoiceFields.dryRun === "true" ? "Invoice preview" : "Invoice"} ${invoiceFields.voucherId} was generated for location ${invoiceFields.locationId} with ${plural(Number(invoiceFields.itemCount), "item")} across ${plural(Number(invoiceFields.pageCount), "page")}`;
  }
  if (text === "[WA upload] Green API response")
    return `WhatsApp uploaded ${String(ctx.fileName || "the file")} successfully${ctx.size == null ? "" : ` (${formatBytes(ctx.size)})`}`;
  if (text === "[WA upload] Green API error") return `WhatsApp could not upload ${String(ctx.fileName || "the file")}`;
  if (text === "POS sale update started")
    return ctx.voucherId != null ? `Updating POS sale ${ctx.voucherId}` : "Updating a POS sale";
  if (text === "POS sale update succeeded")
    return ctx.voucherId != null
      ? `POS sale ${ctx.voucherId} was updated successfully`
      : "The POS sale was updated successfully";
  if (text === "POS sale update failed")
    return ctx.voucherId != null
      ? `POS sale ${ctx.voucherId} could not be updated`
      : "The POS sale could not be updated";
  if (text === "container tracking update started")
    return ctx.containerId != null
      ? `Updating tracking for container ${ctx.containerId}`
      : "Updating container tracking";
  if (text === "container tracking update succeeded")
    return ctx.containerId != null
      ? `Tracking for container ${ctx.containerId} was updated successfully`
      : "Container tracking was updated successfully";
  if (text === "container tracking update failed")
    return ctx.containerId != null
      ? `Tracking for container ${ctx.containerId} could not be updated`
      : "Container tracking could not be updated";
  if (text === "Ranked endpoint performance and bandwidth snapshot") {
    const endpointCount = Number(ctx.apiEndpointCount ?? ctx.endpointCount ?? 0);
    const top = formatRankedEndpoints(ctx.ranked);
    return `API responses transferred ${formatBytes(ctx.totalApiResponseBytes)} across ${plural(endpointCount, "endpoint")} during the last ${formatDuration(ctx.windowMs)}${top ? `. Top endpoints: ${top}` : ""}`;
  }
  if (text === "Large HTTP response detected")
    return `${String(ctx.method || "HTTP")} ${String(ctx.path || "request")} returned a large ${formatBytes(ctx.responseBytes)} response${ctx.budgetBytes == null ? "" : `, exceeding the ${formatBytes(ctx.budgetBytes)} warning threshold`}`;
  const match = text.match(/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(\S+)\s+(\d{3})$/i);
  if (match) {
    const status = Number(match[3]);
    const outcome = status >= 500 ? "failed" : status >= 400 ? "was rejected" : "completed";
    return `${match[1].toUpperCase()} ${match[2]} ${outcome} with status ${status}${ctx.durationMs == null ? "" : ` in ${formatDuration(ctx.durationMs)}`}${ctx.slow === true && ctx.thresholdMs != null ? `; warning threshold ${formatDuration(ctx.thresholdMs)}` : ""}`;
  }
  const denied = parseAccessDeniedMessage(text);
  if (denied)
    return `Access to ${String(denied.path || "the requested page")} was denied because ${denied.reason === "SESSION_REQUIRED" ? "an active session was required" : "access was not permitted"}`;
  if (text.startsWith("[")) {
    const closingBracket = text.indexOf("]");
    if (closingBracket > 1) {
      const prefix = text.slice(1, closingBracket);
      const remainder = text.slice(closingBracket + 1).trim();
      return remainder
        ? `${prefix.replace(/^\//, "").replace(/[-_/]+/g, " ")}: ${remainder}`
        : `[${prefix}] event recorded`;
    }
  }
  return text;
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

export function createScopedLogger(module: string, defaults: LogContext = {}) {
  const contextFor = (action: string, ctx?: LogContext): LogContext => ({
    ...defaults,
    ...ctx,
    module,
    action,
    event: ctx?.event || `${module}.${action}`,
  });
  return {
    debug: (action: string, message: string, ctx?: LogContext) => logger.debug(message, contextFor(action, ctx)),
    info: (action: string, message: string, ctx?: LogContext) => logger.info(message, contextFor(action, ctx)),
    warn: (action: string, message: string, ctx?: LogContext) => logger.warn(message, contextFor(action, ctx)),
    error: (action: string, message: string, ctx?: LogContext) => logger.error(message, contextFor(action, ctx)),
  };
}

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

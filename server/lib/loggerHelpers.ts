// Extracted from ./logger.ts

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

export const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export const SENSITIVE_KEY_PATTERN =
  /(?:password|passwd|secret|token|authorization|cookie|session|csrf|api[-_]?key|private[-_]?key|credential)/i;

export const MAX_DEPTH = 4;

export function formatBytes(value: unknown): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "an unknown amount of data";
  if (bytes < 1_024) return `${Math.round(bytes)} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(bytes >= 10_240 ? 0 : 1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(bytes >= 10_485_760 ? 1 : 2)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}

export function formatDuration(value: unknown): string {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return "an unknown time";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms >= 10_000 ? 1 : 2)} seconds`;
  return `${(ms / 60_000).toFixed(1)} minutes`;
}

function plural(value: number, singular: string): string {
  return `${value} ${value === 1 ? singular : `${singular}s`}`;
}

export function formatRankedEndpoints(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .slice(0, 3)
    .map((entry) => {
      const row = entry as Record<string, unknown>;
      return `${String(row.method || "HTTP").toUpperCase()} ${String(row.path || "unknown endpoint")} ${formatBytes(row.totalResponseBytes)}`;
    })
    .join("; ");
}

export function parseAccessDeniedMessage(text: string): Record<string, unknown> | undefined {
  if (!text.startsWith("{") || !text.endsWith("}")) return undefined;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    return value.event === "access_denied" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function humanizeLegacyMessage(message: string, ctx: LogContext): string {
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

import { dispatchOperationalAlert } from "./logAlertDispatcher";
import { logger } from "./logger";

export type OperationalEventCategory = "error" | "bandwidth" | "integrity";
export type OperationalEventSeverity = "info" | "warning" | "critical";

export interface OperationalEventInput {
  category: OperationalEventCategory;
  code: string;
  severity: OperationalEventSeverity;
  message: string;
  requestId?: string;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  responseBytes?: number;
  budgetBytes?: number;
  companyId?: number;
  userId?: number;
  endpointCount?: number;
  apiEndpointCount?: number;
  staticAssetCount?: number;
  windowMs?: number;
  totalApiResponseBytes?: number;
  totalStaticAssetResponseBytes?: number;
  apiWindowBudgetBytes?: number;
  staticWindowBudgetBytes?: number;
  endpointWindowBudgetBytes?: number;
  ranked?: unknown[];
  staticAssets?: unknown[];
  heapDeltaBytes?: number;
  dbQueryCount?: number;
  dbDurationMs?: number;
  requests?: number;
  averageResponseBytes?: number;
  maxResponseBytes?: number;
  status200?: number;
  status304?: number;
  cacheHits?: number;
  cacheMisses?: number;
  cacheRevalidations?: number;
  suspectedLoop?: boolean;
  companyContexts?: string[];
  pageContexts?: string[];
  cacheOutcome?: string;
  companyContext?: string | null;
  pageContext?: string | null;
}

interface OperationalEventRecord extends OperationalEventInput {
  timestamp: string;
}

interface OperationalEventCodeSummary {
  code: string;
  category: OperationalEventCategory;
  severity: OperationalEventSeverity;
  count: number;
  lastSeenAt: string;
  lastMessage: string;
}

const MAX_RECENT_EVENTS = 50;
const counts: Record<OperationalEventCategory, number> = { error: 0, bandwidth: 0, integrity: 0 };
const severityCounts: Record<OperationalEventSeverity, number> = { info: 0, warning: 0, critical: 0 };
const codeSummaries = new Map<string, OperationalEventCodeSummary>();
const recentEvents: OperationalEventRecord[] = [];

function normalizeCode(code: string): string {
  const normalized = code
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_");
  return normalized.slice(0, 80) || "unknown_event";
}

function normalizeMessage(message: string): string {
  return message.trim().slice(0, 200) || "Operational event detected";
}

function normalizeOptionalId(value: number | undefined): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function updateCodeSummary(event: OperationalEventRecord): void {
  const key = `${event.category}:${event.code}`;
  const existing = codeSummaries.get(key);
  codeSummaries.set(key, {
    code: event.code,
    category: event.category,
    severity: event.severity,
    count: (existing?.count ?? 0) + 1,
    lastSeenAt: event.timestamp,
    lastMessage: event.message,
  });
}

export function recordOperationalEvent(input: OperationalEventInput): void {
  const event: OperationalEventRecord = {
    ...input,
    code: normalizeCode(input.code),
    message: normalizeMessage(input.message),
    companyId: normalizeOptionalId(input.companyId),
    userId: normalizeOptionalId(input.userId),
    timestamp: new Date().toISOString(),
  };

  counts[event.category] += 1;
  severityCounts[event.severity] += 1;
  updateCodeSummary(event);
  recentEvents.unshift(event);
  if (recentEvents.length > MAX_RECENT_EVENTS) recentEvents.length = MAX_RECENT_EVENTS;

  const context = {
    module: "operational_events",
    action: "event_detected",
    category: event.category,
    code: event.code,
    severity: event.severity,
    requestId: event.requestId,
    method: event.method,
    path: event.path,
    status: event.status,
    durationMs: event.durationMs,
    responseBytes: event.responseBytes,
    budgetBytes: event.budgetBytes,
    totalApiResponseBytes: event.totalApiResponseBytes,
    totalStaticAssetResponseBytes: event.totalStaticAssetResponseBytes,
    apiWindowBudgetBytes: event.apiWindowBudgetBytes,
    staticWindowBudgetBytes: event.staticWindowBudgetBytes,
    endpointWindowBudgetBytes: event.endpointWindowBudgetBytes,
    companyId: event.companyId,
    userId: event.userId,
    endpointCount: event.endpointCount,
    apiEndpointCount: event.apiEndpointCount,
    staticAssetCount: event.staticAssetCount,
    windowMs: event.windowMs,
    ranked: event.ranked,
    staticAssets: event.staticAssets,
    heapDeltaBytes: event.heapDeltaBytes,
    dbQueryCount: event.dbQueryCount,
    dbDurationMs: event.dbDurationMs,
    requests: event.requests,
    averageResponseBytes: event.averageResponseBytes,
    maxResponseBytes: event.maxResponseBytes,
    status200: event.status200,
    status304: event.status304,
    cacheHits: event.cacheHits,
    cacheMisses: event.cacheMisses,
    cacheRevalidations: event.cacheRevalidations,
    suspectedLoop: event.suspectedLoop,
    companyContexts: event.companyContexts,
    pageContexts: event.pageContexts,
    cacheOutcome: event.cacheOutcome,
    companyContext: event.companyContext,
    pageContext: event.pageContext,
  };

  if (event.severity === "critical") logger.error(event.message, context);
  else if (event.severity === "warning") logger.warn(event.message, context);
  else logger.info(event.message, context);

  if (event.severity !== "info") {
    void dispatchOperationalAlert({
      severity: event.severity,
      category: event.category,
      code: event.code,
      message: event.message,
      timestamp: event.timestamp,
      requestId: event.requestId,
      method: event.method,
      path: event.path,
      status: event.status,
      durationMs: event.durationMs,
      responseBytes: event.responseBytes,
      budgetBytes: event.budgetBytes,
      companyId: event.companyId,
    });
  }
}

export function recordIntegrityEvent(
  code: string,
  message: string,
  context: Omit<OperationalEventInput, "category" | "code" | "message"> = { severity: "warning" }
): void {
  recordOperationalEvent({ category: "integrity", code, message, ...context });
}

export function getOperationalEventSnapshot() {
  return {
    counts: { ...counts },
    severityCounts: { ...severityCounts },
    byCode: [...codeSummaries.values()]
      .sort((left, right) => right.count - left.count || right.lastSeenAt.localeCompare(left.lastSeenAt))
      .map((summary) => ({ ...summary })),
    recent: recentEvents.map((event) => ({ ...event })),
  };
}

export function resetOperationalEventsForTests(): void {
  counts.error = 0;
  counts.bandwidth = 0;
  counts.integrity = 0;
  severityCounts.info = 0;
  severityCounts.warning = 0;
  severityCounts.critical = 0;
  codeSummaries.clear();
  recentEvents.length = 0;
}

/**
 * Permissions Control Center V2 — monitoring signals.
 *
 * One place that records permission and authorization signals as structured
 * log events (`event: "permission_signal"`) and keeps small in-process
 * counters per company for the administrator monitoring endpoint.
 *
 * Privacy: a signal carries only the kind, a stable code, the company id,
 * the user id, the role, the HTTP method and the route PATH. Query strings,
 * request bodies, headers, cookies, tokens, passwords and customer data are
 * never recorded. Paths are truncated and numeric ids collapsed so a path
 * cannot carry a free-text value.
 *
 * Counters are per process and reset on restart; log events are the durable
 * record and are what alerting should read.
 */
import { logger } from "../../lib/logger";
import { recordOperationalEvent, type OperationalEventSeverity } from "../../lib/operationalEvents";

export const PERMISSION_SIGNAL_KINDS = [
  "permission_denied",
  "unexpected_forbidden",
  "cross_company_attempt",
  "role_assignment_failed",
  "repeated_forbidden_mutation",
  "policy_revision_conflict",
  "permission_service_error",
  "policy_change",
  "v2_enforcement_denied",
  "business_integrity_discrepancy",
] as const;

export type PermissionSignalKind = (typeof PERMISSION_SIGNAL_KINDS)[number];

export interface PermissionSignal {
  kind: PermissionSignalKind;
  code: string;
  companyId?: number | null;
  userId?: string | null;
  role?: string | null;
  method?: string;
  path?: string;
  /** Extra non-sensitive numeric or enum detail (e.g. revision, mode). */
  detail?: Record<string, string | number | boolean | null>;
}

const ERROR_KINDS: ReadonlySet<PermissionSignalKind> = new Set([
  "permission_service_error",
  "business_integrity_discrepancy",
]);
const WARN_KINDS: ReadonlySet<PermissionSignalKind> = new Set([
  "unexpected_forbidden",
  "cross_company_attempt",
  "repeated_forbidden_mutation",
  "role_assignment_failed",
]);

/**
 * Signals that also become operational events, so they appear on the
 * operational monitoring dashboard and reach the configured alert destination
 * (LOG_ALERT_WEBHOOK_URL, with its own cooldown).
 */
const ESCALATED: Partial<Record<PermissionSignalKind, OperationalEventSeverity>> = {
  repeated_forbidden_mutation: "warning",
  cross_company_attempt: "warning",
  permission_service_error: "critical",
  business_integrity_discrepancy: "critical",
};

const MAX_PATH = 160;
const SENSITIVE_DETAIL_KEY = /pass|token|secret|cookie|auth|session|email|phone|name/i;

/** Route path only: no query, numeric/uuid segments collapsed, bounded length. */
export function sanitizeSignalPath(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const path = (raw.split("?", 1)[0] ?? "")
    .split("/")
    .map((segment) =>
      /^\d+$/.test(segment) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment) ? ":id" : segment.slice(0, 40)
    )
    .join("/");
  return path.length > MAX_PATH ? `${path.slice(0, MAX_PATH)}…` : path;
}

function sanitizeDetail(detail: PermissionSignal["detail"]): PermissionSignal["detail"] {
  if (!detail) return undefined;
  const safe: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (SENSITIVE_DETAIL_KEY.test(key)) continue;
    safe[key] = typeof value === "string" ? value.slice(0, 80) : value;
  }
  return safe;
}

type CounterKey = `${number | "none"}:${PermissionSignalKind}`;
const counters = new Map<CounterKey, number>();
const startedAt = new Date().toISOString();

// Repeated forbidden mutations: same user, method and route within a window.
const REPEAT_WINDOW_MS = 10 * 60 * 1000;
const REPEAT_THRESHOLD = 5;
const recentForbidden = new Map<string, number[]>();

export function recordPermissionSignal(signal: PermissionSignal, now: number = Date.now()): void {
  const path = sanitizeSignalPath(signal.path);
  const payload = {
    event: "permission_signal",
    kind: signal.kind,
    code: signal.code.slice(0, 80),
    companyId: signal.companyId ?? null,
    userId: signal.userId ?? null,
    role: signal.role ?? null,
    method: signal.method,
    path,
    detail: sanitizeDetail(signal.detail),
  };
  const message = `permission_signal ${signal.kind} ${payload.code}`;
  if (ERROR_KINDS.has(signal.kind)) logger.error(message, payload);
  else if (WARN_KINDS.has(signal.kind)) logger.warn(message, payload);
  else logger.info(message, payload);

  const escalation = ESCALATED[signal.kind];
  if (escalation) {
    const eventSummary = [signal.kind, payload.code].join(":");
    recordOperationalEvent({
      category: signal.kind === "permission_service_error" ? "error" : "integrity",
      code: `permission_${signal.kind}`,
      severity: escalation,
      message: eventSummary,
      method: signal.method,
      path,
      companyId: signal.companyId ?? undefined,
    });
  }

  const key: CounterKey = `${signal.companyId ?? "none"}:${signal.kind}`;
  counters.set(key, (counters.get(key) ?? 0) + 1);

  if (
    (signal.kind === "permission_denied" || signal.kind === "v2_enforcement_denied") &&
    signal.userId &&
    signal.method &&
    !["GET", "HEAD", "OPTIONS"].includes(signal.method.toUpperCase())
  ) {
    const repeatKey = `${signal.companyId ?? "none"}|${signal.userId}|${signal.method}|${path ?? ""}`;
    const recent = (recentForbidden.get(repeatKey) ?? []).filter((at) => now - at < REPEAT_WINDOW_MS);
    recent.push(now);
    recentForbidden.set(repeatKey, recent);
    if (recent.length === REPEAT_THRESHOLD) {
      recordPermissionSignal(
        {
          kind: "repeated_forbidden_mutation",
          code: "REPEATED_FORBIDDEN_MUTATION",
          companyId: signal.companyId,
          userId: signal.userId,
          role: signal.role,
          method: signal.method,
          path: signal.path,
          detail: { attempts: recent.length, windowMinutes: REPEAT_WINDOW_MS / 60000 },
        },
        now
      );
    }
    if (recentForbidden.size > 5000) recentForbidden.clear();
  }
}

/** Counters for one company (or all companies for a Developer view). */
export function permissionSignalCounts(companyId: number | null): {
  since: string;
  counts: Record<PermissionSignalKind, number>;
} {
  const counts = Object.fromEntries(PERMISSION_SIGNAL_KINDS.map((kind) => [kind, 0])) as Record<
    PermissionSignalKind,
    number
  >;
  for (const [key, value] of counters) {
    const [company, kind] = key.split(":") as [string, PermissionSignalKind];
    if (companyId === null || company === String(companyId)) counts[kind] += value;
  }
  return { since: startedAt, counts };
}

/** Thresholds and alert routing, for the monitoring endpoint (no secrets). */
export function permissionMonitoringConfiguration(env: NodeJS.ProcessEnv = process.env) {
  return {
    repeatedForbiddenMutation: { attempts: REPEAT_THRESHOLD, windowMinutes: REPEAT_WINDOW_MS / 60000 },
    escalatedKinds: Object.keys(ESCALATED),
    alertDestinationConfigured: env.LOG_ALERTS_ENABLED === "true" && Boolean(env.LOG_ALERT_WEBHOOK_URL?.trim()),
  };
}

export function _testOnly_resetPermissionSignals(): void {
  counters.clear();
  recentForbidden.clear();
}

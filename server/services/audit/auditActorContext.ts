/**
 * Phase 21 (A), AT2/AT4/AT6: who is acting, and on behalf of which request.
 *
 * One AsyncLocalStorage holds the audit actor and the request metadata for the
 * code running on behalf of a request or a scheduled job. It is separate from
 * the database scope context (databaseScopeRuntimeContext.ts) because many
 * paths open a nested tenant / authorized-companies scope; the actor survives
 * those nested scopes unchanged.
 *
 * The database reads it through transaction settings: every pool lease
 * (server/db.ts ensureDatabaseClientScope) writes
 *
 *   app.current_actor       the actor id (user id, or `system:<job>`)
 *   app.current_actor_name  the username shown on audit rows
 *   app.request_id          the request id (X-Request-Id)
 *   app.request_ip          the client IP
 *   app.session_hash        sha256 of the session id (never the id itself)
 *   app.audit_reason        a reason given by the caller (optional)
 *
 * on the connection before it is handed out, and clears them when the lease
 * has no context, exactly like the company scope. The audit trigger on
 * vouchers and voucher_entries (voucherAuditTrigger.ts) and the audit_log
 * BEFORE INSERT trigger read them. Set:
 *   - per request by auditRequestContextMiddleware (signed-in user or none);
 *   - per scheduled tick by createSchedulerTick (`system:<job>`);
 *   - by runInCompanyPostingScope(companyId, run, job) when no user acts;
 *   - for a stretch of work by runWithAuditReason / runWithAuditActor.
 * A lease taken before the context changes keeps the values it was leased
 * with: open the transaction inside the context.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

export interface AuditActorContext {
  /** Actor id: the signed-in user's id, or `system:<job>`. Empty = unknown. */
  actorId: string;
  /** Username shown on audit rows (falls back to the id). */
  actorName: string;
  requestId?: string | null;
  ip?: string | null;
  /** sha256 hex of the session id. */
  sessionHash?: string | null;
  reason?: string | null;
}

/** The database settings the audit triggers read (transaction / lease local). */
export const AUDIT_ACTOR_SETTINGS = {
  actorId: "app.current_actor",
  actorName: "app.current_actor_name",
  requestId: "app.request_id",
  ip: "app.request_ip",
  sessionHash: "app.session_hash",
  reason: "app.audit_reason",
} as const;

/** Stored by the database when no actor setting is present (counted by the integrity diagnostic). */
export const UNKNOWN_AUDIT_ACTOR = "unknown";
export const SYSTEM_AUDIT_ACTOR_PREFIX = "system:";

const MAX_FIELD_LENGTH = 200;
const MAX_REASON_LENGTH = 500;

const auditActorRuntime = new AsyncLocalStorage<AuditActorContext>();

function bounded(value: unknown, max = MAX_FIELD_LENGTH): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

/** sha256 hex of a session id; null for none. */
export function hashSessionId(sessionId: string | null | undefined): string | null {
  const id = bounded(sessionId, 1_000);
  return id ? createHash("sha256").update(id).digest("hex") : null;
}

export function runWithAuditActor<T>(context: AuditActorContext, callback: () => T): T {
  return auditActorRuntime.run(
    {
      actorId: bounded(context.actorId) ?? "",
      actorName: bounded(context.actorName) ?? bounded(context.actorId) ?? "",
      requestId: bounded(context.requestId),
      ip: bounded(context.ip),
      sessionHash: bounded(context.sessionHash),
      reason: bounded(context.reason, MAX_REASON_LENGTH),
    },
    callback
  );
}

export function getAuditActorContext(): AuditActorContext | undefined {
  return auditActorRuntime.getStore();
}

export function isSystemAuditActor(actorId: string | null | undefined): boolean {
  return String(actorId ?? "").startsWith(SYSTEM_AUDIT_ACTOR_PREFIX);
}

/**
 * Runs `callback` as the system job `job` (`system:<job>`), keeping the
 * request metadata. A signed-in user already acting stays the actor unless
 * `force` is set: a scheduled posting started from a request is the user's.
 */
export function runAsSystemAuditActor<T>(job: string, callback: () => T, options: { force?: boolean } = {}): T {
  const current = getAuditActorContext();
  if (current?.actorId && !isSystemAuditActor(current.actorId) && !options.force) return callback();
  const actorId = `${SYSTEM_AUDIT_ACTOR_PREFIX}${String(job).trim() || "job"}`;
  return runWithAuditActor({ ...(current ?? {}), actorId, actorName: actorId }, callback);
}

/** Runs `callback` with a reason recorded on every audit row it writes (database and application). */
export function runWithAuditReason<T>(reason: string, callback: () => T): T {
  const current = getAuditActorContext() ?? { actorId: "", actorName: "" };
  return runWithAuditActor({ ...current, reason }, callback);
}

/**
 * The current actor for an application audit row or a posting: the context's
 * actor, else `fallback`. Used where code had "system" / "unknown" literals.
 */
export function currentAuditActor(
  fallback: { userId: string; username: string } = { userId: UNKNOWN_AUDIT_ACTOR, username: UNKNOWN_AUDIT_ACTOR }
): { userId: string; username: string } {
  const current = getAuditActorContext();
  if (!current?.actorId) return fallback;
  return { userId: current.actorId, username: current.actorName || current.actorId };
}

/** The values the lease writes into the AUDIT_ACTOR_SETTINGS (empty strings clear them). */
export function auditActorSettingValues(): {
  signature: string;
  values: [string, string, string, string, string, string];
} {
  const current = getAuditActorContext();
  const values: [string, string, string, string, string, string] = [
    current?.actorId ?? "",
    current?.actorName ?? "",
    current?.requestId ?? "",
    current?.ip ?? "",
    current?.sessionHash ?? "",
    current?.reason ?? "",
  ];
  return { signature: current ? JSON.stringify(values) : "", values };
}

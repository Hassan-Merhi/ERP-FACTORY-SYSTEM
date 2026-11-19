// Extracted from ./browserSync.ts
import { type BrowserOperationRecord } from "../db";
import { offlineRetryDelay } from "./operationContract";
import { getBrowserOperation, openBrowserOperation, updateBrowserOperation, type BrowserActor } from "./browserOutbox";

export const COMMITTED = new Set(["cloud-applied", "already-present"]);

export interface BrowserSyncSummary {
  synced: number;
  conflicts: number;
  rejected: number;
  waiting: number;
  retried: number;
  /** Why delivery stopped early, if it did. */
  stopped: null | "paused" | "signed-out" | "offline" | "disabled" | "busy";
}

export function pauseKey(actor: BrowserActor): string {
  return `erp_offline_sync_paused:${actor.companyId}:${actor.userId}`;
}

export async function sessionActor(transport: typeof fetch): Promise<BrowserActor | null> {
  try {
    const [me, company] = await Promise.all([
      transport("/api/auth/me", { credentials: "include", cache: "no-store" }),
      transport("/api/auth/session-company", { credentials: "include", cache: "no-store" }),
    ]);
    if (!me.ok || !company.ok) return null;
    const user = (await me.json()) as { id?: unknown };
    const scope = (await company.json()) as { companyId?: unknown };
    const actor = { userId: String(user?.id ?? ""), companyId: Number(scope?.companyId) };
    return actor.userId && Number.isSafeInteger(actor.companyId) && actor.companyId > 0 ? actor : null;
  } catch {
    return null;
  }
}

export async function csrfToken(transport: typeof fetch): Promise<string | null> {
  try {
    const res = await transport("/api/csrf-token", { credentials: "include", cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { csrfToken?: unknown };
    return typeof body.csrfToken === "string" ? body.csrfToken : null;
  } catch {
    return null;
  }
}

export function backoff(record: BrowserOperationRecord, error: string): Partial<BrowserOperationRecord> {
  const attempts = record.attempts + 1;
  return { state: "pending", attempts, nextAttemptAt: Date.now() + offlineRetryDelay(attempts), lastError: error };
}

export async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const body = (await res.json()) as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Give a record up. If it was ever sent, the cloud records it as rejected so
 * records that depend on it fail cleanly; the cloud's data is not touched.
 */
export async function discardBrowserOperation(
  actor: BrowserActor,
  id: string,
  transport: typeof fetch = fetch
): Promise<"discarded" | "needs-connection"> {
  const record = await getBrowserOperation(actor, id);
  if (!record || record.state === "synced") return "discarded";
  if (record.attempts === 0 && record.state === "saved") {
    await updateBrowserOperation(actor, id, { state: "discarded", lastError: null });
    return "discarded";
  }
  try {
    const token = await csrfToken(transport);
    const res = await transport("/api/offline/browser-sync/operations/discard", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(token ? { "X-CSRF-Token": token } : {}) },
      body: JSON.stringify({
        deviceId: record.deviceId,
        operationId: record.id,
        kind: record.kind,
        localRef: record.localRef,
        capturedAt: record.capturedAt,
        input: await openBrowserOperation(actor, record),
      }),
    });
    const body = await readJson(res);
    if (res.ok && body.operationId === record.id) {
      const applied = COMMITTED.has(String(body.outcome));
      await updateBrowserOperation(actor, id, {
        state: applied ? "synced" : "discarded",
        outcome: String(body.outcome),
        cloudRef: typeof body.cloudRef === "number" ? body.cloudRef : null,
        lastError: applied ? "OFFLINE_ALREADY_APPLIED" : null,
      });
      return "discarded";
    }
    return "needs-connection";
  } catch {
    return "needs-connection";
  }
}

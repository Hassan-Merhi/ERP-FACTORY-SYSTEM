/**
 * Standalone browser offline mode (Phase 14): delivers the operations this
 * laptop saved offline straight to the cloud (/api/offline/browser-sync/*).
 *
 * - Only the signed-in user's records in the session's active company are sent;
 *   the session is re-checked against the server before every run.
 * - Each record keeps its operation id across attempts, so a lost
 *   acknowledgement or a crash mid-send returns the cloud's stored receipt
 *   instead of a second posting.
 * - A record counts as synced only when the cloud's receipt names this exact
 *   operation and kind with a committed outcome: a bare HTTP 2xx is not proof.
 * - Records in one stream go in the order they were saved; after a conflict or
 *   refusal, later records of that stream wait for the user's decision.
 * - Network and server failures retry with exponential backoff; an expired
 *   session pauses delivery; revoked access stops the record for review.
 * - The user can pause and resume delivery, retry, approve (Admin/Developer,
 *   overridable codes only) or discard.
 */
import { db, type BrowserOperationRecord } from "../db";
import { offlineRetryDelay } from "./operationContract";
import {
  getBrowserOperation,
  listBrowserOperations,
  openBrowserOperation,
  updateBrowserOperation,
  type BrowserActor,
} from "./browserOutbox";

const LEASE_MS = 2 * 60 * 1000;
const COMMITTED = new Set(["cloud-applied", "already-present"]);
let running = false;

export interface BrowserSyncSummary {
  synced: number;
  conflicts: number;
  rejected: number;
  waiting: number;
  retried: number;
  /** Why delivery stopped early, if it did. */
  stopped: null | "paused" | "signed-out" | "offline" | "disabled" | "busy";
}

function pauseKey(actor: BrowserActor): string {
  return `erp_offline_sync_paused:${actor.companyId}:${actor.userId}`;
}

export function isBrowserSyncPaused(actor: BrowserActor): boolean {
  try {
    return localStorage.getItem(pauseKey(actor)) === "1";
  } catch {
    return false;
  }
}

export function setBrowserSyncPaused(actor: BrowserActor, paused: boolean): void {
  try {
    if (paused) localStorage.setItem(pauseKey(actor), "1");
    else localStorage.removeItem(pauseKey(actor));
  } catch {
    // Storage blocked: delivery stays as it was.
  }
  window.dispatchEvent(new CustomEvent("erp:browser-sync-changed"));
}

async function sessionActor(transport: typeof fetch): Promise<BrowserActor | null> {
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

async function csrfToken(transport: typeof fetch): Promise<string | null> {
  try {
    const res = await transport("/api/csrf-token", { credentials: "include", cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { csrfToken?: unknown };
    return typeof body.csrfToken === "string" ? body.csrfToken : null;
  } catch {
    return null;
  }
}

async function claim(actor: BrowserActor, record: BrowserOperationRecord): Promise<BrowserOperationRecord | null> {
  return db.transaction("rw", db.browserOperations, async () => {
    const current = await db.browserOperations.get(record.id);
    if (!current || current.companyId !== actor.companyId || current.userId !== actor.userId) return null;
    const now = Date.now();
    if (!["saved", "pending", "waiting", "sending"].includes(current.state)) return null;
    if (current.nextAttemptAt > now) return null;
    // Another tab (or a run that crashed moments ago) is sending it: let that
    // lease expire first. Resending later is safe: the id is the same.
    if (current.state === "sending" && current.updatedAt + LEASE_MS > now) return null;
    const claimed: BrowserOperationRecord = { ...current, state: "sending", updatedAt: now };
    await db.browserOperations.put(claimed);
    return claimed;
  });
}

function backoff(record: BrowserOperationRecord, error: string): Partial<BrowserOperationRecord> {
  const attempts = record.attempts + 1;
  return { state: "pending", attempts, nextAttemptAt: Date.now() + offlineRetryDelay(attempts), lastError: error };
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const body = (await res.json()) as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Deliver this user's saved operations. Safe to call often; one run at a time per tab. */
export async function syncBrowserOperations(transport: typeof fetch = fetch): Promise<BrowserSyncSummary> {
  const summary: BrowserSyncSummary = { synced: 0, conflicts: 0, rejected: 0, waiting: 0, retried: 0, stopped: null };
  if (running) return { ...summary, stopped: "busy" };
  running = true;
  try {
    const actor = await sessionActor(transport);
    if (!actor) return { ...summary, stopped: "signed-out" };
    if (isBrowserSyncPaused(actor)) return { ...summary, stopped: "paused" };
    const records = await listBrowserOperations(actor, [
      "saved",
      "pending",
      "waiting",
      "sending",
      "conflict",
      "rejected",
      "needs_review",
    ]);
    if (!records.some((record) => ["saved", "pending", "waiting", "sending"].includes(record.state))) return summary;
    const token = await csrfToken(transport);
    const blocked = new Set<string>();

    for (const candidate of records) {
      if (blocked.has(candidate.stream)) continue;
      if (["conflict", "rejected", "needs_review"].includes(candidate.state)) {
        // Later records of this stream may depend on this one.
        blocked.add(candidate.stream);
        continue;
      }
      if (candidate.nextAttemptAt > Date.now()) {
        blocked.add(candidate.stream);
        continue;
      }
      const record = await claim(actor, candidate);
      if (!record) {
        blocked.add(candidate.stream);
        continue;
      }
      let input: Record<string, unknown>;
      try {
        input = await openBrowserOperation(actor, record);
      } catch {
        await updateBrowserOperation(actor, record.id, {
          state: "needs_review",
          lastError: "OFFLINE_RECORD_UNREADABLE",
        });
        summary.rejected += 1;
        blocked.add(record.stream);
        continue;
      }
      let res: Response;
      try {
        res = await transport("/api/offline/browser-sync/operations", {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { "X-CSRF-Token": token } : {}),
            "X-Idempotency-Key": record.id,
          },
          body: JSON.stringify({
            deviceId: record.deviceId,
            operationId: record.id,
            kind: record.kind,
            localRef: record.localRef,
            capturedAt: record.capturedAt,
            input,
            override: record.overrideCode,
          }),
        });
      } catch {
        // The connection dropped: the cloud may or may not have it. The same
        // operation id makes the next attempt safe either way.
        await updateBrowserOperation(actor, record.id, backoff(record, "OFFLINE_CONNECTION_LOST"));
        summary.retried += 1;
        return { ...summary, stopped: "offline" };
      }
      const body = await readJson(res);
      const code = typeof body.code === "string" ? body.code : `HTTP_${res.status}`;

      if (res.status === 200) {
        if (body.operationId === record.id && body.kind === record.kind && COMMITTED.has(String(body.outcome))) {
          await updateBrowserOperation(actor, record.id, {
            state: "synced",
            outcome: String(body.outcome),
            cloudRef: typeof body.cloudRef === "number" ? body.cloudRef : null,
            syncedAt: Date.now(),
            lastError: null,
            attempts: record.attempts + 1,
          });
          summary.synced += 1;
        } else if (body.operationId === record.id && body.outcome === "rejected-conflict") {
          await updateBrowserOperation(actor, record.id, {
            state: "discarded",
            outcome: "rejected-conflict",
            lastError: null,
          });
        } else {
          // A 2xx that does not prove this posting: never retried automatically.
          await updateBrowserOperation(actor, record.id, {
            state: "needs_review",
            lastError: "OFFLINE_RECEIPT_UNVERIFIED",
          });
          summary.rejected += 1;
          blocked.add(record.stream);
        }
        continue;
      }
      if (res.status === 202) {
        await updateBrowserOperation(actor, record.id, { ...backoff(record, code), state: "waiting" });
        summary.waiting += 1;
        continue;
      }
      if (res.status === 409) {
        const diverged = code === "OFFLINE_BROWSER_DIVERGENT_REPLAY";
        await updateBrowserOperation(actor, record.id, {
          state: diverged ? "needs_review" : "conflict",
          conflictCode: diverged ? null : code,
          conflictOverridable: body.overridable === true,
          overrideCode: null,
          lastError: code,
          attempts: record.attempts + 1,
        });
        summary.conflicts += 1;
        blocked.add(record.stream);
        continue;
      }
      if (res.status === 401) {
        await updateBrowserOperation(actor, record.id, { state: "pending", lastError: "OFFLINE_SIGN_IN_REQUIRED" });
        return { ...summary, stopped: "signed-out" };
      }
      if (res.status === 404 && code === "OFFLINE_BROWSER_SYNC_DISABLED") {
        await updateBrowserOperation(actor, record.id, { state: "pending", lastError: code });
        return { ...summary, stopped: "disabled" };
      }
      if (res.status === 403 || res.status === 422 || res.status === 400) {
        await updateBrowserOperation(actor, record.id, {
          state: code === "OFFLINE_BROWSER_DEVICE_BOUND" ? "needs_review" : "rejected",
          lastError: code,
          attempts: record.attempts + 1,
        });
        summary.rejected += 1;
        blocked.add(record.stream);
        continue;
      }
      // 408, 429, 5xx: the server could not decide now; try again later.
      await updateBrowserOperation(actor, record.id, backoff(record, code));
      summary.retried += 1;
      blocked.add(record.stream);
    }
    return summary;
  } finally {
    running = false;
    window.dispatchEvent(new CustomEvent("erp:browser-sync-changed"));
  }
}

/** Try a record again now (after a fix, or when the user asks). */
export async function retryBrowserOperation(actor: BrowserActor, id: string): Promise<void> {
  const record = await getBrowserOperation(actor, id);
  if (!record || record.state === "synced" || record.state === "discarded") return;
  await updateBrowserOperation(actor, id, {
    state:
      record.state === "conflict" || record.state === "rejected"
        ? "pending"
        : record.state === "saved"
          ? "saved"
          : "pending",
    nextAttemptAt: 0,
    lastError: null,
  });
}

/**
 * Apply a held record anyway (the laptop's version wins). Only codes the kind
 * declares overridable, and only Admin/Developer users: the cloud checks both
 * again before it writes anything.
 */
export async function approveBrowserOperation(actor: BrowserActor, id: string): Promise<void> {
  const record = await getBrowserOperation(actor, id);
  if (!record || record.state !== "conflict" || !record.conflictOverridable || !record.conflictCode) return;
  await updateBrowserOperation(actor, id, {
    state: "pending",
    overrideCode: record.conflictCode,
    nextAttemptAt: 0,
    lastError: null,
  });
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

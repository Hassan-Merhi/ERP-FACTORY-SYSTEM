import { getErrorDetails } from "@shared/errorUtils";
import { OFFLINE_MODE_ENABLED } from "./featureFlags";
import { db, appendSyncLog, upsertGlobalSyncState, addConflict, type SyncQueueItem } from "./db";
import { getQueue, removeFromQueue, updateItemStatus as updateLegacyStatus, setLastSynced } from "./offlineQueue";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_RETRY_COUNT = 5;
const BASE_BACKOFF_MS = 3_000;
const MAX_BACKOFF_MS = 120_000;

// ─── State ────────────────────────────────────────────────────────────────────

let syncInProgress = false;

export function isSyncInProgress(): boolean {
  return syncInProgress;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function emitSyncEvent(detail: {
  syncing?: boolean;
  lastSyncedAt?: number;
  error?: string;
  conflictDetected?: boolean;
}) {
  window.dispatchEvent(new CustomEvent("erp:sync", { detail }));
}

function calcNextRetryAt(retryCount: number): number {
  const backoff = Math.min(BASE_BACKOFF_MS * Math.pow(2, retryCount), MAX_BACKOFF_MS);
  return Date.now() + backoff;
}

type ErrorAction = "retry" | "permanent-fail" | "conflict" | "auth";

function classifyStatus(status: number): ErrorAction {
  if (status === 401) return "auth";
  if (status === 409) return "conflict";
  if (status >= 400 && status < 500) return "permanent-fail";
  return "retry";
}

// ─── IDB Queue Processor ─────────────────────────────────────────────────────

async function processIdbItem(item: SyncQueueItem): Promise<"ok" | "failed" | "conflict" | "auth" | "skipped"> {
  const now = Date.now();

  if (item.nextRetryAt && item.nextRetryAt > now) return "skipped";

  if (item.retryCount >= MAX_RETRY_COUNT) {
    if (item.status !== "failed") {
      await db.syncQueue.update(item.id!, {
        status: "failed",
        lastError: `Exceeded max retries (${MAX_RETRY_COUNT})`,
      });
    }
    return "failed";
  }

  try {
    const res = await fetch(item.url, {
      method: item.method,
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: item.payload || undefined,
    });

    if (res.status === 401) return "auth";

    if (res.ok) {
      await db.syncQueue.delete(item.id!);
      await appendSyncLog("item_success", `Synced: ${item.description}`, { url: item.url });
      return "ok";
    }

    const errText = await res.text().catch(() => `HTTP ${res.status}`);
    let errMsg = errText;
    try {
      errMsg = JSON.parse(errText)?.message || errText;
    } catch {
      // Malformed or absent payload — fall through to the default rather than surface a parse error.
    }

    const action = classifyStatus(res.status);

    if (action === "conflict") {
      await addConflict({
        syncQueueItemId: item.id ?? null,
        entityType: item.entityType,
        operation: item.operation,
        localPayload: item.payload,
        serverResponse: errText,
        conflictReason: errMsg || `HTTP 409 from ${item.url}`,
        url: item.url,
        method: item.method,
      });
      await db.syncQueue.delete(item.id!);
      await appendSyncLog("item_failed", `Conflict: ${item.description}`, { url: item.url, reason: errMsg });
      return "conflict";
    }

    if (action === "permanent-fail") {
      await db.syncQueue.update(item.id!, {
        status: "failed",
        lastError: errMsg,
        retryCount: MAX_RETRY_COUNT,
        nextRetryAt: Number.MAX_SAFE_INTEGER,
      });
      await appendSyncLog("item_failed", `Permanent fail: ${item.description}`, { url: item.url, error: errMsg });
      return "failed";
    }

    const newCount = (item.retryCount || 0) + 1;
    await db.syncQueue.update(item.id!, {
      status: newCount >= MAX_RETRY_COUNT ? "failed" : "pending",
      lastError: errMsg,
      retryCount: newCount,
      nextRetryAt: calcNextRetryAt(newCount),
    });
    await appendSyncLog("item_failed", `Retry ${newCount}/${MAX_RETRY_COUNT}: ${item.description}`, { url: item.url });
    return "failed";
  } catch (err) {
    const msg = getErrorDetails(err).optionalMessage || "Network error";
    const newCount = (item.retryCount || 0) + 1;
    await db.syncQueue.update(item.id!, {
      status: newCount >= MAX_RETRY_COUNT ? "failed" : "pending",
      lastError: msg,
      retryCount: newCount,
      nextRetryAt: calcNextRetryAt(newCount),
    });
    return "failed";
  }
}

// ─── Legacy localStorage Queue Processor ──────────────────────────────────────

async function processLegacyItem(item: ReturnType<typeof getQueue>[0]): Promise<"ok" | "failed" | "auth"> {
  try {
    const res = await fetch(item.url, {
      method: item.method,
      headers: {
        "Content-Type": "application/json",
        ...(item.clientDate ? { "X-Client-Date": item.clientDate } : {}),
      },
      credentials: "include",
      body: item.body || undefined,
    });

    if (res.status === 401) return "auth";

    if (res.ok) {
      removeFromQueue(item.id);
      return "ok";
    }

    const errText = await res.text().catch(() => `HTTP ${res.status}`);
    let errMsg = errText;
    try {
      errMsg = JSON.parse(errText)?.message || errText;
    } catch {
      // Malformed or absent payload — fall through to the default rather than surface a parse error.
    }
    updateLegacyStatus(item.id, "failed", errMsg);
    return "failed";
  } catch {
    updateLegacyStatus(item.id, "failed", "Network error");
    return "failed";
  }
}

// ─── Queue Deduplication ─────────────────────────────────────────────────────

export async function deduplicateQueue(): Promise<void> {
  try {
    const pending = await db.syncQueue.where("status").equals("pending").toArray();
    const seen = new Map<string, SyncQueueItem>();

    for (const item of pending) {
      if ((item.method === "PATCH" || item.method === "PUT") && item.id !== undefined) {
        const key = `${item.method}:${item.url}`;
        const prev = seen.get(key);
        if (prev && prev.id !== undefined) {
          if (item.id > prev.id) {
            await db.syncQueue.delete(prev.id);
            seen.set(key, item);
          } else {
            await db.syncQueue.delete(item.id);
          }
        } else {
          seen.set(key, item);
        }
      }
    }
  } catch {
    // Non-critical
  }
}

// ─── Main Sync Entry Point ────────────────────────────────────────────────────

export async function runSync(): Promise<void> {
  if (OFFLINE_MODE_ENABLED) {
    if (syncInProgress) return;
    syncInProgress = true;
    emitSyncEvent({ syncing: true });
    try {
      // The legacy localStorage/IDB replay engines are intentionally excluded
      // from the new offline mode: they do not have universal exactly-once
      // protection and may have no trustworthy actor identity.
      const { deliverOfflineOperations } = await import("./offline/durableOutbox");
      const result = await deliverOfflineOperations();
      const allClear =
        result.acknowledged > 0 &&
        !result.paused &&
        result.retried === 0 &&
        result.conflicts === 0 &&
        result.rejected === 0;
      emitSyncEvent({
        syncing: false,
        conflictDetected: result.conflicts > 0,
        ...(allClear ? { lastSyncedAt: Date.now() } : {}),
      });
    } catch (error) {
      emitSyncEvent({
        syncing: false,
        error: getErrorDetails(error).optionalMessage || "OFFLINE_DELIVERY_FAILED",
      });
    } finally {
      syncInProgress = false;
    }
    return;
  }
  if (syncInProgress) return;
  syncInProgress = true;
  emitSyncEvent({ syncing: true });

  await upsertGlobalSyncState({
    lastAttemptAt: Date.now(),
    status: "syncing",
    errorMessage: null,
  });
  await appendSyncLog("sync_start", "Sync started");

  let authFailed = false;
  let conflictDetected = false;
  let successCount = 0;
  let failCount = 0;

  try {
    // Dedup before processing
    await deduplicateQueue();

    // 1. Process IDB queue — only items past their backoff window
    const now = Date.now();
    const idbPending = await db.syncQueue.where("status").equals("pending").toArray();

    const readyItems = idbPending.filter((i) => !i.nextRetryAt || i.nextRetryAt <= now);

    for (const item of readyItems) {
      const result = await processIdbItem(item);
      if (result === "auth") {
        authFailed = true;
        break;
      }
      if (result === "ok") successCount++;
      if (result === "conflict") {
        conflictDetected = true;
      }
      if (result === "failed") failCount++;
    }

    // 2. Process legacy localStorage queue
    if (!authFailed) {
      const legacyPending = getQueue().filter((i) => i.status === "pending");
      for (const item of legacyPending) {
        const result = await processLegacyItem(item);
        if (result === "auth") {
          authFailed = true;
          break;
        }
        if (result === "ok") successCount++;
        if (result === "failed") failCount++;
      }
    }

    const ts = Date.now();
    setLastSynced();
    await upsertGlobalSyncState({
      lastSyncedAt: ts,
      lastAttemptAt: ts,
      status: "idle",
      errorMessage: null,
    });

    emitSyncEvent({ syncing: false, lastSyncedAt: ts, conflictDetected });
    await appendSyncLog(
      "sync_end",
      `Sync done: ${successCount} ok, ${failCount} failed${conflictDetected ? ", conflicts detected" : ""}`
    );
  } catch (err) {
    const msg = getErrorDetails(err).optionalMessage || "Sync error";
    await upsertGlobalSyncState({ status: "error", errorMessage: msg });
    emitSyncEvent({ syncing: false, error: msg });
    await appendSyncLog("error", `Sync error: ${msg}`);
  } finally {
    syncInProgress = false;
  }

  if (authFailed) {
    window.location.href = "/login";
  }
}

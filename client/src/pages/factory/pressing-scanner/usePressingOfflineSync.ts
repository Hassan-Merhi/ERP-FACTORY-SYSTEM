/**
 * Phase 5 queue controller. An accepted barcode is persisted before any HTTP.
 * Automatic retry is serialized per page, keeps the original requestId, and
 * revalidates the signed-in company+operator before posting queued data.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PressingScanCapture, PressingScanOutcome } from "../ContinuousPressingScanner";
import { sendQueuedPressingScan, type PressingTransportResult } from "./pressingConfirmClient";
import {
  enqueuePressingScan, listPressingScans, pressingRetryDelay, transitionPressingScan,
  type PressingActor, type PressingQueuedScan, type PressingPayload,
} from "./pressingOfflineQueue";

export interface PressingQueueSnapshot {
  items: PressingQueuedScan[];
  pending: number;
  syncing: number;
  confirmed: number;
  rejected: number;
  error: string | null;
  online: boolean;
}

const INITIAL: PressingQueueSnapshot = {
  items: [], pending: 0, syncing: 0, confirmed: 0, rejected: 0, error: null, online: true,
};

function outcomeFromRow(row: PressingQueuedScan): PressingScanOutcome {
  if (row.state === "confirmed" && row.receipt) {
    const receipt = row.receipt;
    return {
      kind: "confirmed",
      message: receipt.replayed
        ? "Pressing confirmation recovered; counted once"
        : "Pressing completed and saved",
      confirmedAt: receipt.confirmedAt,
      referenceNumber: receipt.referenceNumber,
      confirmationId: receipt.id,
      machineName: receipt.machineName,
      weightKg: receipt.weightKg,
      productionDate: receipt.productionDate,
      timezoneName: receipt.timezoneName,
    };
  }
  if (row.state === "rejected") {
    return {
      kind: row.errorCode === "PRESSING_ALREADY_CONFIRMED" ? "duplicate" : "rejected",
      message: row.lastError || "Pressing confirmation was rejected by the server",
      scannedBy: row.previousScan?.operatorName || row.previousScan?.operatorUserId,
    };
  }
  return {
    kind: "queued",
    message: "Saved on this device. Waiting for server confirmation — NOT yet counted.",
  };
}
function summarize(items: PressingQueuedScan[], error: string | null): PressingQueueSnapshot {
  return {
    items: [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    pending: items.filter(x => x.state === "pending").length,
    syncing: items.filter(x => x.state === "syncing").length,
    confirmed: items.filter(x => x.state === "confirmed").length,
    rejected: items.filter(x => x.state === "rejected").length,
    error, online: typeof navigator === "undefined" ? true : navigator.onLine,
  };
}
async function actorStillAuthenticated(actor: PressingActor): Promise<boolean> {
  try {
    const response = await fetch("/api/factory/pressing-machines/me", {
      credentials: "include", cache: "no-store",
    });
    if (!response.ok) return false;
    const current: unknown = await response.json();
    if (!current || typeof current !== "object") return false;
    const session = current as { companyId?: number; userId?: string };
    return session.companyId === actor.companyId && session.userId === actor.userId;
  } catch {
    return false;
  }
}
export function usePressingOfflineSync(actor: PressingActor | null, active: boolean) {
  const companyId = actor?.companyId ?? null;
  const userId = actor?.userId ?? null;
  const [snapshot, setSnapshot] = useState<PressingQueueSnapshot>(INITIAL);
  // A different company/user must NEVER see even one paint of prior queue state.
  const [snapshotScope, setSnapshotScope] = useState<string | null>(null);
  const busy = useRef(false);
  // All HTTP deliveries from this page run strictly one after another on this
  // chain, in capture order. A barcode scanned while an earlier scan is still
  // in flight waits its turn and still reports its REAL server outcome to the
  // scanner, instead of sitting amber until the 12-second poll.
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const scopeRef = useRef<string | null>(null);
  const scope = companyId !== null && userId ? companyId + ":" + userId : null;
  scopeRef.current = scope;

  const refresh = useCallback(async () => {
    if (companyId === null || !userId) return;
    const expected = companyId + ":" + userId;
    try {
      const items = await listPressingScans({ companyId, userId });
      if (scopeRef.current === expected) {
        setSnapshot(summarize(items, null));
        setSnapshotScope(expected);
      }
    } catch (error) {
      if (scopeRef.current === expected) {
        setSnapshot(prev => ({ ...prev, error: error instanceof Error ? error.message : "Offline queue unavailable" }));
        setSnapshotScope(expected);
      }
    }
  }, [companyId, userId]);

  const deliver = useCallback(async (
    actorValue: PressingActor, row: PressingQueuedScan,
  ): Promise<PressingQueuedScan> => {
    const changed = await transitionPressingScan(actorValue, row.requestId, "syncing", {
      attempts: row.attempts + 1, lastError: undefined, errorCode: undefined,
    });
    if (!changed) throw new Error("Saved pressing request disappeared. No new request was submitted.");
    if (changed.state === "confirmed" || changed.state === "rejected") return changed;
    const outcome: PressingTransportResult = await sendQueuedPressingScan(changed);
    if (outcome.kind === "confirmed") {
      const stored = await transitionPressingScan(actorValue, row.requestId, "confirmed", {
        receipt: outcome.receipt, nextAttemptAt: 0, lastError: undefined, errorCode: undefined,
      });
      return stored || changed;
    }
    if (outcome.kind === "rejected") {
      const stored = await transitionPressingScan(actorValue, row.requestId, "rejected", {
        lastError: outcome.message, errorCode: outcome.code,
        previousScan: outcome.previousScan, nextAttemptAt: 0,
      });
      return stored || changed;
    }
    const next = await transitionPressingScan(actorValue, row.requestId, "pending", {
      lastError: outcome.message, errorCode: outcome.code,
      nextAttemptAt: Date.now() + (outcome.needsAuth ? 60_000 : pressingRetryDelay(changed.attempts)),
    });
    return next || changed;
  }, []);

  // Serialize a unit of network work behind every earlier unit. The returned
  // promise settles with the work's own result once its turn completes.
  const serialized = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    const turn = chain.current.then(work, work);
    chain.current = turn.catch(() => undefined);
    return turn;
  }, []);

  const syncPending = useCallback(async (force = false) => {
    if (!active || companyId === null || !userId || busy.current) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    const identity = { companyId, userId };
    const key = companyId + ":" + userId;
    busy.current = true;
    try {
      const authenticated = await serialized(async () => {
        if (scopeRef.current !== key) return true;
        if (!(await actorStillAuthenticated(identity))) {
          if (scopeRef.current === key) setSnapshot(prev => ({
            ...prev, error: "Saved scans paused: reconnect as the original company and operator.",
          }));
          return false;
        }
        const rows = await listPressingScans(identity);
        // Recover rows stranded in SYNCING by a crashed browser. These are safe to
        // replay with their original immutable idempotency key.
        for (const row of rows.filter(r => (r.state === "pending" || r.state === "syncing") &&
          (force || r.nextAttemptAt <= Date.now())).slice(0, 8)) {
          if (scopeRef.current !== key || (typeof navigator !== "undefined" && !navigator.onLine)) break;
          const outcome = await deliver(identity, row);
          if (outcome.state === "pending") break; // avoid repeated network hammering
        }
        return true;
      });
      // A paused queue keeps its warning visible; refresh would clear it.
      if (authenticated) await refresh();
    } catch (error) {
      if (scopeRef.current === key) setSnapshot(prev => ({
        ...prev, error: error instanceof Error ? error.message : "Could not sync saved pressing scans",
      }));
    } finally {
      busy.current = false;
    }
  }, [active, companyId, userId, deliver, refresh, serialized]);

  const submit = useCallback(async (capture: PressingScanCapture): Promise<PressingScanOutcome> => {
    if (companyId === null || !userId || !active) {
      return { kind: "rejected", message: "No authenticated pressing operator or active scanner. Nothing was submitted." };
    }
    const identity = { companyId, userId };
    const payload: PressingPayload = {
      barcode: capture.barcode.trim().toUpperCase(),
      assignmentId: capture.assignmentId,
      machineId: capture.machineId,
      deviceCapturedAt: capture.deviceCapturedAt,
      requestId: crypto.randomUUID(),
    };
    try {
      // Atomic durable write must succeed BEFORE the request is sent.
      const { record, existing } = await enqueuePressingScan(identity, payload);
      await refresh();
      if (existing) {
        return {
          kind: "queued",
          message: "This barcode already has a pending scan saved on this device. It will not be counted twice.",
        };
      }
      if (typeof navigator !== "undefined" && !navigator.onLine) return outcomeFromRow(record);
      // Wait for any in-flight delivery, then send THIS saved request with its
      // immutable ID. If a background pass already settled it, deliver() sees
      // the terminal row and returns it without a second POST.
      try {
        const settled = await serialized(async () => {
          if (scopeRef.current !== identity.companyId + ":" + identity.userId) return record;
          if (typeof navigator !== "undefined" && !navigator.onLine) return record;
          if (!(await actorStillAuthenticated(identity))) {
            setSnapshot(prev => ({ ...prev,
              error: "Scan stored but not submitted. Confirm the original operator and company session." }));
            return record;
          }
          // A background pass may have handled this row while we waited our
          // turn: respect its terminal state or its retry backoff instead of
          // posting the same request ID again immediately.
          const current = (await listPressingScans(identity)).find(r => r.requestId === record.requestId) ?? record;
          if (current.state !== "pending" || (current.attempts > 0 && current.nextAttemptAt > Date.now())) return current;
          return deliver(identity, current);
        });
        return outcomeFromRow(settled);
      } finally {
        await refresh();
      }
    } catch (error) {
      return {
        kind: "rejected",
        message: (error instanceof Error ? error.message : "Could not save barcode") +
          " No new pressing confirmation can be assumed. Check connection and local storage.",
      };
    }
  }, [active, companyId, userId, deliver, refresh, serialized]);

  useEffect(() => {
    setSnapshot(INITIAL); // never show the previous user's/company's local queue
    setSnapshotScope(null);
    if (!scope) return;
    void refresh();
  }, [scope, refresh]);

  useEffect(() => {
    if (!active || !scope) return;
    const run = () => {
      if (!document.hidden) void syncPending();
    };
    const onOnline = () => {
      setSnapshot(prev => ({ ...prev, online: true }));
      run();
    };
    const onOffline = () => setSnapshot(prev => ({ ...prev, online: false }));
    const onVisibility = () => { if (!document.hidden) run(); };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisibility);
    const timer = window.setInterval(run, 12_000);
    run();
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(timer);
    };
  }, [scope, active, syncPending]);

  return {
    snapshot: snapshotScope === scope ? snapshot : INITIAL,
    submit,
    refresh,
    retryNow: () => syncPending(true),
  };
}

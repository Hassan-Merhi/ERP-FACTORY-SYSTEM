import { createContext, useContext, useEffect, useState, useRef, useCallback, type ReactNode } from "react";
import { OFFLINE_MODE_ENABLED } from "@/lib/featureFlags";
import { queryClient } from "@/lib/queryClient";
import {
  getBrowserConnection,
  getConnectivityPollDelay,
  getQueueRefreshDelay,
  isDocumentVisible,
  runWhenIdle,
} from "@/lib/mobilePerformance";

export type ConnectivityStatus = "online" | "offline" | "syncing" | "error";

interface ConnectivityContextValue {
  status: ConnectivityStatus;
  isOnline: boolean;
  isSyncing: boolean;
  lastSyncedAt: number | null;
  pendingCount: number;
  failedCount: number;
  conflictCount: number;
  triggerSync: () => void;
  refreshCounts: () => Promise<void>;
}

const ConnectivityContext = createContext<ConnectivityContextValue>({
  status: "online",
  isOnline: true,
  isSyncing: false,
  lastSyncedAt: null,
  pendingCount: 0,
  failedCount: 0,
  conflictCount: 0,
  triggerSync: () => {},
  refreshCounts: async () => {},
});

export function useConnectivity(): ConnectivityContextValue {
  return useContext(ConnectivityContext);
}

const PING_TIMEOUT_MS = 5_000;

async function pingServer(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
    const res = await fetch("/api/health", {
      credentials: "include",
      signal: controller.signal,
      cache: "no-store",
    });
    window.clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

interface Props {
  children: ReactNode;
}

function StubConnectivityProvider({ children }: Props) {
  return (
    <ConnectivityContext.Provider
      value={{
        status: "online",
        isOnline: true,
        isSyncing: false,
        lastSyncedAt: null,
        pendingCount: 0,
        failedCount: 0,
        conflictCount: 0,
        triggerSync: () => {},
        refreshCounts: async () => {},
      }}
    >
      {children}
    </ConnectivityContext.Provider>
  );
}

function FullConnectivityProvider({ children }: Props) {
  const [isOnline, setIsOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [conflictCount, setConflictCount] = useState(0);
  const isMountedRef = useRef(true);
  const onlineRef = useRef(isOnline);

  useEffect(() => {
    onlineRef.current = isOnline;
  }, [isOnline]);

  useEffect(() => {
    isMountedRef.current = true;
    import("@/lib/db").then(({ getGlobalSyncState }) =>
      getGlobalSyncState()
        .then((state) => {
          if (isMountedRef.current && state?.lastSyncedAt) {
            setLastSyncedAt(state.lastSyncedAt);
          }
        })
        .catch(() => {})
    );
    if (navigator.onLine) {
      import("@/lib/refPool").then(({ ensurePoolReady }) => ensurePoolReady()).catch(() => {});
    }
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const refreshCounts = useCallback(async () => {
    try {
      const { db, getConflictCount } = await import("@/lib/db");
      const { getQueue } = await import("@/lib/offlineQueue");
      const { getVerifiedOfflineReadScope } = await import("@/lib/offline/offlineReadCache");
      const { listOfflineOperations } = await import("@/lib/offline/durableOutbox");
      const actor = getVerifiedOfflineReadScope();
      const [legacyIdbCount, conflicts, durable] = await Promise.all([
        db.syncQueue.count(),
        getConflictCount(),
        actor ? listOfflineOperations(actor) : Promise.resolve([]),
      ]);
      const currentActor = getVerifiedOfflineReadScope();
      // Discard stale async counts if a company switch or logout occurred.
      const sameScope = !!actor && !!currentActor &&
        actor.companyId === currentActor.companyId && actor.userId === currentActor.userId;
      const owned = sameScope ? durable : [];
      const pending = owned.filter((item) => item.state === "pending" || item.state === "sending").length;
      const review = owned.filter((item) =>
        item.state === "conflict" || item.state === "rejected" || item.state === "needs_review").length;
      const blockedLegacy = legacyIdbCount + getQueue().length;
      if (isMountedRef.current) {
        // Legacy records must NEVER appear as "pending sync": only the vetted
        // actor-scoped outbox is auto-replayable. Keep the old count visible as
        // blocked for supervised recovery, without exposing record content.
        setPendingCount(pending);
        setFailedCount(review + blockedLegacy);
        setConflictCount(conflicts + owned.filter((item) => item.state === "conflict").length);
      }
    } catch {
      // Offline queue counts are advisory and must never block the app shell.
    }
  }, []);

  const triggerSync = useCallback(() => {
    import("@/lib/syncEngine").then(({ runSync }) => runSync()).catch(() => {});
  }, []);

  useEffect(() => {
    let stopped = false;
    let pollTimer: number | undefined;
    let pollInFlight = false;
    const connection = getBrowserConnection();

    const appendLog = (status: "online" | "offline", message: string) => {
      import("@/lib/db").then(({ appendSyncLog }) => appendSyncLog(status, message)).catch(() => {});
    };

    const applyConnectivity = (alive: boolean, source: string) => {
      if (stopped || !isMountedRef.current) return;
      const changed = onlineRef.current !== alive;
      onlineRef.current = alive;
      setIsOnline(alive);
      if (!changed) return;

      if (alive) {
        appendLog("online", `Connection restored (${source})`);
        triggerSync();
        import("@/lib/refPool").then(({ ensurePoolReady }) => ensurePoolReady()).catch(() => {});
      } else {
        appendLog("offline", `Connection lost (${source})`);
      }
    };

    const schedulePoll = (delay?: number) => {
      if (stopped) return;
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
      pollTimer = window.setTimeout(
        () => void runPoll(),
        delay ?? getConnectivityPollDelay({ isOnline: onlineRef.current })
      );
    };

    const runPoll = async () => {
      if (stopped || pollInFlight) return;

      // Browser online/offline events remain authoritative while a healthy tab is
      // hidden. Avoid waking the radio only to reconfirm an already-online state.
      if (!isDocumentVisible() && navigator.onLine && onlineRef.current) {
        schedulePoll();
        return;
      }

      pollInFlight = true;
      const alive = navigator.onLine ? await pingServer() : false;
      pollInFlight = false;
      applyConnectivity(alive, "health check");
      schedulePoll();
    };

    const handleOnline = () => schedulePoll(0);
    const handleOffline = () => applyConnectivity(false, "browser event");
    const handleVisibility = () => {
      if (isDocumentVisible()) schedulePoll(0);
      else schedulePoll();
    };
    const handleConnectionProfile = () => schedulePoll();

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("erp:app-visible", handleVisibility);
    connection?.addEventListener?.("change", handleConnectionProfile);
    schedulePoll(0);

    return () => {
      stopped = true;
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("erp:app-visible", handleVisibility);
      connection?.removeEventListener?.("change", handleConnectionProfile);
    };
  }, [triggerSync]);

  useEffect(() => {
    let stopped = false;
    let countTimer: number | undefined;

    const scheduleCounts = (delay?: number) => {
      if (stopped) return;
      if (countTimer !== undefined) window.clearTimeout(countTimer);
      countTimer = window.setTimeout(() => void runCounts(), delay ?? getQueueRefreshDelay());
    };

    const runCounts = async () => {
      if (stopped) return;
      await refreshCounts();
      scheduleCounts();
    };

    const refreshSoon = () => scheduleCounts(isDocumentVisible() ? 0 : getQueueRefreshDelay(false));

    window.addEventListener("storage", refreshSoon);
    window.addEventListener("erp:app-visible", refreshSoon);
    window.addEventListener("erp:offline-queue-changed", refreshSoon);
    scheduleCounts(0);

    return () => {
      stopped = true;
      if (countTimer !== undefined) window.clearTimeout(countTimer);
      window.removeEventListener("storage", refreshSoon);
      window.removeEventListener("erp:app-visible", refreshSoon);
      window.removeEventListener("erp:offline-queue-changed", refreshSoon);
    };
  }, [refreshCounts]);

  useEffect(() => {
    const handler = async (event: Event) => {
      const evt = event as CustomEvent<{
        syncing?: boolean;
        lastSyncedAt?: number;
        error?: string;
        conflictDetected?: boolean;
      }>;
      if (!isMountedRef.current) return;
      if (evt.detail.syncing !== undefined) setIsSyncing(evt.detail.syncing);
      if (evt.detail.lastSyncedAt) {
        setLastSyncedAt(evt.detail.lastSyncedAt);
        const { upsertGlobalSyncState } = await import("@/lib/db");
        void upsertGlobalSyncState({ lastSyncedAt: evt.detail.lastSyncedAt });
        runWhenIdle(() => {
          // Let in-flight requests land rather than aborting and restarting
          // them; the queued writes have just been flushed, so a refetch of
          // everything not already loading is enough.
          void queryClient.invalidateQueries({ refetchType: "active" }, { cancelRefetch: false });
        });
      }
      void refreshCounts();
    };
    window.addEventListener("erp:sync", handler);
    return () => window.removeEventListener("erp:sync", handler);
  }, [refreshCounts]);

  const status: ConnectivityStatus = !isOnline ? "offline" : isSyncing ? "syncing" : "online";

  return (
    <ConnectivityContext.Provider
      value={{
        status,
        isOnline,
        isSyncing,
        lastSyncedAt,
        pendingCount,
        failedCount,
        conflictCount,
        triggerSync,
        refreshCounts,
      }}
    >
      {children}
    </ConnectivityContext.Provider>
  );
}

export function ConnectivityProvider({ children }: Props) {
  if (!OFFLINE_MODE_ENABLED) return <StubConnectivityProvider>{children}</StubConnectivityProvider>;
  return <FullConnectivityProvider>{children}</FullConnectivityProvider>;
}

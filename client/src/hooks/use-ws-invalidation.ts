import { useEffect } from "react";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";

// Heavy analytical queries that are intentionally excluded from blanket WS invalidation.
// These are expensive to compute, have a manual Refresh button, and should not jump
// around every time any write happens anywhere in the system.
const STABLE_QUERY_PREFIXES = [
  "/api/auth/me", // staleTime=Infinity on purpose — spurious auth re-checks cause login redirects
  "/api/stats/net-profit", // full balance-sheet computation; user refreshes manually
  "/api/reports/net-profit-statement", // P&L report; heavy computation
  "/api/balance-sheet", // balance sheet; heavy computation
  "/api/factory/v5/stock-allocation", // ~543 KB response; refresh explicitly after allocation-affecting mutations/manual refresh
];

// A burst of writes — an import, a POS rush, a bulk edit — used to produce a
// round of refetching every 800ms. Nobody reads numbers that fast, and each
// round costs one request per query on screen.
const INVALIDATE_DEBOUNCE_MS = 3_000;
const RECONNECT_BASE_DELAY_MS = 1_500;
const RECONNECT_MAX_DELAY_MS = 30_000;
const OFFLINE_PROBE_DELAY_MS = 30_000;
const RECONNECT_JITTER_RATIO = 0.2;

// Multiple React surfaces may mount this hook in the same browser tab. Keep a
// single module-level socket and reference-count subscribers by QueryClient so
// child-first effect ordering cannot steal ownership from the app shell. The
// socket lives until the last subscriber unmounts.
const subscribers = new Map<QueryClient, number>();
let sharedSocket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let managerRunning = false;
let hadSuccessfulConnection = false;
let firstConnectionDelayed = false;
let missedWhileHidden = false;
let reconnectAttempt = 0;

function shouldInvalidateQuery(query: { queryKey: readonly unknown[] }): boolean {
  const key = query.queryKey[0];
  if (typeof key !== "string") return true;
  return !STABLE_QUERY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function runInvalidation(): void {
  if (!managerRunning) return;
  for (const queryClient of subscribers.keys()) {
    void queryClient.invalidateQueries(
      {
        refetchType: "active",
        predicate: shouldInvalidateQuery,
      },
      // Do not abort requests that are already on their way. This fires
      // whenever anyone anywhere writes anything, so with the default
      // (cancelRefetch: true) every in-flight request on screen is
      // aborted and restarted several times a minute — the work is
      // thrown away, the request count doubles, and the aborts surface
      // as load failures. A request issued moments ago is fresh enough;
      // let it land and refetch the rest.
      { cancelRefetch: false }
    );
  }
}

function handleInvalidate(): void {
  // Nobody is reading a hidden tab, and people leave several open. Refetching
  // there spends a request per query on screen for a screen nobody is looking
  // at. Remember that something changed and refresh on the way back instead.
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    missedWhileHidden = true;
    return;
  }

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    runInvalidation();
  }, INVALIDATE_DEBOUNCE_MS);
}

function handleVisibilityChange(): void {
  if (document.visibilityState !== "visible" || !missedWhileHidden) return;
  missedWhileHidden = false;
  runInvalidation();
}

function websocketTarget(): string {
  const capacitorWsUrl: string = (import.meta.env?.VITE_WS_URL as string) || "";
  if (capacitorWsUrl) return capacitorWsUrl;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

function browserIsOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

export function computeWsReconnectDelayMs(attempt: number, randomValue = Math.random()): number {
  const normalizedAttempt = Math.max(0, Math.min(10, Math.floor(attempt)));
  const exponential = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** normalizedAttempt);
  const boundedRandom = Math.max(0, Math.min(1, randomValue));
  const jitterMultiplier = 1 + (boundedRandom * 2 - 1) * RECONNECT_JITTER_RATIO;
  return Math.max(1_000, Math.min(RECONNECT_MAX_DELAY_MS, Math.round(exponential * jitterMultiplier)));
}

function connectSharedSocket(allowOfflineProbe = false): void {
  if (!managerRunning || subscribers.size === 0 || sharedSocket) return;
  if (!browserIsOnline() && !allowOfflineProbe) {
    if (!hadSuccessfulConnection) firstConnectionDelayed = true;
    scheduleReconnect();
    return;
  }
  reconnectTimer = null;

  const socket = new WebSocket(websocketTarget());
  sharedSocket = socket;

  socket.onopen = () => {
    if (sharedSocket !== socket || !managerRunning) return;
    const shouldCatchUp = hadSuccessfulConnection || firstConnectionDelayed;
    reconnectAttempt = 0;
    firstConnectionDelayed = false;
    if (shouldCatchUp) handleInvalidate();
    hadSuccessfulConnection = true;
  };

  socket.onmessage = (event) => {
    if (sharedSocket !== socket || !managerRunning) return;
    try {
      const msg = JSON.parse(event.data as string);
      if (msg.type === "invalidate") handleInvalidate();
    } catch {
      // Malformed or absent payload — ignore rather than surface a parse error.
    }
  };

  socket.onclose = () => {
    // An old socket can close after the manager has already been stopped and
    // restarted. Only the currently registered socket may schedule a reconnect.
    if (sharedSocket !== socket) return;
    sharedSocket = null;
    scheduleReconnect();
  };

  socket.onerror = () => {
    socket.close();
  };
}

function scheduleReconnect(): void {
  if (!managerRunning || subscribers.size === 0 || reconnectTimer) return;
  const online = browserIsOnline();
  const delayMs = online ? computeWsReconnectDelayMs(reconnectAttempt) : OFFLINE_PROBE_DELAY_MS;
  reconnectAttempt = online ? Math.min(reconnectAttempt + 1, 10) : 0;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectSharedSocket(!browserIsOnline());
  }, delayMs);
}

function handleOnline(): void {
  if (!managerRunning || subscribers.size === 0 || sharedSocket) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectAttempt = 0;
  connectSharedSocket();
}

function handleOffline(): void {
  if (!managerRunning) return;
  reconnectAttempt = 0;

  // navigator.onLine is only a hint. If the existing socket is healthy, keep it
  // open so a false/transient offline event cannot create a 30-second blackout.
  if (sharedSocket) {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    return;
  }

  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (!hadSuccessfulConnection) firstConnectionDelayed = true;
  scheduleReconnect();
}

function startManager(): void {
  if (managerRunning) return;
  managerRunning = true;
  hadSuccessfulConnection = false;
  firstConnectionDelayed = false;
  missedWhileHidden = false;
  reconnectAttempt = 0;
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("online", handleOnline);
  window.addEventListener("offline", handleOffline);
  connectSharedSocket();
}

function stopManager(): void {
  if (!managerRunning && !sharedSocket && !reconnectTimer && !debounceTimer) return;
  managerRunning = false;
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  window.removeEventListener("online", handleOnline);
  window.removeEventListener("offline", handleOffline);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (debounceTimer) clearTimeout(debounceTimer);
  reconnectTimer = null;
  debounceTimer = null;
  reconnectAttempt = 0;
  hadSuccessfulConnection = false;
  firstConnectionDelayed = false;
  missedWhileHidden = false;

  const socket = sharedSocket;
  sharedSocket = null;
  socket?.close();
}

function subscribe(queryClient: QueryClient): () => void {
  const current = subscribers.get(queryClient) ?? 0;
  subscribers.set(queryClient, current + 1);
  if (!managerRunning) startManager();

  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    const count = subscribers.get(queryClient) ?? 0;
    if (count <= 1) subscribers.delete(queryClient);
    else subscribers.set(queryClient, count - 1);
    if (subscribers.size === 0) stopManager();
  };
}

export function resetWsInvalidationManagerForTests(): void {
  subscribers.clear();
  stopManager();
}

export function useWsInvalidation() {
  const queryClient = useQueryClient();
  useEffect(() => subscribe(queryClient), [queryClient]);
}

import { useEffect } from "react";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { parseRealtimeInvalidationMessage, type RealtimeInvalidationMessage } from "@shared/realtimeInvalidation";
import { parseRealtimeChatEvent, type RealtimeChatEvent } from "@shared/realtimeChat";
import { invalidateBandwidthReadCaches } from "@/lib/bandwidthInvalidationPolicy";
import { getRealtimeClientId } from "@/lib/realtimeClientIdentity";
import {
  INVALIDATE_DEBOUNCE_MS,
  OFFLINE_PROBE_DELAY_MS,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_JITTER_RATIO,
  RECONNECT_MAX_DELAY_MS,
  bandwidthScopeFor,
  createPendingInvalidation,
  mergePendingInvalidation,
  pendingInvalidation,
  queryMatchesPendingInvalidation,
  resetPendingInvalidation,
  setRealtimeConnectionStatus,
  subscribers,
  type PendingInvalidation,
} from "./queryMatchesPendingInvalidation";
const chatEventSubscribers = new Set<(event: RealtimeChatEvent) => void>();
let sharedSocket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let managerRunning = false;
let hadSuccessfulConnection = false;
let firstConnectionDelayed = false;
let missedWhileHidden = false;
let reconnectAttempt = 0;

export function isRealtimeReadyMessage(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    (payload as { type?: unknown }).type === "realtime:ready"
  );
}

function invalidateActiveQueries(invalidation: PendingInvalidation): void {
  if (!managerRunning) return;

  // Must run before the refetch below: a cached snapshot would otherwise answer
  // it without a request, and the screen would keep the pre-write numbers until
  // the entry expired on its own.
  invalidateBandwidthReadCaches(bandwidthScopeFor(invalidation));

  for (const queryClient of subscribers.keys()) {
    void queryClient.invalidateQueries(
      {
        refetchType: "active",
        predicate: (query) => queryMatchesPendingInvalidation(query, invalidation),
      },
      // A realtime signal can arrive while a request is already on its way.
      // Let that request land instead of aborting and duplicating the work.
      { cancelRefetch: false }
    );
  }
}

function invalidateChatMetadata(): void {
  if (!managerRunning) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    missedWhileHidden = true;
    return;
  }

  // The unread-count snapshot is cached for the same reason and by the same
  // guard, and a message from someone else never clears it locally.
  invalidateBandwidthReadCaches("live");

  for (const queryClient of subscribers.keys()) {
    void queryClient.invalidateQueries(
      {
        refetchType: "active",
        predicate: (query) => {
          const key = query.queryKey[0];
          return key === "/api/chat/users" || key === "/api/chat/unread-count";
        },
      },
      { cancelRefetch: false }
    );
  }
}

function flushPendingInvalidation(): void {
  if (!pendingInvalidation.blanket && pendingInvalidation.topics.size === 0) return;
  const invalidation = pendingInvalidation;
  resetPendingInvalidation();
  invalidateActiveQueries(invalidation);
}

function runCatchUpInvalidation(): void {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    missedWhileHidden = true;
    return;
  }

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  resetPendingInvalidation();

  const blanket = createPendingInvalidation();
  blanket.blanket = true;
  invalidateActiveQueries(blanket);
}

function handleInvalidate(message: RealtimeInvalidationMessage): void {
  // Nobody is reading a hidden tab, and people leave several open. Refetching
  // there spends a request per query on screen for a screen nobody is looking
  // at. Remember that something changed and refresh once on the way back.
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    missedWhileHidden = true;
    return;
  }

  mergePendingInvalidation(message);
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    flushPendingInvalidation();
  }, INVALIDATE_DEBOUNCE_MS);
}

function dispatchChatEvent(event: RealtimeChatEvent): void {
  if (event.type !== "typing:update") invalidateChatMetadata();
  for (const subscriber of chatEventSubscribers) subscriber(event);
}

function handleVisibilityChange(): void {
  if (document.visibilityState !== "visible" || !missedWhileHidden) return;
  missedWhileHidden = false;
  runCatchUpInvalidation();
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
    setRealtimeConnectionStatus("disconnected");
    scheduleReconnect();
    return;
  }
  reconnectTimer = null;

  setRealtimeConnectionStatus("connecting");
  const socket = new WebSocket(websocketTarget());
  sharedSocket = socket;

  socket.onopen = () => {
    if (sharedSocket !== socket || !managerRunning) return;
    try {
      socket.send(JSON.stringify({ type: "realtime:identify", clientId: getRealtimeClientId() }));
    } catch {
      // Identification is a bandwidth optimization only; realtime still works
      // normally if an older/mock transport cannot send this handshake.
    }
    const shouldCatchUp = hadSuccessfulConnection || firstConnectionDelayed;
    reconnectAttempt = 0;
    firstConnectionDelayed = false;
    if (shouldCatchUp) runCatchUpInvalidation();
    hadSuccessfulConnection = true;
  };

  socket.onmessage = (event) => {
    if (sharedSocket !== socket || !managerRunning) return;
    try {
      const payload = JSON.parse(event.data as string) as unknown;
      if (isRealtimeReadyMessage(payload)) {
        setRealtimeConnectionStatus("ready");
        return;
      }
      const invalidation = parseRealtimeInvalidationMessage(payload);
      if (invalidation) handleInvalidate(invalidation);
      const chatEvent = parseRealtimeChatEvent(payload);
      if (chatEvent) dispatchChatEvent(chatEvent);
    } catch {
      // Malformed or absent payload — ignore rather than surface a parse error.
    }
  };

  socket.onclose = () => {
    // An old socket can close after the manager has already been stopped and
    // restarted. Only the currently registered socket may schedule a reconnect.
    if (sharedSocket !== socket) return;
    sharedSocket = null;
    setRealtimeConnectionStatus("disconnected");
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
  setRealtimeConnectionStatus("disconnected");
  scheduleReconnect();
}

/**
 * The server captures company/user scope when a WebSocket connects. Company
 * switching no longer reloads the browser, so a successful session switch must
 * replace the existing socket immediately or it would keep listening to the old
 * company. Pending old-company invalidations are discarded and the replacement
 * connection performs one catch-up refresh.
 */
export function refreshRealtimeSessionScope(): void {
  if (!managerRunning || subscribers.size === 0) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (debounceTimer) clearTimeout(debounceTimer);
  reconnectTimer = null;
  debounceTimer = null;
  reconnectAttempt = 0;
  firstConnectionDelayed = true;
  missedWhileHidden = false;
  resetPendingInvalidation();

  const socket = sharedSocket;
  sharedSocket = null;
  setRealtimeConnectionStatus("connecting");
  socket?.close(1000, "Session scope changed");
  connectSharedSocket();
}

function startManager(): void {
  if (managerRunning) return;
  managerRunning = true;
  hadSuccessfulConnection = false;
  firstConnectionDelayed = false;
  missedWhileHidden = false;
  reconnectAttempt = 0;
  resetPendingInvalidation();
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
  resetPendingInvalidation();
  setRealtimeConnectionStatus("disconnected");

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

export function subscribeRealtimeChatEvents(handler: (event: RealtimeChatEvent) => void): () => void {
  chatEventSubscribers.add(handler);
  return () => chatEventSubscribers.delete(handler);
}

export function resetWsInvalidationManagerForTests(): void {
  subscribers.clear();
  chatEventSubscribers.clear();
  stopManager();
}

export function useWsInvalidation() {
  const queryClient = useQueryClient();
  useEffect(() => subscribe(queryClient), [queryClient]);
}

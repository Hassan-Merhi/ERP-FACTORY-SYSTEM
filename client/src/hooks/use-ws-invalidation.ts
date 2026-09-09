import { useEffect } from "react";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import {
  parseRealtimeInvalidationMessage,
  type RealtimeInvalidationMessage,
  type RealtimeInvalidationTopic,
} from "@shared/realtimeInvalidation";
import { parseRealtimeChatEvent, type RealtimeChatEvent } from "@shared/realtimeChat";

// Heavy analytical queries that are intentionally excluded from automatic WS invalidation.
// These are expensive to compute, have a manual Refresh button, and should not jump
// around every time any write happens anywhere in the system.
const STABLE_QUERY_PREFIXES = [
  "/api/auth/me", // staleTime=Infinity on purpose — spurious auth re-checks cause login redirects
  "/api/stats/net-profit", // full balance-sheet computation; user refreshes manually
  "/api/reports/net-profit-statement", // P&L report; heavy computation
  "/api/balance-sheet", // balance sheet; heavy computation
  "/api/factory/v5/stock-allocation", // ~543 KB response; refresh explicitly after allocation-affecting mutations/manual refresh
];

const TOPIC_QUERY_PREFIXES: Record<RealtimeInvalidationTopic, readonly string[]> = {
  inventory: [
    "/api/locations",
    "/api/inventory",
    "/api/stock",
    "/api/bales",
    "/api/location-inventory",
  ],
  pos: ["/api/pos", "/api/sales", "/api/dashboard", "/api/pending-loadings"],
  accounting: [
    "/api/accounts",
    "/api/voucher",
    "/api/ledger",
    "/api/daybook",
    "/api/factory/daybook",
    "/api/fiscal-transfers",
    "/api/global-transactions",
    "/api/global/transactions",
    "/api/credit-notes",
    "/api/stats",
    "/api/reports/net-position",
    "/api/reports/net-profit",
    "/api/balance-sheet",
    "/api/dashboard-payable-accounts",
  ],
  factory: ["/api/factory/"],
  payroll: ["/api/factory/payroll", "/api/factory-payroll"],
  containers: ["/api/containers", "/api/import", "/api/sp/", "/api/supplier-proforma"],
  reference: [
    "/api/suppliers",
    "/api/customers",
    "/api/employees",
    "/api/locations",
    "/api/stock-groups",
    "/api/stock-categories",
    "/api/stock-grades",
    "/api/company-settings",
    "/api/user/preferences",
  ],
  communications: [
    "/api/notifications",
    "/api/intercompany-notifications",
    "/api/business-alerts",
    "/api/chat",
    "/api/user-notes",
  ],
};

// Normal writes should feel live. A short trailing debounce still folds an import,
// POS rush, or bulk edit into one refresh round instead of one round per write.
const INVALIDATE_DEBOUNCE_MS = 400;
const RECONNECT_BASE_DELAY_MS = 1_500;
const RECONNECT_MAX_DELAY_MS = 30_000;
const OFFLINE_PROBE_DELAY_MS = 30_000;
const RECONNECT_JITTER_RATIO = 0.2;

interface PendingInvalidation {
  blanket: boolean;
  topics: Set<RealtimeInvalidationTopic>;
  locationIds: Set<number>;
  hasUnscopedLocation: boolean;
}

function createPendingInvalidation(): PendingInvalidation {
  return {
    blanket: false,
    topics: new Set<RealtimeInvalidationTopic>(),
    locationIds: new Set<number>(),
    hasUnscopedLocation: false,
  };
}

// Multiple React surfaces may mount this hook in the same browser tab. Keep a
// single module-level socket and reference-count subscribers by QueryClient so
// child-first effect ordering cannot steal ownership from the app shell. The
// socket lives until the last subscriber unmounts.
const subscribers = new Map<QueryClient, number>();
const chatEventSubscribers = new Set<(event: RealtimeChatEvent) => void>();
let sharedSocket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingInvalidation = createPendingInvalidation();
let managerRunning = false;
let hadSuccessfulConnection = false;
let firstConnectionDelayed = false;
let missedWhileHidden = false;
let reconnectAttempt = 0;

function isStableQueryKey(key: string): boolean {
  return STABLE_QUERY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function explicitLocationIdFromKey(key: string): number | null {
  const pathMatch = key.match(/^\/api\/locations\/(\d+)(?:\/|$|\?)/);
  if (pathMatch) return Number(pathMatch[1]);

  const queryMatch = key.match(/[?&](?:locationId|location_id)=(\d+)(?:&|$)/);
  return queryMatch ? Number(queryMatch[1]) : null;
}

function queryMatchesPendingInvalidation(
  query: { queryKey: readonly unknown[] },
  invalidation: PendingInvalidation
): boolean {
  const key = query.queryKey[0];
  if (typeof key !== "string") return true;
  if (isStableQueryKey(key)) return false;
  if (invalidation.blanket) return true;

  const matchesTopic = [...invalidation.topics].some((topic) =>
    TOPIC_QUERY_PREFIXES[topic].some((prefix) => key.startsWith(prefix))
  );
  if (!matchesTopic) return false;

  if (!invalidation.hasUnscopedLocation && invalidation.locationIds.size > 0) {
    const queryLocationId = explicitLocationIdFromKey(key);
    if (queryLocationId !== null && !invalidation.locationIds.has(queryLocationId)) return false;
  }

  return true;
}

function resetPendingInvalidation(): void {
  pendingInvalidation = createPendingInvalidation();
}

function mergePendingInvalidation(message: RealtimeInvalidationMessage): void {
  if (!message.topics?.length) {
    pendingInvalidation.blanket = true;
    return;
  }

  for (const topic of message.topics) pendingInvalidation.topics.add(topic);

  if (!message.locationIds?.length) {
    pendingInvalidation.hasUnscopedLocation = true;
    return;
  }
  for (const locationId of message.locationIds) pendingInvalidation.locationIds.add(locationId);
}

function invalidateActiveQueries(invalidation: PendingInvalidation): void {
  if (!managerRunning) return;
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
    if (shouldCatchUp) runCatchUpInvalidation();
    hadSuccessfulConnection = true;
  };

  socket.onmessage = (event) => {
    if (sharedSocket !== socket || !managerRunning) return;
    try {
      const payload = JSON.parse(event.data as string) as unknown;
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

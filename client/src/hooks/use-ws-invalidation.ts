import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

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

// AuthenticatedApp owns the app-wide invalidation socket. Some leaf pages have
// historically mounted this hook too, which opened duplicate /ws connections
// in the same browser tab. Keep a module-level owner token so accidental extra
// mounts become no-ops instead of multiplying long-lived Render connections.
let activeWsInvalidationOwner: symbol | null = null;

export function resetWsInvalidationOwnerForTests(): void {
  activeWsInvalidationOwner = null;
}

export function useWsInvalidation() {
  const queryClient = useQueryClient();
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmountedRef = useRef(false);
  // Track whether we had a successful connection before, so we know a reconnect
  // may have missed broadcasts that fired while the socket was down.
  const hadSuccessfulConnectionRef = useRef(false);
  // Set when a broadcast arrives while the tab is hidden, so the deferred
  // refresh runs the moment the user looks at it again.
  const missedWhileHiddenRef = useRef(false);

  useEffect(() => {
    const ownerToken = Symbol("ws-invalidation-owner");
    if (activeWsInvalidationOwner !== null) return;
    activeWsInvalidationOwner = ownerToken;
    unmountedRef.current = false;

    function runInvalidation() {
      if (unmountedRef.current) return;
      queryClient.invalidateQueries(
        {
          refetchType: "active",
          predicate: (query) => {
            const key = query.queryKey[0];
            if (typeof key !== "string") return true;
            return !STABLE_QUERY_PREFIXES.some((prefix) => key.startsWith(prefix));
          },
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

    function handleInvalidate() {
      // Nobody is reading a hidden tab, and people leave several open. Refetching
      // there spends a request per query on screen for a screen nobody is looking
      // at. Remember that something changed and refresh on the way back instead.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        missedWhileHiddenRef.current = true;
        return;
      }

      // Debounce: if multiple WS messages arrive rapidly, only run one invalidation
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(runInvalidation, INVALIDATE_DEBOUNCE_MS);
    }

    function handleVisibilityChange() {
      if (document.visibilityState !== "visible") return;
      if (!missedWhileHiddenRef.current) return;
      missedWhileHiddenRef.current = false;
      runInvalidation();
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);

    // Capacitor builds set VITE_WS_URL explicitly; web builds derive it from window.location.
    const _CAPACITOR_WS_URL: string = (import.meta.env?.VITE_WS_URL as string) || "";

    function connect() {
      if (unmountedRef.current) return;

      let _wsTarget: string;
      if (_CAPACITOR_WS_URL) {
        _wsTarget = _CAPACITOR_WS_URL; // Capacitor build — env var set at build time
      } else {
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        _wsTarget = `${protocol}//${window.location.host}/ws`; // Web — existing logic unchanged
      }
      const ws = new WebSocket(_wsTarget);
      wsRef.current = ws;

      ws.onopen = () => {
        // If this is a reconnect (not the initial connect), we may have missed
        // invalidation broadcasts while the socket was down — flush stale data now.
        if (hadSuccessfulConnectionRef.current && !unmountedRef.current) {
          handleInvalidate();
        }
        hadSuccessfulConnectionRef.current = true;
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.type === "invalidate") {
            handleInvalidate();
          }
        } catch {
          // Malformed or absent payload — fall through to the default rather than surface a parse error.
        }
      };

      ws.onclose = () => {
        if (!unmountedRef.current) {
          reconnectTimerRef.current = setTimeout(connect, 3000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      unmountedRef.current = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      wsRef.current?.close();
      if (activeWsInvalidationOwner === ownerToken) activeWsInvalidationOwner = null;
    };
  }, [queryClient]);
}

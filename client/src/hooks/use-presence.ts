import { useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { markRemoteSupportAuthLost } from "@/components/remote-support-auth-lifecycle";

export const HEARTBEAT_INTERVAL = 90000; // 90 seconds (well within the 3-minute presence expiry window)
const ROUTE_DEBOUNCE_MS = 10000; // 10 seconds

type PresenceType = "route_change" | "heartbeat";

export function usePresence(enabled = true) {
  const [location] = useLocation();
  const lastRouteRef = useRef(location);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const isMountedRef = useRef(true);
  const lastSentAtRef = useRef<number>(0);

  const sendHeartbeat = useCallback((route: string, type: PresenceType) => {
    fetch("/api/user-presence", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ route, type }),
    })
      .then((res) => {
        // Session expired — stop all remote-support browser work immediately.
        // The global fetch interceptor will also confirm the session loss and
        // redirect to login, but the local lifecycle prevents request churn while
        // that confirmation/redirect is happening.
        if (res.status === 401) {
          if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
          }
          markRemoteSupportAuthLost();
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const now = Date.now();
    lastRouteRef.current = location;

    if (document.visibilityState === "visible" && now - lastSentAtRef.current >= ROUTE_DEBOUNCE_MS) {
      lastSentAtRef.current = now;
      sendHeartbeat(location, "route_change");
    }
  }, [enabled, location, sendHeartbeat]);

  useEffect(() => {
    if (!enabled) {
      isMountedRef.current = false;
      return;
    }

    isMountedRef.current = true;

    intervalRef.current = setInterval(() => {
      // Hidden/background tabs do not need to stay independently present. One
      // visible-tab heartbeat is enough, and visibility recovery below refreshes
      // the state immediately when the user returns to this tab.
      if (isMountedRef.current && document.visibilityState === "visible") {
        sendHeartbeat(lastRouteRef.current, "heartbeat");
        lastSentAtRef.current = Date.now();
      }
    }, HEARTBEAT_INTERVAL);

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible" || !isMountedRef.current) return;
      const now = Date.now();
      if (now - lastSentAtRef.current < ROUTE_DEBOUNCE_MS) return;
      sendHeartbeat(lastRouteRef.current, "route_change");
      lastSentAtRef.current = now;
    };

    const handleBeforeUnload = () => {
      navigator.sendBeacon(
        "/api/user-presence/leave",
        new Blob([JSON.stringify({ action: "leave" })], { type: "application/json" })
      );
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      isMountedRef.current = false;
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [enabled, sendHeartbeat]);
}

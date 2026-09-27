import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { markRemoteSupportAuthLost } from "@/components/remote-support-auth-lifecycle";
import { apiRequest } from "@/lib/queryClient";

export interface RemoteControlSessionView {
  id: string;
  companyId: number;
  targetUserId: string;
  targetUsername: string;
  targetTabId: string;
  targetRoute: string;
  controllerUserId: string;
  controllerUsername: string;
  controllerRole: string;
  scope: "erp-browser-tab";
  status: "active" | "stopped" | "expired";
  startedAt: string;
  expiresAt: string;
  stoppedAt: string | null;
  stopReason: string | null;
  capabilities: {
    mouse: boolean;
    keyboard: boolean;
    browserTabOnly: true;
  };
}

const TAB_KEY = "remote-support-browser-tab-id";
const HEARTBEAT_MS = 12_000;

function createTabId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export function getRemoteSupportTabId(): string {
  if (typeof window === "undefined") return "server-rendered-tab";
  try {
    const existing = window.sessionStorage.getItem(TAB_KEY);
    if (existing) return existing;
    const next = createTabId();
    window.sessionStorage.setItem(TAB_KEY, next);
    return next;
  } catch {
    return createTabId();
  }
}

function normalizeSession(value: unknown): RemoteControlSessionView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const session = value as Partial<RemoteControlSessionView>;
  if (
    !session.id ||
    session.status !== "active" ||
    !session.targetTabId ||
    !Number.isInteger(session.companyId) ||
    typeof session.targetRoute !== "string"
  ) {
    return null;
  }
  return session as RemoteControlSessionView;
}

function isUnauthorized(error: unknown): boolean {
  return (
    !!error && typeof error === "object" && "status" in error && Number((error as { status?: unknown }).status) === 401
  );
}

export function useRemoteControlSession() {
  const tabId = useMemo(() => getRemoteSupportTabId(), []);
  const [currentLocation] = useLocation();
  const [session, setSession] = useState<RemoteControlSessionView | null>(null);
  const [stopping, setStopping] = useState(false);
  const [authAvailable, setAuthAvailable] = useState(true);

  const handleUnauthorized = useCallback(() => {
    setSession(null);
    setAuthAvailable(false);
    markRemoteSupportAuthLost();
  }, []);

  const heartbeat = useCallback(async () => {
    if (!authAvailable) return;
    try {
      const response = await apiRequest("POST", "/api/screen-feed/control/tab-heartbeat", {
        tabId,
        route: currentLocation || window.location.pathname,
      });
      if (response.status === 204) {
        setSession(null);
        return;
      }
      const payload = await response.json();
      setSession(normalizeSession(payload?.session));
    } catch (error) {
      if (isUnauthorized(error)) handleUnauthorized();
      // The event stream or next heartbeat will restore non-auth failures.
    }
  }, [authAvailable, currentLocation, handleUnauthorized, tabId]);

  useEffect(() => {
    if (!authAvailable) return;
    void heartbeat();
    const heartbeatId = window.setInterval(() => void heartbeat(), HEARTBEAT_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void heartbeat();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(heartbeatId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [authAvailable, heartbeat]);

  useEffect(() => {
    if (!authAvailable) return;
    let eventSource: EventSource | null = null;
    try {
      const params = new URLSearchParams({
        tabId,
        route: currentLocation || window.location.pathname,
      });
      eventSource = new EventSource(`/api/screen-feed/control/status?${params.toString()}`, {
        withCredentials: true,
      });
      eventSource.addEventListener("control", (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent<string>).data);
          setSession(normalizeSession(payload?.session));
        } catch {
          // A later event or heartbeat replaces malformed state.
        }
      });
    } catch {
      eventSource = null;
    }
    return () => eventSource?.close();
  }, [authAvailable, currentLocation, tabId]);

  const stop = useCallback(async () => {
    if (!session || stopping || !authAvailable) return;
    setStopping(true);
    try {
      await apiRequest("POST", `/api/screen-feed/control/sessions/${encodeURIComponent(session.id)}/stop`, {
        reason: "target-emergency-stop",
      });
      setSession(null);
    } catch (error) {
      if (isUnauthorized(error)) handleUnauthorized();
      else throw error;
    } finally {
      setStopping(false);
    }
  }, [authAvailable, handleUnauthorized, session, stopping]);

  return { session, stopping, stop, tabId };
}

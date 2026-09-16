import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { markRemoteSupportAuthLost } from "@/components/remote-support-auth-lifecycle";
import {
  acquireRemoteControlPanelHost,
  findRemoteSupportWatchDialog,
  releaseRemoteControlPanelHost,
} from "@/components/remote-control-panel-portal";
import type { RemoteControlSessionView } from "@/hooks/use-remote-control-session";

export interface RemoteAuthorizationView {
  sessionId: string;
  controllerUserId: string;
  authorizedAt: string;
  expiresAt: string;
}

export interface RemoteControllerSessionView extends RemoteControlSessionView {
  mouseAuthorization: RemoteAuthorizationView | null;
  keyboardAuthorization: RemoteAuthorizationView | null;
}

export interface RemoteWatchTarget {
  userId: string;
  username: string;
}

export class RemoteControllerRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
    /** Server-supplied backoff, in milliseconds, for a refused (429) command. */
    readonly retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = "RemoteControllerRequestError";
  }
}

/** Reads the backoff a refused request carries, preferring the JSON body over the header. */
function parseRetryAfterMs(response: Response, payload: { retryAfterMs?: unknown }): number | null {
  const fromBody = payload?.retryAfterMs;
  if (typeof fromBody === "number" && Number.isFinite(fromBody) && fromBody > 0) {
    return Math.min(fromBody, 30_000);
  }
  const header = Number(response.headers.get("Retry-After"));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 30_000);
  return null;
}

interface ControllerActiveResponse {
  sessions?: RemoteControllerSessionView[];
}

interface RemoteControllerSessionContextValue {
  target: RemoteWatchTarget | null;
  session: RemoteControllerSessionView | null;
  portalHost: HTMLElement | null;
  refreshSession: () => Promise<RemoteControllerSessionView | null>;
  adoptSession: (session: RemoteControlSessionView | RemoteControllerSessionView | null) => void;
}

interface RefreshInFlight {
  targetUserId: string;
  promise: Promise<RemoteControllerSessionView | null>;
}

const RemoteControllerSessionContext = createContext<RemoteControllerSessionContextValue | null>(null);
const SESSION_REFRESH_MS = 5000;

export async function remoteControllerRequestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(url, {
    credentials: "include",
    cache: "no-store",
    ...init,
    headers,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) markRemoteSupportAuthLost();
    throw new RemoteControllerRequestError(
      response.status,
      typeof payload?.code === "string" ? payload.code : null,
      typeof payload?.message === "string" ? payload.message : "Remote control request failed.",
      parseRetryAfterMs(response, payload)
    );
  }
  return payload as T;
}

function currentWatchTarget(): RemoteWatchTarget | null {
  const dialog = findRemoteSupportWatchDialog();
  const userId = dialog?.dataset.watchedUserId?.trim() ?? "";
  if (!dialog || !userId) return null;
  const username = dialog.querySelector<HTMLElement>("[data-watch-username]")?.dataset.watchUsername?.trim() || userId;
  return { userId, username };
}

function normalizeSession(
  value: RemoteControlSessionView | RemoteControllerSessionView | null | undefined,
  targetUserId: string | null
): RemoteControllerSessionView | null {
  if (!value || value.status !== "active" || !targetUserId || value.targetUserId !== targetUserId) return null;
  const extended = value as Partial<RemoteControllerSessionView>;
  return {
    ...value,
    mouseAuthorization: extended.mouseAuthorization ?? null,
    keyboardAuthorization: extended.keyboardAuthorization ?? null,
  } as RemoteControllerSessionView;
}

function sameTarget(left: RemoteWatchTarget | null, right: RemoteWatchTarget | null): boolean {
  return left?.userId === right?.userId && left?.username === right?.username;
}

export function RemoteControllerSessionProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<RemoteWatchTarget | null>(() => currentWatchTarget());
  const [session, setSession] = useState<RemoteControllerSessionView | null>(null);
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  const targetRef = useRef(target);
  const sessionRef = useRef(session);
  const refreshInFlightRef = useRef<RefreshInFlight | null>(null);

  useEffect(() => {
    targetRef.current = target;
  }, [target]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    const refreshTarget = () => {
      const next = currentWatchTarget();
      setTarget((current) => (sameTarget(current, next) ? current : next));
    };
    refreshTarget();
    const observer = new MutationObserver(refreshTarget);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const dialog = findRemoteSupportWatchDialog();
    if (!target || !dialog || dialog.dataset.watchedUserId !== target.userId) {
      setPortalHost(null);
      return;
    }
    const host = acquireRemoteControlPanelHost(dialog);
    setPortalHost(host);
    return () => {
      releaseRemoteControlPanelHost(host);
      setPortalHost((current) => (current === host ? null : current));
    };
  }, [target]);

  const refreshSession = useCallback(async (): Promise<RemoteControllerSessionView | null> => {
    const activeTarget = targetRef.current;
    if (!activeTarget) {
      setSession(null);
      return null;
    }

    const existing = refreshInFlightRef.current;
    if (existing?.targetUserId === activeTarget.userId) return existing.promise;

    const request: Promise<RemoteControllerSessionView | null> = remoteControllerRequestJson<ControllerActiveResponse>(
      "/api/screen-feed/control/sessions/controller-active"
    )
      .then((payload) => {
        if (targetRef.current?.userId !== activeTarget.userId) return null;
        const candidate = Array.isArray(payload.sessions)
          ? payload.sessions.find((item) => item?.targetUserId === activeTarget.userId)
          : undefined;
        const next = normalizeSession(candidate, activeTarget.userId);
        if (!next) {
          setSession(null);
          return null;
        }

        const current = sessionRef.current;
        const merged =
          current?.id === next.id
            ? {
                ...next,
                mouseAuthorization: next.mouseAuthorization ?? current.mouseAuthorization,
                keyboardAuthorization: next.keyboardAuthorization,
              }
            : next;
        setSession(merged);
        return merged;
      })
      .finally(() => {
        if (refreshInFlightRef.current?.promise === request) refreshInFlightRef.current = null;
      });

    refreshInFlightRef.current = { targetUserId: activeTarget.userId, promise: request };
    return request;
  }, []);

  const adoptSession = useCallback((next: RemoteControlSessionView | RemoteControllerSessionView | null) => {
    const targetUserId = targetRef.current?.userId ?? null;
    setSession((current) => {
      const normalized = normalizeSession(next, targetUserId);
      if (!normalized) return null;
      if (current?.id === normalized.id) {
        return {
          ...normalized,
          mouseAuthorization: normalized.mouseAuthorization ?? current.mouseAuthorization,
          keyboardAuthorization: normalized.keyboardAuthorization ?? current.keyboardAuthorization,
        };
      }
      return normalized;
    });
  }, []);

  useEffect(() => {
    setSession(null);
    if (!target) return;
    let cancelled = false;
    const refresh = () => {
      if (cancelled || document.visibilityState !== "visible") return;
      void refreshSession().catch(() => undefined);
    };
    refresh();
    const intervalId = window.setInterval(refresh, SESSION_REFRESH_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refreshSession, target]);

  useEffect(() => {
    const targetUserId = target?.userId;
    return () => {
      const current = sessionRef.current;
      if (!targetUserId || !current || current.targetUserId !== targetUserId) return;
      void remoteControllerRequestJson(`/api/screen-feed/control/sessions/${encodeURIComponent(current.id)}/stop`, {
        method: "POST",
        body: JSON.stringify({ reason: "controller-viewer-closed" }),
      }).catch(() => undefined);
    };
  }, [target?.userId]);

  const value = useMemo<RemoteControllerSessionContextValue>(
    () => ({ target, session, portalHost, refreshSession, adoptSession }),
    [adoptSession, portalHost, refreshSession, session, target]
  );

  return <RemoteControllerSessionContext.Provider value={value}>{children}</RemoteControllerSessionContext.Provider>;
}

export function useRemoteControllerSession(): RemoteControllerSessionContextValue {
  const value = useContext(RemoteControllerSessionContext);
  if (!value) throw new Error();
  return value;
}

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { markRemoteSupportAuthLost } from "@/components/remote-support-auth-lifecycle";
import {
  acquireRemoteControlPanelHost,
  findRemoteSupportWatchDialog,
  releaseRemoteControlPanelHost,
} from "@/components/remote-control-panel-portal";
import type { RemoteControlSessionView } from "@/hooks/use-remote-control-session";
import {
  parseRetryAfterMs,
  SESSION_REFRESH_MS,
  WATCH_TARGET_REFRESH_DEBOUNCE_MS,
  PORTAL_SCOPE_SELECTOR,
  WATCH_TARGET_ATTRIBUTE_FILTER,
  nodeContainsWatchDialog,
  mutationMayAffectWatchTarget,
  currentWatchTarget,
  normalizeSession,
  sameTarget,
  type RemoteControllerSessionView,
  type RemoteWatchTarget,
  type ControllerActiveResponse,
  type RemoteControllerSessionContextValue,
  type RefreshInFlight,
} from "./RemoteControllerSessionContextHelpers";
export type {
  RemoteAuthorizationView,
  RemoteControllerSessionView,
  RemoteWatchTarget,
} from "./RemoteControllerSessionContextHelpers";

export class RemoteControllerRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
    readonly retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = "RemoteControllerRequestError";
  }
}

const RemoteControllerSessionContext = createContext<RemoteControllerSessionContextValue | null>(null);

function nodeMayContainWatchScope(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const element = node as Element;
  return element.matches(PORTAL_SCOPE_SELECTOR) || nodeContainsWatchDialog(element);
}

export async function remoteControllerRequestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { credentials: "include", cache: "no-store", ...init, headers });
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

function targetKey(target: RemoteWatchTarget): string {
  return `${target.userId}\u0000${target.tabId}`;
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
    const scopedObservers = new Map<HTMLElement, MutationObserver>();
    let refreshTimer: number | null = null;
    const refreshTarget = () => {
      const next = currentWatchTarget();
      setTarget((current) => (sameTarget(current, next) ? current : next));
    };
    const scheduleTargetRefresh = () => {
      if (refreshTimer !== null) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        refreshTarget();
      }, WATCH_TARGET_REFRESH_DEBOUNCE_MS);
    };
    const observeScope = (scope: HTMLElement) => {
      if (scopedObservers.has(scope)) return;
      const observer = new MutationObserver((records) => {
        if (mutationMayAffectWatchTarget(records)) scheduleTargetRefresh();
      });
      observer.observe(scope, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: WATCH_TARGET_ATTRIBUTE_FILTER,
        attributeOldValue: true,
      });
      scopedObservers.set(scope, observer);
    };
    const syncScopes = () => {
      const scopes = new Set(
        Array.from(document.body.children).filter(
          (element): element is HTMLElement => element instanceof HTMLElement && nodeMayContainWatchScope(element)
        )
      );
      for (const [scope, observer] of scopedObservers) {
        if (scopes.has(scope)) continue;
        observer.disconnect();
        scopedObservers.delete(scope);
      }
      for (const scope of scopes) observeScope(scope);
    };

    refreshTarget();
    syncScopes();
    const bodyObserver = new MutationObserver((records) => {
      const scopeChanged = records.some((record) => {
        if (record.type === "attributes") return true;
        return [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].some(nodeMayContainWatchScope);
      });
      if (!scopeChanged) return;
      syncScopes();
      scheduleTargetRefresh();
    });
    bodyObserver.observe(document.body, {
      childList: true,
      attributes: true,
      attributeFilter: ["data-radix-portal", ...WATCH_TARGET_ATTRIBUTE_FILTER],
    });

    return () => {
      bodyObserver.disconnect();
      for (const observer of scopedObservers.values()) observer.disconnect();
      scopedObservers.clear();
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    };
  }, []);

  useEffect(() => {
    const dialog = findRemoteSupportWatchDialog();
    if (
      !target ||
      !dialog ||
      dialog.dataset.watchedUserId !== target.userId ||
      dialog.dataset.watchedTabId !== target.tabId
    ) {
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
    const key = targetKey(activeTarget);
    const existing = refreshInFlightRef.current;
    if (existing?.targetKey === key) return existing.promise;

    const request: Promise<RemoteControllerSessionView | null> = remoteControllerRequestJson<ControllerActiveResponse>(
      "/api/screen-feed/control/sessions/controller-active"
    )
      .then((payload) => {
        const currentTarget = targetRef.current;
        if (!currentTarget || targetKey(currentTarget) !== key) return null;
        const candidate = Array.isArray(payload.sessions)
          ? payload.sessions.find(
              (item) => item?.targetUserId === activeTarget.userId && item?.targetTabId === activeTarget.tabId
            )
          : undefined;
        const next = normalizeSession(candidate, activeTarget);
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
                keyboardAuthorization: next.keyboardAuthorization ?? current.keyboardAuthorization,
              }
            : next;
        setSession(merged);
        return merged;
      })
      .finally(() => {
        if (refreshInFlightRef.current?.promise === request) refreshInFlightRef.current = null;
      });

    refreshInFlightRef.current = { targetKey: key, promise: request };
    return request;
  }, []);

  const adoptSession = useCallback((next: RemoteControlSessionView | RemoteControllerSessionView | null) => {
    const activeTarget = targetRef.current;
    setSession((current) => {
      const normalized = normalizeSession(next, activeTarget);
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

  const targetUserId = target?.userId;
  const targetTabId = target?.tabId;

  useEffect(() => {
    return () => {
      const current = sessionRef.current;
      if (
        !targetUserId ||
        !targetTabId ||
        !current ||
        current.targetUserId !== targetUserId ||
        current.targetTabId !== targetTabId
      )
        return;
      void remoteControllerRequestJson(`/api/screen-feed/control/sessions/${encodeURIComponent(current.id)}/stop`, {
        method: "POST",
        body: JSON.stringify({ reason: "controller-viewer-tab-changed" }),
      }).catch(() => undefined);
    };
  }, [targetTabId, targetUserId]);

  const value = useMemo<RemoteControllerSessionContextValue>(
    () => ({ target, session, portalHost, refreshSession, adoptSession }),
    [adoptSession, portalHost, refreshSession, session, target]
  );

  return <RemoteControllerSessionContext.Provider value={value}>{children}</RemoteControllerSessionContext.Provider>;
}

export function useRemoteControllerSession(): RemoteControllerSessionContextValue {
  const value = useContext(RemoteControllerSessionContext);
  if (!value) throw new Error("RemoteControllerSessionProvider is missing.");
  return value;
}

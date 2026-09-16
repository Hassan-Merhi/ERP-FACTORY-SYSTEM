import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { markRemoteSupportAuthLost } from "@/components/remote-support-auth-lifecycle";
import {
  acquireRemoteControlPanelHost,
  findRemoteSupportWatchDialog,
  releaseRemoteControlPanelHost,
  REMOTE_SUPPORT_WATCH_DIALOG_SELECTOR,
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
    message: string
  ) {
    super(message);
    this.name = "RemoteControllerRequestError";
  }
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
const WATCH_TARGET_REFRESH_DEBOUNCE_MS = 50;
const PORTAL_SCOPE_SELECTOR = "[data-radix-portal]";
const WATCH_TARGET_ATTRIBUTE_FILTER = ["data-testid", "data-watched-user-id", "data-watch-username"];

function nodeContainsWatchDialog(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const element = node as Element;
  return (
    element.matches(REMOTE_SUPPORT_WATCH_DIALOG_SELECTOR) ||
    Boolean(element.querySelector(REMOTE_SUPPORT_WATCH_DIALOG_SELECTOR))
  );
}

function nodeMayContainWatchScope(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const element = node as Element;
  return element.matches(PORTAL_SCOPE_SELECTOR) || nodeContainsWatchDialog(element);
}

function mutationMayAffectWatchTarget(records: readonly MutationRecord[]): boolean {
  for (const record of records) {
    if (record.type === "attributes") {
      const element = record.target instanceof Element ? record.target : null;
      if (!element) continue;
      // Attribute observers are scoped to portal roots and only subscribe to
      // these three lifecycle attributes. A dialog can lose its test id during
      // a replacement, so retain the old value to notice that removal too.
      if (
        element.matches(REMOTE_SUPPORT_WATCH_DIALOG_SELECTOR) ||
        element.closest(REMOTE_SUPPORT_WATCH_DIALOG_SELECTOR) ||
        (record.attributeName === "data-testid" && record.oldValue?.startsWith("dialog-watch-user"))
      ) {
        return true;
      }
      continue;
    }

    if (record.type !== "childList") continue;
    for (const node of [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)]) {
      if (nodeContainsWatchDialog(node)) return true;
    }
  }
  return false;
}

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
      typeof payload?.message === "string" ? payload.message : "Remote control request failed."
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
      // Radix renders dialogs beneath a direct body portal. Keep the persistent
      // observer at that shallow boundary, then observe only portal roots that
      // could contain a remote-viewer dialog instead of every ERP DOM update.
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

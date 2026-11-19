// Extracted from ./RemoteControllerSessionContext.tsx
import {
  findRemoteSupportWatchDialog,
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
  tabId: string;
}

export function parseRetryAfterMs(response: Response, payload: { retryAfterMs?: unknown }): number | null {
  const fromBody = payload?.retryAfterMs;
  if (typeof fromBody === "number" && Number.isFinite(fromBody) && fromBody > 0) return Math.min(fromBody, 30_000);
  const header = Number(response.headers.get("Retry-After"));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 30_000);
  return null;
}

export interface ControllerActiveResponse {
  sessions?: RemoteControllerSessionView[];
}

export interface RemoteControllerSessionContextValue {
  target: RemoteWatchTarget | null;
  session: RemoteControllerSessionView | null;
  portalHost: HTMLElement | null;
  refreshSession: () => Promise<RemoteControllerSessionView | null>;
  adoptSession: (session: RemoteControlSessionView | RemoteControllerSessionView | null) => void;
}

export interface RefreshInFlight {
  targetKey: string;
  promise: Promise<RemoteControllerSessionView | null>;
}

export const SESSION_REFRESH_MS = 5000;

export const WATCH_TARGET_REFRESH_DEBOUNCE_MS = 50;

export const PORTAL_SCOPE_SELECTOR = "[data-radix-portal]";

export const WATCH_TARGET_ATTRIBUTE_FILTER = [
  "data-testid",
  "data-watched-user-id",
  "data-watched-tab-id",
  "data-watch-username",
];

export function nodeContainsWatchDialog(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const element = node as Element;
  return (
    element.matches(REMOTE_SUPPORT_WATCH_DIALOG_SELECTOR) ||
    Boolean(element.querySelector(REMOTE_SUPPORT_WATCH_DIALOG_SELECTOR))
  );
}

export function mutationMayAffectWatchTarget(records: readonly MutationRecord[]): boolean {
  for (const record of records) {
    if (record.type === "attributes") {
      const element = record.target instanceof Element ? record.target : null;
      if (!element) continue;
      if (
        element.matches(REMOTE_SUPPORT_WATCH_DIALOG_SELECTOR) ||
        element.closest(REMOTE_SUPPORT_WATCH_DIALOG_SELECTOR) ||
        (record.attributeName === "data-testid" && record.oldValue?.startsWith("dialog-watch-user"))
      )
        return true;
      continue;
    }
    if (record.type !== "childList") continue;
    for (const node of [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)]) {
      if (nodeContainsWatchDialog(node)) return true;
    }
  }
  return false;
}

export function currentWatchTarget(): RemoteWatchTarget | null {
  const dialog = findRemoteSupportWatchDialog();
  const userId = dialog?.dataset.watchedUserId?.trim() ?? "";
  const tabId = dialog?.dataset.watchedTabId?.trim() ?? "";
  if (!dialog || !userId || !tabId) return null;
  const username = dialog.querySelector<HTMLElement>("[data-watch-username]")?.dataset.watchUsername?.trim() || userId;
  return { userId, username, tabId };
}

export function normalizeSession(
  value: RemoteControlSessionView | RemoteControllerSessionView | null | undefined,
  target: RemoteWatchTarget | null
): RemoteControllerSessionView | null {
  if (
    !value ||
    value.status !== "active" ||
    !target ||
    value.targetUserId !== target.userId ||
    value.targetTabId !== target.tabId
  )
    return null;
  const extended = value as Partial<RemoteControllerSessionView>;
  return {
    ...value,
    mouseAuthorization: extended.mouseAuthorization ?? null,
    keyboardAuthorization: extended.keyboardAuthorization ?? null,
  } as RemoteControllerSessionView;
}

export function sameTarget(left: RemoteWatchTarget | null, right: RemoteWatchTarget | null): boolean {
  return left?.userId === right?.userId && left?.username === right?.username && left?.tabId === right?.tabId;
}

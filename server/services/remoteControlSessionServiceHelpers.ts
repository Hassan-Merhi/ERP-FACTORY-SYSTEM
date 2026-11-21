// Extracted from ./remoteControlSessionService.ts

export type RemoteControlSessionStatus = "active" | "stopped" | "expired";

export interface RemoteControlTabPresence {
  userId: string;
  username: string;
  tabId: string;
  companyId: number;
  route: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface RemoteControlSession {
  id: string;
  companyId: number;
  targetCompanyId?: number;
  targetUserId: string;
  targetUsername: string;
  targetTabId: string;
  targetRoute: string;
  controllerUserId: string;
  controllerUsername: string;
  controllerRole: string;
  scope: "erp-browser-tab";
  status: RemoteControlSessionStatus;
  startedAt: number;
  expiresAt: number;
  lastControllerHeartbeatAt: number;
  lastTargetHeartbeatAt: number;
  stoppedAt: number | null;
  stopReason: string | null;
  capabilities: {
    mouse: boolean;
    keyboard: boolean;
    browserTabOnly: true;
  };
}

export interface StartRemoteControlSessionInput {
  targetUserId: string;
  targetUsername?: string;
  requestedTabId?: string;
  controllerUserId: string;
  controllerUsername: string;
  controllerRole: string;
  controllerCompanyId: number;
  durationMs?: number;
}

type TargetListener = () => void;

type SessionStopListener = (session: RemoteControlSession) => void;

export const sessions = new Map<string, RemoteControlSession>();

export const activeByTargetUser = new Map<string, string>();

export const tabsByUser = new Map<string, Map<string, RemoteControlTabPresence>>();

const targetListeners = new Map<string, Set<TargetListener>>();

const sessionStopListeners = new Set<SessionStopListener>();

export function cleanIdentifier(value: unknown, maxLength = 128): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export function cleanRoute(value: unknown): string {
  const route = cleanIdentifier(value, 500);
  return route.startsWith("/") ? route : "/";
}

export function positiveCompanyId(value: unknown): number | null {
  const companyId = Number(value);
  return Number.isInteger(companyId) && companyId > 0 ? companyId : null;
}

export function copySession(session: RemoteControlSession | null | undefined): RemoteControlSession | null {
  if (!session) return null;
  return {
    ...session,
    capabilities: { ...session.capabilities },
  };
}

export function notifyTarget(userId: string): void {
  for (const listener of targetListeners.get(userId) ?? []) {
    try {
      listener();
    } catch {
      // A disconnected event-stream listener must not affect session state.
    }
  }
}

export function activeSessionRecord(targetUserId: string): RemoteControlSession | null {
  const sessionId = activeByTargetUser.get(targetUserId);
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session || session.status !== "active") {
    activeByTargetUser.delete(targetUserId);
    return null;
  }
  return session;
}

export function stopSessionInternal(
  session: RemoteControlSession,
  reason: string,
  status: Exclude<RemoteControlSessionStatus, "active">,
  now: number
): RemoteControlSession {
  if (session.status !== "active") return session;
  session.status = status;
  session.capabilities.mouse = false;
  session.capabilities.keyboard = false;
  session.stoppedAt = now;
  session.stopReason = cleanIdentifier(reason, 160) || "stopped";
  if (activeByTargetUser.get(session.targetUserId) === session.id) {
    activeByTargetUser.delete(session.targetUserId);
  }
  notifyTarget(session.targetUserId);
  const stoppedSnapshot = copySession(session) as RemoteControlSession;
  for (const listener of sessionStopListeners) {
    try {
      listener(stoppedSnapshot);
    } catch {
      // Stop observers must never prevent a fail-safe stop.
    }
  }
  return session;
}

const REMOTE_CONTROL_CONTROLLER_ROLES = new Set(["Developer", "Admin", "Owner", "Manager"]);

export function isRemoteControlControllerRole(role: unknown): boolean {
  return typeof role === "string" && REMOTE_CONTROL_CONTROLLER_ROLES.has(role);
}

export function stopRemoteControlSession(
  sessionId: string,
  reason: string,
  now = Date.now()
): RemoteControlSession | null {
  const session = sessions.get(cleanIdentifier(sessionId));
  if (!session) return null;
  return copySession(stopSessionInternal(session, reason, "stopped", now));
}

export function stopAllRemoteControlSessions(reason: string, now = Date.now()): number {
  let stopped = 0;
  for (const session of sessions.values()) {
    if (session.status !== "active") continue;
    stopSessionInternal(session, reason, "stopped", now);
    stopped += 1;
  }
  return stopped;
}

export function subscribeRemoteControlTarget(userId: string, listener: TargetListener): () => void {
  const targetUserId = cleanIdentifier(userId);
  let listeners = targetListeners.get(targetUserId);
  if (!listeners) {
    listeners = new Set();
    targetListeners.set(targetUserId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) targetListeners.delete(targetUserId);
  };
}

export function subscribeRemoteControlSessionStops(listener: SessionStopListener): () => void {
  sessionStopListeners.add(listener);
  return () => sessionStopListeners.delete(listener);
}

export function resetRemoteControlSessionStateForTests(): void {
  sessions.clear();
  activeByTargetUser.clear();
  tabsByUser.clear();
  targetListeners.clear();
  sessionStopListeners.clear();
}

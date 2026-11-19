// Extracted from ./remoteControlCommandService.ts to keep that module under the source-size cap.
import { isRemoteSupportEnabled } from "./remoteSupportRuntime";
import { evaluateRemoteSupportRollout } from "./remoteSupportRollout";
import {
  getRemoteControlSession,
  type RemoteControlSession,
  setRemoteControlMouseCapability,
} from "./remoteControlSessionService";
import type {
  RemoteMouseCommandType,
  RemoteMouseFrameViewport,
  RemoteMouseCommand,
  RemoteMouseCommandResult,
  RemoteMouseAuthorization,
  CommandListener,
  ResultListener,
  RateWindow,
} from "./sanitizeRemoteMouseFrameViewportTypes";
export type {
  RemoteMouseCommandType,
  RemoteMouseCommandResultStatus,
  RemoteMouseFrameViewport,
  RemoteMouseCommand,
  RemoteMouseCommandResult,
  RemoteMouseAuthorization,
  CommandListener,
  ResultListener,
  RemoteMouseCommandPublication,
} from "./sanitizeRemoteMouseFrameViewportTypes";

export class RemoteMouseControlError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
    /** Milliseconds the controller should wait before retrying, when known. */
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "RemoteMouseControlError";
  }
}

export const PASSWORD_CONFIRMATION_MAX_AGE_MS = 5 * 60 * 1000;

export const COMMAND_TIMEOUT_MS = 15 * 1000;

export const COMMAND_RETENTION_MS = 2 * 60 * 1000;

export const RESULT_RETENTION_MS = 2 * 60 * 1000;

export const RATE_WINDOW_MS = 1000;

export const RATE_LIMITS: Record<RemoteMouseCommandType, number> = {
  "pointer-move": 20,
  click: 4,
  scroll: 12,
};

export const commandListeners = new Map<string, Set<CommandListener>>();

export const resultListeners = new Map<string, Set<ResultListener>>();

export const authorizations = new Map<string, RemoteMouseAuthorization>();

export const commandHistory = new Map<string, RemoteMouseCommand>();

/**
 * Commands that reached at least one target stream. Anything in
 * `commandHistory` but not here is still queued and has not been seen by the
 * employee tab, which is exactly the set a newer pointer move can supersede.
 */
export const deliveredCommandIds = new Set<string>();

export const completedResults = new Map<string, RemoteMouseCommandResult>();

export const sequenceBySession = new Map<string, number>();

export const rateWindows = new Map<string, RateWindow>();

export function cleanIdentifier(value: unknown, maxLength = 160): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export function cleanReason(value: unknown): string | null {
  const reason = cleanIdentifier(value, 160);
  return reason || null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizedCoordinate(value: unknown): number | null {
  const coordinate = finiteNumber(value);
  if (coordinate === null || coordinate < 0 || coordinate > 1) return null;
  return coordinate;
}

export function boundedDelta(value: unknown): number | null {
  const delta = finiteNumber(value);
  if (delta === null) return null;
  return Math.max(-1200, Math.min(1200, delta));
}

const MAX_FRAME_VIEWPORT_DIMENSION = 20_000;

const MAX_FRAME_VIEWPORT_SCROLL = 200_000;

function boundedFrameNumber(value: unknown, minimum: number, maximum: number): number | null {
  const number = finiteNumber(value);
  if (number === null || number < minimum || number > maximum) return null;
  return number;
}

export function sanitizeRemoteMouseFrameViewport(value: unknown): RemoteMouseFrameViewport | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const viewport = value as Record<string, unknown>;
  const width = boundedFrameNumber(viewport.width, 1, MAX_FRAME_VIEWPORT_DIMENSION);
  const height = boundedFrameNumber(viewport.height, 1, MAX_FRAME_VIEWPORT_DIMENSION);
  const scrollX = boundedFrameNumber(viewport.scrollX, 0, MAX_FRAME_VIEWPORT_SCROLL);
  const scrollY = boundedFrameNumber(viewport.scrollY, 0, MAX_FRAME_VIEWPORT_SCROLL);
  const visualScale = boundedFrameNumber(viewport.visualScale, 0.25, 8);
  if (width === null || height === null || scrollX === null || scrollY === null || visualScale === null) {
    return undefined;
  }
  return {
    width: Math.round(width),
    height: Math.round(height),
    scrollX: Math.round(scrollX),
    scrollY: Math.round(scrollY),
    visualScale,
  };
}

export function activeSessionForController(
  sessionId: string,
  controllerUserId: string,
  requireMouseCapability = true
): RemoteControlSession {
  const session = getRemoteControlSession(cleanIdentifier(sessionId));
  if (!session || session.status !== "active") {
    throw new RemoteMouseControlError("SESSION_INACTIVE", 409, "The support session is no longer active.");
  }
  if (session.controllerUserId !== cleanIdentifier(controllerUserId)) {
    throw new RemoteMouseControlError("CONTROLLER_MISMATCH", 403, "This controller does not own the session.");
  }
  if (!isRemoteSupportEnabled("remoteControl")) {
    throw new RemoteMouseControlError("MOUSE_CONTROL_DISABLED", 409, "Mouse control is disabled.");
  }
  const rollout = evaluateRemoteSupportRollout({
    companyId: session.companyId,
    controllerUserId: session.controllerUserId,
    controllerRole: session.controllerRole,
  });
  if (!rollout.allowed) {
    throw new RemoteMouseControlError(
      rollout.code ?? "REMOTE_SUPPORT_ROLLOUT_BLOCKED",
      409,
      rollout.message ?? "Remote support control is blocked by rollout policy."
    );
  }
  if (requireMouseCapability && !session.capabilities.mouse) {
    throw new RemoteMouseControlError("MOUSE_CONTROL_DISABLED", 409, "Mouse control is disabled.");
  }
  return session;
}

export function activeSessionForTarget(
  sessionId: string,
  targetUserId: string,
  targetTabId: string,
  requireMouseCapability = true
): RemoteControlSession {
  const session = getRemoteControlSession(cleanIdentifier(sessionId));
  if (!session || session.status !== "active") {
    throw new RemoteMouseControlError("SESSION_INACTIVE", 409, "The support session is no longer active.");
  }
  if (session.targetUserId !== cleanIdentifier(targetUserId) || session.targetTabId !== cleanIdentifier(targetTabId)) {
    throw new RemoteMouseControlError("TARGET_MISMATCH", 403, "This command channel is not bound to this ERP tab.");
  }
  if (!isRemoteSupportEnabled("remoteControl") || (requireMouseCapability && !session.capabilities.mouse)) {
    throw new RemoteMouseControlError("MOUSE_CONTROL_DISABLED", 409, "Mouse control is disabled.");
  }
  return session;
}

export function notify<T>(listeners: Set<(value: T) => void> | undefined, value: T): number {
  let delivered = 0;
  for (const listener of listeners ?? []) {
    try {
      listener(value);
      delivered += 1;
    } catch {
      // A broken event stream must not affect other listeners or session state.
    }
  }
  return delivered;
}

export function notifySingle<T>(listener: (value: T) => void, value: T): boolean {
  try {
    listener(value);
    return true;
  } catch {
    return false;
  }
}

export function pendingCommandsForSession(sessionId: string): RemoteMouseCommand[] {
  return [...commandHistory.values()]
    .filter((command) => command.sessionId === sessionId)
    .sort((left, right) => left.sequence - right.sequence);
}

/**
 * Drops undelivered pointer moves a newer command has made meaningless.
 *
 * A pointer move only carries "the cursor is here now". When the target stream
 * is slow or briefly disconnected, the queue fills with positions that are
 * already wrong, and replaying them on reconnect drags the remote cursor
 * through a stale trail before it catches up. Only queued moves are eligible —
 * anything already delivered has been executed, and clicks and scrolls are
 * discrete actions that are never superseded.
 */
export function dropSupersededPointerMoves(sessionId: string, now: number): string[] {
  const superseded: string[] = [];
  for (const [commandId, command] of commandHistory) {
    if (command.sessionId !== sessionId) continue;
    if (command.type !== "pointer-move") continue;
    if (deliveredCommandIds.has(commandId)) continue;

    commandHistory.delete(commandId);
    const result: RemoteMouseCommandResult = {
      commandId,
      sessionId,
      status: "ignored",
      reason: "superseded-pointer-move",
      completedAt: now,
    };
    completedResults.set(commandId, result);
    notify(resultListeners.get(sessionId), result);
    superseded.push(commandId);
  }
  return superseded;
}

export function clearSessionMouseState(sessionId: string, disableCapability: boolean): void {
  authorizations.delete(sessionId);
  rateWindows.delete(sessionId);
  sequenceBySession.delete(sessionId);
  commandListeners.delete(sessionId);
  resultListeners.delete(sessionId);
  for (const [commandId, command] of commandHistory) {
    if (command.sessionId === sessionId) {
      commandHistory.delete(commandId);
      deliveredCommandIds.delete(commandId);
    }
  }
  for (const [commandId, result] of completedResults) {
    if (result.sessionId === sessionId) completedResults.delete(commandId);
  }
  if (disableCapability) setRemoteControlMouseCapability(sessionId, false);
}

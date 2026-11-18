import { randomUUID } from "crypto";
import {
  getRemoteControlSession,
  setRemoteControlMouseCapability,
  type RemoteControlSession,
} from "./remoteControlSessionService";
import {
  COMMAND_RETENTION_MS,
  COMMAND_TIMEOUT_MS,
  PASSWORD_CONFIRMATION_MAX_AGE_MS,
  RATE_LIMITS,
  RATE_WINDOW_MS,
  RESULT_RETENTION_MS,
  RemoteMouseControlError,
  activeSessionForController,
  activeSessionForTarget,
  authorizations,
  boundedDelta,
  cleanIdentifier,
  cleanReason,
  clearSessionMouseState,
  commandHistory,
  commandListeners,
  completedResults,
  deliveredCommandIds,
  dropSupersededPointerMoves,
  normalizedCoordinate,
  notify,
  notifySingle,
  pendingCommandsForSession,
  rateWindows,
  resultListeners,
  sanitizeRemoteMouseFrameViewport,
  sequenceBySession,
  type CommandListener,
  type RemoteMouseAuthorization,
  type RemoteMouseCommand,
  type RemoteMouseCommandPublication,
  type RemoteMouseCommandResult,
  type RemoteMouseCommandType,
  type ResultListener,
} from "./sanitizeRemoteMouseFrameViewport";
export { RemoteMouseControlError, sanitizeRemoteMouseFrameViewport } from "./sanitizeRemoteMouseFrameViewport";
export type {
  RemoteMouseAuthorization,
  RemoteMouseCommand,
  RemoteMouseCommandPublication,
  RemoteMouseCommandResult,
  RemoteMouseCommandResultStatus,
  RemoteMouseCommandType,
  RemoteMouseFrameViewport,
} from "./sanitizeRemoteMouseFrameViewport";

function assertRateLimit(sessionId: string, type: RemoteMouseCommandType, now: number): void {
  let window = rateWindows.get(sessionId);
  if (!window || now - window.startedAt >= RATE_WINDOW_MS) {
    window = {
      startedAt: now,
      counts: { "pointer-move": 0, click: 0, scroll: 0 },
    };
    rateWindows.set(sessionId, window);
  }

  if (window.counts[type] >= RATE_LIMITS[type]) {
    // Refused commands do not consume budget: a controller that backs off for
    // the remainder of the window is admitted again immediately, instead of
    // being pushed further out by its own rejected retries.
    const retryAfterMs = Math.max(1, window.startedAt + RATE_WINDOW_MS - now);
    throw new RemoteMouseControlError(
      "COMMAND_RATE_LIMITED",
      429,
      "Mouse commands are being sent too quickly.",
      retryAfterMs
    );
  }
  window.counts[type] += 1;
}

/**
 * Phase 10 admission check.
 *
 * The route used to write an audit row and only then call
 * `publishRemoteMouseCommand`, so a command refused by the rate limiter had
 * already paid for a database round trip and left an audit row describing a
 * command that never shipped. Callers run this first: it applies exactly the
 * same session, authorization, and rate rules as publication, so a refusal
 * costs nothing and never produces a dead command.
 */
export function assertRemoteMouseCommandAdmission(input: {
  sessionId: string;
  controllerUserId: string;
  type: RemoteMouseCommandType;
  now?: number;
}): RemoteControlSession {
  const now = input.now ?? Date.now();
  const session = activeSessionForController(input.sessionId, input.controllerUserId);
  assertMouseAuthorization(session.id, input.controllerUserId, now);
  assertRateLimit(session.id, input.type, now);
  return session;
}

function assertMouseAuthorization(sessionId: string, controllerUserId: string, now: number): RemoteMouseAuthorization {
  const authorization = authorizations.get(sessionId);
  if (
    !authorization ||
    authorization.controllerUserId !== cleanIdentifier(controllerUserId) ||
    now >= authorization.expiresAt
  ) {
    clearSessionMouseState(sessionId, true);
    throw new RemoteMouseControlError(
      "MOUSE_AUTHORIZATION_REQUIRED",
      428,
      "Confirm your password before enabling mouse control."
    );
  }
  return { ...authorization };
}

export function authorizeRemoteMouseControl(input: {
  sessionId: string;
  controllerUserId: string;
  passwordConfirmedAt: number | null | undefined;
  now?: number;
}): RemoteMouseAuthorization {
  const now = input.now ?? Date.now();
  const session = activeSessionForController(input.sessionId, input.controllerUserId, false);
  const confirmedAt = input.passwordConfirmedAt;
  if (
    confirmedAt == null ||
    !Number.isFinite(confirmedAt) ||
    confirmedAt > now ||
    now - confirmedAt > PASSWORD_CONFIRMATION_MAX_AGE_MS
  ) {
    throw new RemoteMouseControlError(
      "PASSWORD_CONFIRMATION_REQUIRED",
      428,
      "Confirm your password before enabling mouse control."
    );
  }

  const authorization: RemoteMouseAuthorization = {
    sessionId: session.id,
    controllerUserId: session.controllerUserId,
    authorizedAt: now,
    expiresAt: Math.min(session.expiresAt, confirmedAt + PASSWORD_CONFIRMATION_MAX_AGE_MS),
  };
  authorizations.set(session.id, authorization);
  if (!setRemoteControlMouseCapability(session.id, true)) {
    clearSessionMouseState(session.id, false);
    throw new RemoteMouseControlError("SESSION_INACTIVE", 409, "The support session is no longer active.");
  }
  return { ...authorization };
}

export function revokeRemoteMouseControl(input: { sessionId: string; controllerUserId: string }): void {
  const session = activeSessionForController(input.sessionId, input.controllerUserId, false);
  clearSessionMouseState(session.id, true);
}

export function getRemoteMouseAuthorization(
  sessionId: string,
  controllerUserId: string,
  now = Date.now()
): RemoteMouseAuthorization | null {
  try {
    activeSessionForController(sessionId, controllerUserId, false);
    return assertMouseAuthorization(cleanIdentifier(sessionId), controllerUserId, now);
  } catch {
    return null;
  }
}

export function publishRemoteMouseCommand(input: {
  sessionId: string;
  controllerUserId: string;
  type: unknown;
  x: unknown;
  y: unknown;
  deltaX?: unknown;
  deltaY?: unknown;
  frameViewport?: unknown;
  now?: number;
  /**
   * Set when the caller already passed `assertRemoteMouseCommandAdmission` for
   * this command, so the one-per-command rate budget is not consumed twice.
   */
  admitted?: boolean;
}): RemoteMouseCommandPublication {
  const now = input.now ?? Date.now();
  const session = activeSessionForController(input.sessionId, input.controllerUserId);
  assertMouseAuthorization(session.id, input.controllerUserId, now);

  const type = input.type;
  if (type !== "pointer-move" && type !== "click" && type !== "scroll") {
    throw new RemoteMouseControlError("INVALID_COMMAND", 400, "Unsupported mouse command.");
  }

  const x = normalizedCoordinate(input.x);
  const y = normalizedCoordinate(input.y);
  if (x === null || y === null) {
    throw new RemoteMouseControlError("INVALID_COORDINATES", 400, "Mouse coordinates must be normalized.");
  }

  const deltaX = type === "scroll" ? boundedDelta(input.deltaX ?? 0) : undefined;
  const deltaY = type === "scroll" ? boundedDelta(input.deltaY ?? 0) : undefined;
  if (type === "scroll" && (deltaX === null || deltaY === null || (deltaX === 0 && deltaY === 0))) {
    throw new RemoteMouseControlError("INVALID_SCROLL", 400, "A bounded scroll delta is required.");
  }

  if (!input.admitted) assertRateLimit(session.id, type, now);

  // Superseding runs before the new command is queued so the new move is never
  // a candidate for its own cleanup.
  const supersededCommandIds = type === "pointer-move" ? dropSupersededPointerMoves(session.id, now) : [];

  const nextSequence = (sequenceBySession.get(session.id) ?? 0) + 1;
  sequenceBySession.set(session.id, nextSequence);

  // An invalid frame snapshot is dropped rather than rejected: legacy
  // controllers send none at all, and a malformed snapshot must never
  // block an otherwise valid command — the target simply falls back to
  // the pre-Phase-11 live-viewport mapping.
  const frameViewport = sanitizeRemoteMouseFrameViewport(input.frameViewport);

  const command: RemoteMouseCommand = {
    id: randomUUID(),
    sessionId: session.id,
    targetUserId: session.targetUserId,
    targetTabId: session.targetTabId,
    type,
    sequence: nextSequence,
    x,
    y,
    ...(type === "scroll" ? { deltaX: deltaX as number, deltaY: deltaY as number } : {}),
    ...(frameViewport ? { frameViewport } : {}),
    createdAt: now,
  };

  commandHistory.set(command.id, command);
  const delivered = notify(commandListeners.get(session.id), command);
  if (delivered > 0) deliveredCommandIds.add(command.id);
  return { command: { ...command }, supersededCommandIds };
}

export function subscribeRemoteMouseCommands(input: {
  sessionId: string;
  targetUserId: string;
  targetTabId: string;
  listener: CommandListener;
}): () => void {
  const session = activeSessionForTarget(input.sessionId, input.targetUserId, input.targetTabId);
  let listeners = commandListeners.get(session.id);
  if (!listeners) {
    listeners = new Set();
    commandListeners.set(session.id, listeners);
  }
  listeners.add(input.listener);

  for (const command of pendingCommandsForSession(session.id)) {
    if (notifySingle(input.listener, command)) deliveredCommandIds.add(command.id);
  }

  return () => {
    listeners?.delete(input.listener);
    if (listeners?.size === 0) commandListeners.delete(session.id);
  };
}

export function publishRemoteMouseCommandResult(input: {
  sessionId: string;
  commandId: string;
  targetUserId: string;
  targetTabId: string;
  status: unknown;
  reason?: unknown;
  now?: number;
}): RemoteMouseCommandResult {
  const now = input.now ?? Date.now();
  const session = activeSessionForTarget(input.sessionId, input.targetUserId, input.targetTabId, false);
  const commandId = cleanIdentifier(input.commandId);
  const completed = completedResults.get(commandId);
  if (completed) {
    if (completed.sessionId !== session.id) {
      throw new RemoteMouseControlError("COMMAND_NOT_FOUND", 404, "Mouse command not found.");
    }
    return { ...completed };
  }

  const command = commandHistory.get(commandId);
  if (!command || command.sessionId !== session.id) {
    throw new RemoteMouseControlError("COMMAND_NOT_FOUND", 404, "Mouse command not found.");
  }
  if (input.status !== "executed" && input.status !== "blocked" && input.status !== "ignored") {
    throw new RemoteMouseControlError("INVALID_RESULT", 400, "Unsupported mouse command result.");
  }

  const result: RemoteMouseCommandResult = {
    commandId,
    sessionId: session.id,
    status: input.status,
    reason: cleanReason(input.reason),
    completedAt: now,
  };
  commandHistory.delete(commandId);
  deliveredCommandIds.delete(commandId);
  completedResults.set(commandId, result);
  notify(resultListeners.get(session.id), result);
  return { ...result };
}

export function subscribeRemoteMouseResults(input: {
  sessionId: string;
  controllerUserId: string;
  listener: ResultListener;
}): () => void {
  const session = activeSessionForController(input.sessionId, input.controllerUserId);
  let listeners = resultListeners.get(session.id);
  if (!listeners) {
    listeners = new Set();
    resultListeners.set(session.id, listeners);
  }
  listeners.add(input.listener);
  return () => {
    listeners?.delete(input.listener);
    if (listeners?.size === 0) resultListeners.delete(session.id);
  };
}

export function cleanupRemoteMouseCommandState(now = Date.now()): void {
  const sessionIds = new Set([
    ...authorizations.keys(),
    ...commandListeners.keys(),
    ...resultListeners.keys(),
    ...sequenceBySession.keys(),
    ...rateWindows.keys(),
  ]);
  for (const sessionId of sessionIds) {
    const session = getRemoteControlSession(sessionId);
    const authorization = authorizations.get(sessionId);
    if (!session || session.status !== "active" || !authorization || now >= authorization.expiresAt) {
      clearSessionMouseState(sessionId, !!session && session.status === "active");
    }
  }

  for (const [commandId, command] of commandHistory) {
    if (now - command.createdAt <= COMMAND_TIMEOUT_MS) continue;
    commandHistory.delete(commandId);
    deliveredCommandIds.delete(commandId);
    const result: RemoteMouseCommandResult = {
      commandId,
      sessionId: command.sessionId,
      status: "ignored",
      reason: "command-timeout",
      completedAt: now,
    };
    completedResults.set(commandId, result);
    notify(resultListeners.get(command.sessionId), result);
  }

  for (const [commandId, result] of completedResults) {
    if (now - result.completedAt > RESULT_RETENTION_MS) completedResults.delete(commandId);
  }

  for (const [commandId, command] of commandHistory) {
    if (now - command.createdAt > COMMAND_RETENTION_MS) {
      commandHistory.delete(commandId);
      deliveredCommandIds.delete(commandId);
    }
  }
}

export function resetRemoteMouseCommandStateForTests(): void {
  commandListeners.clear();
  resultListeners.clear();
  deliveredCommandIds.clear();
  authorizations.clear();
  commandHistory.clear();
  completedResults.clear();
  sequenceBySession.clear();
  rateWindows.clear();
}

const cleanupTimer = setInterval(() => cleanupRemoteMouseCommandState(), 3000);
(cleanupTimer as unknown as { unref?: () => void }).unref?.();

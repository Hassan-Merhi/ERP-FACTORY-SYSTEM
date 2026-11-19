// Extracted from ./remoteControlCommandService.ts
import { getRemoteControlSession, type RemoteControlSession } from "./remoteControlSessionService";
import {
  COMMAND_RETENTION_MS,
  COMMAND_TIMEOUT_MS,
  RATE_LIMITS,
  RATE_WINDOW_MS,
  RESULT_RETENTION_MS,
  RemoteMouseControlError,
  activeSessionForController,
  authorizations,
  cleanIdentifier,
  clearSessionMouseState,
  commandHistory,
  commandListeners,
  completedResults,
  deliveredCommandIds,
  notify,
  rateWindows,
  resultListeners,
  sequenceBySession,
  type RemoteMouseAuthorization,
  type RemoteMouseCommandResult,
  type RemoteMouseCommandType,
} from "./sanitizeRemoteMouseFrameViewport";

export function assertRateLimit(sessionId: string, type: RemoteMouseCommandType, now: number): void {
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

export function assertMouseAuthorization(
  sessionId: string,
  controllerUserId: string,
  now: number
): RemoteMouseAuthorization {
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

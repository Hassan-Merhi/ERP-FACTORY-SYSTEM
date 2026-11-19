// Extracted from ./remoteKeyboardCommandService.ts
import { setRemoteControlKeyboardCapability } from "./remoteControlSessionService";
import {
  PASSWORD_CONFIRMATION_MAX_AGE_MS,
  RATE_LIMIT,
  RATE_WINDOW_MS,
  RemoteKeyboardControlError,
  activeSessionForController,
  authorizations,
  cleanIdentifier,
  commandListeners,
  commandReceipts,
  rateWindows,
  resultListeners,
  sequenceBySession,
  type RemoteKeyboardAuthorization,
} from "./activeSessionForController";

export function clearSessionKeyboardState(sessionId: string, disableCapability: boolean): void {
  authorizations.delete(sessionId);
  rateWindows.delete(sessionId);
  sequenceBySession.delete(sessionId);
  commandListeners.delete(sessionId);
  resultListeners.delete(sessionId);
  for (const [commandId, receipt] of commandReceipts) {
    if (receipt.sessionId === sessionId) commandReceipts.delete(commandId);
  }
  if (disableCapability) setRemoteControlKeyboardCapability(sessionId, false);
}

export function assertRateLimit(sessionId: string, now: number): void {
  let window = rateWindows.get(sessionId);
  if (!window || now - window.startedAt >= RATE_WINDOW_MS) {
    window = { startedAt: now, count: 0 };
    rateWindows.set(sessionId, window);
  }
  if (window.count >= RATE_LIMIT) {
    // A refused command does not consume budget, so a controller that backs
    // off is admitted as soon as the window rolls rather than being pushed
    // further out by its own rejected retries.
    const retryAfterMs = Math.max(1, window.startedAt + RATE_WINDOW_MS - now);
    throw new RemoteKeyboardControlError(
      "KEYBOARD_RATE_LIMITED",
      429,
      "Keyboard commands are being sent too quickly.",
      retryAfterMs
    );
  }
  window.count += 1;
}

export function assertKeyboardAuthorization(
  sessionId: string,
  controllerUserId: string,
  now: number
): RemoteKeyboardAuthorization {
  const authorization = authorizations.get(sessionId);
  if (
    !authorization ||
    authorization.controllerUserId !== cleanIdentifier(controllerUserId) ||
    now >= authorization.expiresAt
  ) {
    clearSessionKeyboardState(sessionId, true);
    throw new RemoteKeyboardControlError(
      "KEYBOARD_AUTHORIZATION_REQUIRED",
      428,
      "Confirm your password before enabling keyboard control."
    );
  }
  return { ...authorization };
}

export function authorizeRemoteKeyboardControl(input: {
  sessionId: string;
  controllerUserId: string;
  passwordConfirmedAt: number | null | undefined;
  now?: number;
}): RemoteKeyboardAuthorization {
  const now = input.now ?? Date.now();
  const session = activeSessionForController(input.sessionId, input.controllerUserId, false);
  const confirmedAt = input.passwordConfirmedAt;
  if (
    confirmedAt == null ||
    !Number.isFinite(confirmedAt) ||
    confirmedAt > now ||
    now - confirmedAt > PASSWORD_CONFIRMATION_MAX_AGE_MS
  ) {
    throw new RemoteKeyboardControlError(
      "PASSWORD_CONFIRMATION_REQUIRED",
      428,
      "Confirm your password before enabling keyboard control."
    );
  }

  const authorization: RemoteKeyboardAuthorization = {
    sessionId: session.id,
    controllerUserId: session.controllerUserId,
    authorizedAt: now,
    expiresAt: Math.min(session.expiresAt, confirmedAt + PASSWORD_CONFIRMATION_MAX_AGE_MS),
  };
  authorizations.set(session.id, authorization);
  if (!setRemoteControlKeyboardCapability(session.id, true)) {
    clearSessionKeyboardState(session.id, false);
    throw new RemoteKeyboardControlError("KEYBOARD_CONTROL_DISABLED", 409, "Keyboard control is disabled.");
  }
  return { ...authorization };
}

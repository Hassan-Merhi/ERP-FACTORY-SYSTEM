import { randomUUID } from "crypto";
import { isRemoteSupportEnabled } from "./remoteSupportRuntime";
import {
  getRemoteControlSession,
  subscribeRemoteControlSessionStops,
  type RemoteControlSession,
} from "./remoteControlSessionService";
import {
  ALLOWED_KEYS,
  COMMAND_RETENTION_MS,
  RemoteKeyboardControlError,
  activeSessionForController,
  activeSessionForTarget,
  authorizations,
  cleanIdentifier,
  cleanInsertText,
  cleanReason,
  commandListeners,
  commandReceipts,
  notify,
  rateWindows,
  resultListeners,
  sequenceBySession,
  type CommandListener,
  type RemoteKeyboardAuthorization,
  type RemoteKeyboardCommand,
  type RemoteKeyboardCommandResult,
  type RemoteKeyboardKey,
  type ResultListener,
} from "./activeSessionForController";
import {
  clearSessionKeyboardState,
  assertRateLimit,
  assertKeyboardAuthorization,
} from "./remoteKeyboardCommandServiceHelpers";
export { authorizeRemoteKeyboardControl } from "./remoteKeyboardCommandServiceHelpers";
export { RemoteKeyboardControlError } from "./activeSessionForController";
export type {
  RemoteKeyboardAuthorization,
  RemoteKeyboardCommand,
  RemoteKeyboardCommandResult,
  RemoteKeyboardCommandResultStatus,
  RemoteKeyboardCommandType,
  RemoteKeyboardKey,
} from "./activeSessionForController";
let unsubscribeSessionStopCleanup: (() => void) | null = null;

/**
 * Phase 10 admission check — the keyboard counterpart of
 * `assertRemoteMouseCommandAdmission`. Routes run this before writing any
 * audit record so a command refused for rate, authorization, or target-channel
 * reasons costs no database work and leaves no row describing a keystroke that
 * never shipped.
 */
export function assertRemoteKeyboardCommandAdmission(input: {
  sessionId: string;
  controllerUserId: string;
  now?: number;
}): RemoteControlSession {
  const now = input.now ?? Date.now();
  const session = activeSessionForController(input.sessionId, input.controllerUserId);
  assertKeyboardAuthorization(session.id, input.controllerUserId, now);
  if ((commandListeners.get(session.id)?.size ?? 0) === 0) {
    throw new RemoteKeyboardControlError(
      "TARGET_KEYBOARD_CHANNEL_UNAVAILABLE",
      409,
      "The employee ERP tab is not ready to receive keyboard commands."
    );
  }
  assertRateLimit(session.id, now);
  return session;
}

export function revokeRemoteKeyboardControl(input: { sessionId: string; controllerUserId: string }): void {
  const session = activeSessionForController(input.sessionId, input.controllerUserId, false);
  clearSessionKeyboardState(session.id, true);
}

export function getRemoteKeyboardAuthorization(
  sessionId: string,
  controllerUserId: string,
  now = Date.now()
): RemoteKeyboardAuthorization | null {
  try {
    activeSessionForController(sessionId, controllerUserId, false);
    return assertKeyboardAuthorization(cleanIdentifier(sessionId), controllerUserId, now);
  } catch {
    return null;
  }
}

export function publishRemoteKeyboardCommand(input: {
  sessionId: string;
  controllerUserId: string;
  type: unknown;
  text?: unknown;
  key?: unknown;
  shiftKey?: unknown;
  now?: number;
  /**
   * Set when the caller already passed `assertRemoteKeyboardCommandAdmission`,
   * so the one-per-command rate budget is not consumed twice.
   */
  admitted?: boolean;
}): RemoteKeyboardCommand {
  const now = input.now ?? Date.now();
  const session = activeSessionForController(input.sessionId, input.controllerUserId);
  assertKeyboardAuthorization(session.id, input.controllerUserId, now);
  if ((commandListeners.get(session.id)?.size ?? 0) === 0) {
    throw new RemoteKeyboardControlError(
      "TARGET_KEYBOARD_CHANNEL_UNAVAILABLE",
      409,
      "The employee ERP tab is not ready to receive keyboard commands."
    );
  }
  if (!input.admitted) assertRateLimit(session.id, now);

  if (input.type !== "insert-text" && input.type !== "key") {
    throw new RemoteKeyboardControlError("INVALID_KEYBOARD_COMMAND", 400, "Unsupported keyboard command.");
  }

  const text = input.type === "insert-text" ? cleanInsertText(input.text) : undefined;
  const key =
    input.type === "key" && ALLOWED_KEYS.has(input.key as RemoteKeyboardKey)
      ? (input.key as RemoteKeyboardKey)
      : undefined;
  if (input.type === "insert-text" && !text) {
    throw new RemoteKeyboardControlError("INVALID_KEYBOARD_TEXT", 400, "Keyboard text is invalid or too long.");
  }
  if (input.type === "key" && !key) {
    throw new RemoteKeyboardControlError("INVALID_KEY", 400, "This keyboard key is not allowed.");
  }

  const nextSequence = (sequenceBySession.get(session.id) ?? 0) + 1;
  sequenceBySession.set(session.id, nextSequence);
  const command: RemoteKeyboardCommand = {
    id: randomUUID(),
    sessionId: session.id,
    targetUserId: session.targetUserId,
    targetTabId: session.targetTabId,
    type: input.type,
    sequence: nextSequence,
    ...(text ? { text } : {}),
    ...(key ? { key } : {}),
    shiftKey: input.shiftKey === true,
    createdAt: now,
  };

  commandReceipts.set(command.id, { sessionId: command.sessionId, createdAt: command.createdAt });
  const delivered = notify(commandListeners.get(session.id), command);
  if (delivered === 0) {
    commandReceipts.delete(command.id);
    throw new RemoteKeyboardControlError(
      "TARGET_KEYBOARD_CHANNEL_UNAVAILABLE",
      409,
      "The employee ERP tab is not ready to receive keyboard commands."
    );
  }
  return { ...command };
}

export function subscribeRemoteKeyboardCommands(input: {
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
  return () => {
    listeners?.delete(input.listener);
    if (listeners?.size === 0) commandListeners.delete(session.id);
  };
}

export function publishRemoteKeyboardCommandResult(input: {
  sessionId: string;
  commandId: string;
  targetUserId: string;
  targetTabId: string;
  status: unknown;
  reason?: unknown;
  now?: number;
}): RemoteKeyboardCommandResult {
  const now = input.now ?? Date.now();
  const session = activeSessionForTarget(input.sessionId, input.targetUserId, input.targetTabId, false);
  const commandId = cleanIdentifier(input.commandId);
  const receipt = commandReceipts.get(commandId);
  if (!receipt || receipt.sessionId !== session.id) {
    throw new RemoteKeyboardControlError("KEYBOARD_COMMAND_NOT_FOUND", 404, "Keyboard command not found.");
  }
  if (input.status !== "executed" && input.status !== "blocked" && input.status !== "ignored") {
    throw new RemoteKeyboardControlError("INVALID_KEYBOARD_RESULT", 400, "Unsupported keyboard command result.");
  }

  const result: RemoteKeyboardCommandResult = {
    commandId,
    sessionId: session.id,
    status: input.status,
    reason: cleanReason(input.reason),
    completedAt: now,
  };
  commandReceipts.delete(commandId);
  notify(resultListeners.get(session.id), result);
  return { ...result };
}

export function subscribeRemoteKeyboardResults(input: {
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

export function cleanupRemoteKeyboardCommandState(now = Date.now()): void {
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
    if (
      !session ||
      session.status !== "active" ||
      !session.capabilities.mouse ||
      !authorization ||
      now >= authorization.expiresAt ||
      !isRemoteSupportEnabled("keyboardControl")
    ) {
      clearSessionKeyboardState(sessionId, !!session && session.status === "active");
    }
  }

  for (const [commandId, receipt] of commandReceipts) {
    if (now - receipt.createdAt > COMMAND_RETENTION_MS) commandReceipts.delete(commandId);
  }
}

export function installRemoteKeyboardSessionStopCleanup(): void {
  if (unsubscribeSessionStopCleanup) return;
  unsubscribeSessionStopCleanup = subscribeRemoteControlSessionStops((session) => {
    clearSessionKeyboardState(session.id, false);
  });
}

export function resetRemoteKeyboardCommandStateForTests(): void {
  unsubscribeSessionStopCleanup?.();
  unsubscribeSessionStopCleanup = null;
  commandListeners.clear();
  resultListeners.clear();
  authorizations.clear();
  commandReceipts.clear();
  sequenceBySession.clear();
  rateWindows.clear();
}

installRemoteKeyboardSessionStopCleanup();
const cleanupTimer = setInterval(() => cleanupRemoteKeyboardCommandState(), 3000);
(cleanupTimer as unknown as { unref?: () => void }).unref?.();

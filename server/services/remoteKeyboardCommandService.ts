import { randomUUID } from "crypto";
import { isRemoteSupportEnabled } from "./remoteSupportRuntime";
import { evaluateRemoteSupportRollout } from "./remoteSupportRollout";
import {
  getRemoteControlSession,
  setRemoteControlKeyboardCapability,
  subscribeRemoteControlSessionStops,
  type RemoteControlSession,
} from "./remoteControlSessionService";

export type RemoteKeyboardCommandType = "insert-text" | "key";
export type RemoteKeyboardCommandResultStatus = "executed" | "blocked" | "ignored";
export type RemoteKeyboardKey =
  | "Backspace"
  | "Delete"
  | "Tab"
  | "Escape"
  | "Enter"
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | "Home"
  | "End"
  | "Space";

export interface RemoteKeyboardCommand {
  id: string;
  sessionId: string;
  targetUserId: string;
  targetTabId: string;
  type: RemoteKeyboardCommandType;
  sequence: number;
  text?: string;
  key?: RemoteKeyboardKey;
  shiftKey: boolean;
  createdAt: number;
}

export interface RemoteKeyboardCommandResult {
  commandId: string;
  sessionId: string;
  status: RemoteKeyboardCommandResultStatus;
  reason: string | null;
  completedAt: number;
}

export interface RemoteKeyboardAuthorization {
  sessionId: string;
  controllerUserId: string;
  authorizedAt: number;
  expiresAt: number;
}

export class RemoteKeyboardControlError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
    /** Milliseconds the controller should wait before retrying, when known. */
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "RemoteKeyboardControlError";
  }
}

type CommandListener = (command: RemoteKeyboardCommand) => void;
type ResultListener = (result: RemoteKeyboardCommandResult) => void;

interface RateWindow {
  startedAt: number;
  count: number;
}

interface RemoteKeyboardCommandReceipt {
  sessionId: string;
  createdAt: number;
}

const PASSWORD_CONFIRMATION_MAX_AGE_MS = 5 * 60 * 1000;
const COMMAND_RETENTION_MS = 2 * 60 * 1000;
const RATE_WINDOW_MS = 1000;
const RATE_LIMIT = 30;
const MAX_TEXT_CODE_POINTS = 64;
const ALLOWED_KEYS = new Set<RemoteKeyboardKey>([
  "Backspace",
  "Delete",
  "Tab",
  "Escape",
  "Enter",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "Space",
]);

const commandListeners = new Map<string, Set<CommandListener>>();
const resultListeners = new Map<string, Set<ResultListener>>();
const authorizations = new Map<string, RemoteKeyboardAuthorization>();
const commandReceipts = new Map<string, RemoteKeyboardCommandReceipt>();
const sequenceBySession = new Map<string, number>();
const rateWindows = new Map<string, RateWindow>();
let unsubscribeSessionStopCleanup: (() => void) | null = null;

function cleanIdentifier(value: unknown, maxLength = 160): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanReason(value: unknown): string | null {
  const reason = cleanIdentifier(value, 160);
  return reason || null;
}

function cleanInsertText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const codePoints = Array.from(value);
  if (codePoints.length === 0 || codePoints.length > MAX_TEXT_CODE_POINTS) return null;

  if (
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  )
    return null;
  return value;
}

function activeSessionForController(
  sessionId: string,
  controllerUserId: string,
  requireKeyboardCapability = true
): RemoteControlSession {
  const session = getRemoteControlSession(cleanIdentifier(sessionId));
  if (!session || session.status !== "active") {
    throw new RemoteKeyboardControlError("SESSION_INACTIVE", 409, "The support session is no longer active.");
  }
  if (session.controllerUserId !== cleanIdentifier(controllerUserId)) {
    throw new RemoteKeyboardControlError("CONTROLLER_MISMATCH", 403, "This controller does not own the session.");
  }
  if (!isRemoteSupportEnabled("remoteControl") || !isRemoteSupportEnabled("keyboardControl")) {
    throw new RemoteKeyboardControlError("KEYBOARD_CONTROL_DISABLED", 409, "Keyboard control is disabled.");
  }
  const rollout = evaluateRemoteSupportRollout({
    companyId: session.companyId,
    controllerUserId: session.controllerUserId,
    controllerRole: session.controllerRole,
  });
  if (!rollout.allowed) {
    throw new RemoteKeyboardControlError(
      rollout.code ?? "REMOTE_SUPPORT_ROLLOUT_BLOCKED",
      409,
      rollout.message ?? "Remote support control is blocked by rollout policy."
    );
  }
  if (!session.capabilities.mouse) {
    throw new RemoteKeyboardControlError(
      "MOUSE_CONTROL_REQUIRED",
      409,
      "Enable mouse control before keyboard control."
    );
  }
  if (requireKeyboardCapability && !session.capabilities.keyboard) {
    throw new RemoteKeyboardControlError("KEYBOARD_CONTROL_DISABLED", 409, "Keyboard control is disabled.");
  }
  return session;
}

function activeSessionForTarget(
  sessionId: string,
  targetUserId: string,
  targetTabId: string,
  requireKeyboardCapability = true
): RemoteControlSession {
  const session = getRemoteControlSession(cleanIdentifier(sessionId));
  if (!session || session.status !== "active") {
    throw new RemoteKeyboardControlError("SESSION_INACTIVE", 409, "The support session is no longer active.");
  }
  if (session.targetUserId !== cleanIdentifier(targetUserId) || session.targetTabId !== cleanIdentifier(targetTabId)) {
    throw new RemoteKeyboardControlError("TARGET_MISMATCH", 403, "This keyboard channel is not bound to this ERP tab.");
  }
  if (
    !isRemoteSupportEnabled("remoteControl") ||
    !isRemoteSupportEnabled("keyboardControl") ||
    (requireKeyboardCapability && !session.capabilities.keyboard)
  ) {
    throw new RemoteKeyboardControlError("KEYBOARD_CONTROL_DISABLED", 409, "Keyboard control is disabled.");
  }
  return session;
}

function notify<T>(listeners: Set<(value: T) => void> | undefined, value: T): number {
  let delivered = 0;
  for (const listener of listeners ?? []) {
    try {
      listener(value);
      delivered += 1;
    } catch {
      // A disconnected stream must not affect other listeners or session state.
    }
  }
  return delivered;
}

function clearSessionKeyboardState(sessionId: string, disableCapability: boolean): void {
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

function assertRateLimit(sessionId: string, now: number): void {
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

function assertKeyboardAuthorization(
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

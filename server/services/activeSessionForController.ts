// Extracted from ./remoteKeyboardCommandService.ts to keep that module under the source-size cap.
import { isRemoteSupportEnabled } from "./remoteSupportRuntime";
import { evaluateRemoteSupportRollout } from "./remoteSupportRollout";
import { getRemoteControlSession, type RemoteControlSession } from "./remoteControlSessionService";

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

export type CommandListener = (command: RemoteKeyboardCommand) => void;

export type ResultListener = (result: RemoteKeyboardCommandResult) => void;

interface RateWindow {
  startedAt: number;
  count: number;
}

interface RemoteKeyboardCommandReceipt {
  sessionId: string;
  createdAt: number;
}

export const PASSWORD_CONFIRMATION_MAX_AGE_MS = 5 * 60 * 1000;

export const COMMAND_RETENTION_MS = 2 * 60 * 1000;

export const RATE_WINDOW_MS = 1000;

export const RATE_LIMIT = 30;

const MAX_TEXT_CODE_POINTS = 64;

export const ALLOWED_KEYS = new Set<RemoteKeyboardKey>([
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

export const commandListeners = new Map<string, Set<CommandListener>>();

export const resultListeners = new Map<string, Set<ResultListener>>();

export const authorizations = new Map<string, RemoteKeyboardAuthorization>();

export const commandReceipts = new Map<string, RemoteKeyboardCommandReceipt>();

export const sequenceBySession = new Map<string, number>();

export const rateWindows = new Map<string, RateWindow>();

export function cleanIdentifier(value: unknown, maxLength = 160): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export function cleanReason(value: unknown): string | null {
  const reason = cleanIdentifier(value, 160);
  return reason || null;
}

export function cleanInsertText(value: unknown): string | null {
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

export function activeSessionForController(
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

export function activeSessionForTarget(
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

export function notify<T>(listeners: Set<(value: T) => void> | undefined, value: T): number {
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

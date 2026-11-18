// Extracted from ./remoteControlWebSocketTransport.ts to keep that module under the source-size cap.
import type { WebSocket } from "ws";
import {
  type RemoteMouseCommand,
  type RemoteMouseCommandResult,
  RemoteMouseControlError,
  subscribeRemoteMouseCommands,
  subscribeRemoteMouseResults,
} from "./remoteControlCommandService";
import {
  type RemoteKeyboardCommand,
  type RemoteKeyboardCommandResult,
  RemoteKeyboardControlError,
} from "./remoteKeyboardCommandService";
import {
  getRemoteControlSession,
  isRemoteControlControllerRole,
  type RemoteControlSession,
} from "./remoteControlSessionService";
import { writeRemoteSupportAudit } from "./remoteSupportAuditService";
import type { ScreenFeedSocketContext } from "./screenFeedWebSocketTransport";

const OPEN = 1;

const AUDIT_RETRY_AFTER_MS = 1000;

type BindingKind = "mouse-target" | "mouse-controller" | "keyboard-target" | "keyboard-controller";

type BindingMap = Map<string, () => void>;

export const bindingsBySocket = new WeakMap<WebSocket, BindingMap>();

export function clean(value: unknown, max = 160): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function requestId(value: unknown): string | null {
  const id = clean(value, 128);
  return id || null;
}

export function sendJson(socket: WebSocket, payload: unknown): void {
  if (socket.readyState !== OPEN) return;
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    // Socket-close cleanup owns teardown.
  }
}

export function response(socket: WebSocket, id: string | null, payload: Record<string, unknown> = {}): void {
  if (!id) return;
  sendJson(socket, { type: "remote-control:response", requestId: id, ok: true, ...payload });
}

export function errorResponse(
  socket: WebSocket,
  id: string | null,
  status: number,
  code: string,
  message: string,
  retryAfterMs?: number
): void {
  sendJson(socket, {
    type: "remote-control:response",
    requestId: id,
    ok: false,
    status,
    code,
    message,
    ...(retryAfterMs ? { retryAfterMs } : {}),
  });
}

export function serializeMouseCommand(command: RemoteMouseCommand) {
  return { ...command, createdAt: new Date(command.createdAt).toISOString() };
}

export function serializeMouseResult(result: RemoteMouseCommandResult) {
  return { ...result, completedAt: new Date(result.completedAt).toISOString() };
}

export function serializeKeyboardCommand(command: RemoteKeyboardCommand) {
  return { ...command, createdAt: new Date(command.createdAt).toISOString() };
}

export function serializeKeyboardResult(result: RemoteKeyboardCommandResult) {
  return { ...result, completedAt: new Date(result.completedAt).toISOString() };
}

export function bindingKey(kind: BindingKind, sessionId: string): string {
  return `${kind}:${sessionId}`;
}

function bindings(socket: WebSocket): BindingMap {
  let map = bindingsBySocket.get(socket);
  if (!map) {
    map = new Map();
    bindingsBySocket.set(socket, map);
  }
  return map;
}

export function installBinding(socket: WebSocket, key: string, unsubscribe: () => void): void {
  const map = bindings(socket);
  map.get(key)?.();
  map.set(key, unsubscribe);
}

export function removeBinding(socket: WebSocket, key: string): void {
  const map = bindingsBySocket.get(socket);
  const unsubscribe = map?.get(key);
  unsubscribe?.();
  map?.delete(key);
}

export function controllerSession(
  context: ScreenFeedSocketContext,
  sessionIdRaw: unknown,
  requireKeyboard = false
): RemoteControlSession {
  const sessionId = clean(sessionIdRaw);
  const session = getRemoteControlSession(sessionId);
  if (!session || session.status !== "active") {
    throw new RemoteMouseControlError("SESSION_INACTIVE", 409, "The support session is no longer active.");
  }
  if (!isRemoteControlControllerRole(context.role) || session.controllerUserId !== context.userId) {
    throw new RemoteMouseControlError("CONTROLLER_MISMATCH", 403, "This controller does not own the session.");
  }
  if (context.role !== "Developer" && context.companyId !== session.companyId) {
    throw new RemoteMouseControlError(
      "SESSION_COMPANY_MISMATCH",
      403,
      "This support session belongs to another company."
    );
  }
  if (!session.capabilities.mouse) {
    throw new RemoteMouseControlError("MOUSE_AUTHORIZATION_REQUIRED", 428, "Mouse control is not authorized.");
  }
  if (requireKeyboard && !session.capabilities.keyboard) {
    throw new RemoteKeyboardControlError("KEYBOARD_AUTHORIZATION_REQUIRED", 428, "Keyboard control is not authorized.");
  }
  return session;
}

export function targetSession(
  context: ScreenFeedSocketContext,
  sessionIdRaw: unknown,
  tabIdRaw: unknown
): RemoteControlSession {
  const sessionId = clean(sessionIdRaw);
  const tabId = clean(tabIdRaw);
  const session = getRemoteControlSession(sessionId);
  if (!session || session.status !== "active") {
    throw new RemoteMouseControlError("SESSION_INACTIVE", 409, "The support session is no longer active.");
  }
  if (session.targetUserId !== context.userId || session.targetTabId !== tabId) {
    throw new RemoteMouseControlError("TARGET_MISMATCH", 403, "This control channel is not bound to this ERP tab.");
  }
  if (context.companyId && context.companyId !== session.targetCompanyId && context.companyId !== session.companyId) {
    throw new RemoteMouseControlError("TARGET_COMPANY_MISMATCH", 403, "This ERP tab belongs to another company.");
  }
  return session;
}

export function commandError(socket: WebSocket, id: string | null, error: unknown): void {
  if (error instanceof RemoteMouseControlError || error instanceof RemoteKeyboardControlError) {
    errorResponse(socket, id, error.statusCode, error.code, error.message, error.retryAfterMs);
    return;
  }
  errorResponse(socket, id, 500, "REMOTE_CONTROL_FAILED", "Unable to process the remote-control command.");
}

export function auditUnavailable(socket: WebSocket, id: string | null): void {
  errorResponse(
    socket,
    id,
    503,
    "REMOTE_SUPPORT_AUDIT_UNAVAILABLE",
    "Remote support auditing is temporarily unavailable. Control remains blocked.",
    AUDIT_RETRY_AFTER_MS
  );
}

export async function recordSensitiveBlock(input: {
  session: RemoteControlSession;
  context: ScreenFeedSocketContext;
  capability: "mouse" | "keyboard";
  commandType: string;
}): Promise<void> {
  try {
    await writeRemoteSupportAudit({
      event: "command_blocked",
      session: input.session,
      actorUserId: input.context.userId,
      actorUsername: input.context.username,
      details: {
        capability: input.capability,
        commandType: input.commandType,
        status: "denied",
        reason: "sensitive-route",
        route: input.session.targetRoute,
      },
    });
  } catch {
    // The command is already denied; audit outage must not turn denial into execution.
  }
}

export function bindMouseTarget(
  socket: WebSocket,
  context: ScreenFeedSocketContext,
  message: Record<string, unknown>
): void {
  const id = requestId(message.requestId);
  try {
    const session = targetSession(context, message.sessionId, message.tabId);
    const key = bindingKey("mouse-target", session.id);
    const unsubscribe = subscribeRemoteMouseCommands({
      sessionId: session.id,
      targetUserId: context.userId,
      targetTabId: session.targetTabId,
      listener: (command) =>
        sendJson(socket, { type: "remote-control:mouse-command", command: serializeMouseCommand(command) }),
    });
    installBinding(socket, key, unsubscribe);
    response(socket, id, { sessionId: session.id, tabId: session.targetTabId, binding: "mouse-target" });
  } catch (error) {
    commandError(socket, id, error);
  }
}

export function bindMouseController(
  socket: WebSocket,
  context: ScreenFeedSocketContext,
  message: Record<string, unknown>
): void {
  const id = requestId(message.requestId);
  try {
    const session = controllerSession(context, message.sessionId);
    const key = bindingKey("mouse-controller", session.id);
    const unsubscribe = subscribeRemoteMouseResults({
      sessionId: session.id,
      controllerUserId: context.userId,
      listener: (result) =>
        sendJson(socket, { type: "remote-control:mouse-result", result: serializeMouseResult(result) }),
    });
    installBinding(socket, key, unsubscribe);
    response(socket, id, { sessionId: session.id, binding: "mouse-controller" });
  } catch (error) {
    commandError(socket, id, error);
  }
}

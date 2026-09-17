import type { WebSocket } from "ws";
import {
  RemoteMouseControlError,
  assertRemoteMouseCommandAdmission,
  publishRemoteMouseCommand,
  publishRemoteMouseCommandResult,
  subscribeRemoteMouseCommands,
  subscribeRemoteMouseResults,
  type RemoteMouseCommand,
  type RemoteMouseCommandResult,
} from "./remoteControlCommandService";
import {
  RemoteKeyboardControlError,
  assertRemoteKeyboardCommandAdmission,
  publishRemoteKeyboardCommand,
  publishRemoteKeyboardCommandResult,
  subscribeRemoteKeyboardCommands,
  subscribeRemoteKeyboardResults,
  type RemoteKeyboardCommand,
  type RemoteKeyboardCommandResult,
} from "./remoteKeyboardCommandService";
import {
  getRemoteControlSession,
  isRemoteControlControllerRole,
  type RemoteControlSession,
} from "./remoteControlSessionService";
import { remoteSupportCommandAuditDetails, writeRemoteSupportAudit } from "./remoteSupportAuditService";
import {
  enqueueRemoteSupportCommandAudit,
  isRemoteSupportCommandAuditAccepting,
} from "./remoteSupportCommandAuditQueue";
import {
  isRemoteKeyboardAllowedOnRoute,
  isRemoteMouseCommandAllowedOnRoute,
} from "./remoteSupportSensitiveActionPolicy";
import type { ScreenFeedSocketContext } from "./screenFeedWebSocketTransport";

const OPEN = 1;
const AUDIT_RETRY_AFTER_MS = 1000;

type BindingKind = "mouse-target" | "mouse-controller" | "keyboard-target" | "keyboard-controller";
type BindingMap = Map<string, () => void>;
const bindingsBySocket = new WeakMap<WebSocket, BindingMap>();

function clean(value: unknown, max = 160): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function requestId(value: unknown): string | null {
  const id = clean(value, 128);
  return id || null;
}

function sendJson(socket: WebSocket, payload: unknown): void {
  if (socket.readyState !== OPEN) return;
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    // Socket-close cleanup owns teardown.
  }
}

function response(socket: WebSocket, id: string | null, payload: Record<string, unknown> = {}): void {
  if (!id) return;
  sendJson(socket, { type: "remote-control:response", requestId: id, ok: true, ...payload });
}

function errorResponse(
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

function serializeMouseCommand(command: RemoteMouseCommand) {
  return { ...command, createdAt: new Date(command.createdAt).toISOString() };
}

function serializeMouseResult(result: RemoteMouseCommandResult) {
  return { ...result, completedAt: new Date(result.completedAt).toISOString() };
}

function serializeKeyboardCommand(command: RemoteKeyboardCommand) {
  return { ...command, createdAt: new Date(command.createdAt).toISOString() };
}

function serializeKeyboardResult(result: RemoteKeyboardCommandResult) {
  return { ...result, completedAt: new Date(result.completedAt).toISOString() };
}

function bindingKey(kind: BindingKind, sessionId: string): string {
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

function installBinding(socket: WebSocket, key: string, unsubscribe: () => void): void {
  const map = bindings(socket);
  map.get(key)?.();
  map.set(key, unsubscribe);
}

function removeBinding(socket: WebSocket, key: string): void {
  const map = bindingsBySocket.get(socket);
  const unsubscribe = map?.get(key);
  unsubscribe?.();
  map?.delete(key);
}

function controllerSession(
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

function targetSession(
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

function commandError(socket: WebSocket, id: string | null, error: unknown): void {
  if (error instanceof RemoteMouseControlError || error instanceof RemoteKeyboardControlError) {
    errorResponse(socket, id, error.statusCode, error.code, error.message, error.retryAfterMs);
    return;
  }
  errorResponse(socket, id, 500, "REMOTE_CONTROL_FAILED", "Unable to process the remote-control command.");
}

function auditUnavailable(socket: WebSocket, id: string | null): void {
  errorResponse(
    socket,
    id,
    503,
    "REMOTE_SUPPORT_AUDIT_UNAVAILABLE",
    "Remote support auditing is temporarily unavailable. Control remains blocked.",
    AUDIT_RETRY_AFTER_MS
  );
}

async function recordSensitiveBlock(input: {
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

function bindMouseTarget(socket: WebSocket, context: ScreenFeedSocketContext, message: Record<string, unknown>): void {
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

function bindMouseController(
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

function bindKeyboardTarget(
  socket: WebSocket,
  context: ScreenFeedSocketContext,
  message: Record<string, unknown>
): void {
  const id = requestId(message.requestId);
  try {
    const session = targetSession(context, message.sessionId, message.tabId);
    if (!session.capabilities.keyboard) {
      throw new RemoteKeyboardControlError(
        "KEYBOARD_AUTHORIZATION_REQUIRED",
        428,
        "Keyboard control is not authorized."
      );
    }
    const key = bindingKey("keyboard-target", session.id);
    const unsubscribe = subscribeRemoteKeyboardCommands({
      sessionId: session.id,
      targetUserId: context.userId,
      targetTabId: session.targetTabId,
      listener: (command) =>
        sendJson(socket, { type: "remote-control:keyboard-command", command: serializeKeyboardCommand(command) }),
    });
    installBinding(socket, key, unsubscribe);
    response(socket, id, { sessionId: session.id, tabId: session.targetTabId, binding: "keyboard-target" });
  } catch (error) {
    commandError(socket, id, error);
  }
}

function bindKeyboardController(
  socket: WebSocket,
  context: ScreenFeedSocketContext,
  message: Record<string, unknown>
): void {
  const id = requestId(message.requestId);
  try {
    const session = controllerSession(context, message.sessionId, true);
    const key = bindingKey("keyboard-controller", session.id);
    const unsubscribe = subscribeRemoteKeyboardResults({
      sessionId: session.id,
      controllerUserId: context.userId,
      listener: (result) =>
        sendJson(socket, { type: "remote-control:keyboard-result", result: serializeKeyboardResult(result) }),
    });
    installBinding(socket, key, unsubscribe);
    response(socket, id, { sessionId: session.id, binding: "keyboard-controller" });
  } catch (error) {
    commandError(socket, id, error);
  }
}

async function publishMouseFromController(
  socket: WebSocket,
  context: ScreenFeedSocketContext,
  message: Record<string, unknown>
): Promise<void> {
  const id = requestId(message.requestId);
  try {
    const session = controllerSession(context, message.sessionId);
    const command =
      message.command && typeof message.command === "object" && !Array.isArray(message.command)
        ? (message.command as Record<string, unknown>)
        : {};
    const type = command.type;
    if (
      (type !== "pointer-move" && type !== "click" && type !== "scroll") ||
      !isRemoteMouseCommandAllowedOnRoute(session.targetRoute, type)
    ) {
      await recordSensitiveBlock({
        session,
        context,
        capability: "mouse",
        commandType: typeof type === "string" ? type : "invalid",
      });
      return errorResponse(
        socket,
        id,
        403,
        "SENSITIVE_REMOTE_ACTION_BLOCKED",
        "Mouse clicks are blocked on this sensitive ERP route."
      );
    }

    assertRemoteMouseCommandAdmission({ sessionId: session.id, controllerUserId: context.userId, type });
    if (!isRemoteSupportCommandAuditAccepting()) return auditUnavailable(socket, id);
    const accepted = enqueueRemoteSupportCommandAudit({
      event: "mouse_command",
      session,
      actorUserId: context.userId,
      actorUsername: context.username,
      details: remoteSupportCommandAuditDetails({ capability: "mouse", commandType: type, route: session.targetRoute }),
    });
    if (!accepted) return auditUnavailable(socket, id);

    const publication = publishRemoteMouseCommand({
      sessionId: session.id,
      controllerUserId: context.userId,
      type,
      x: command.x,
      y: command.y,
      deltaX: command.deltaX,
      deltaY: command.deltaY,
      frameViewport: command.frameViewport,
      admitted: true,
    });
    response(socket, id, {
      command: serializeMouseCommand(publication.command),
      supersededCommandIds: publication.supersededCommandIds,
    });
  } catch (error) {
    commandError(socket, id, error);
  }
}

async function publishKeyboardFromController(
  socket: WebSocket,
  context: ScreenFeedSocketContext,
  message: Record<string, unknown>
): Promise<void> {
  const id = requestId(message.requestId);
  try {
    const session = controllerSession(context, message.sessionId, true);
    const command =
      message.command && typeof message.command === "object" && !Array.isArray(message.command)
        ? (message.command as Record<string, unknown>)
        : {};
    const type = command.type;
    if (!isRemoteKeyboardAllowedOnRoute(session.targetRoute)) {
      await recordSensitiveBlock({
        session,
        context,
        capability: "keyboard",
        commandType: typeof type === "string" ? type : "invalid",
      });
      return errorResponse(
        socket,
        id,
        403,
        "SENSITIVE_REMOTE_ACTION_BLOCKED",
        "Keyboard control is blocked on this sensitive ERP route."
      );
    }

    assertRemoteKeyboardCommandAdmission({ sessionId: session.id, controllerUserId: context.userId });
    if (!isRemoteSupportCommandAuditAccepting()) return auditUnavailable(socket, id);
    const accepted = enqueueRemoteSupportCommandAudit({
      event: "keyboard_command",
      session,
      actorUserId: context.userId,
      actorUsername: context.username,
      details: remoteSupportCommandAuditDetails({
        capability: "keyboard",
        commandType: typeof type === "string" ? type : "invalid",
        key: typeof command.key === "string" ? command.key : undefined,
        text: typeof command.text === "string" ? command.text : undefined,
        route: session.targetRoute,
      }),
    });
    if (!accepted) return auditUnavailable(socket, id);

    const published = publishRemoteKeyboardCommand({
      sessionId: session.id,
      controllerUserId: context.userId,
      type,
      text: command.text,
      key: command.key,
      shiftKey: command.shiftKey,
      admitted: true,
    });
    response(socket, id, { command: serializeKeyboardCommand(published) });
  } catch (error) {
    commandError(socket, id, error);
  }
}

function publishMouseResultFromTarget(
  socket: WebSocket,
  context: ScreenFeedSocketContext,
  message: Record<string, unknown>
): void {
  const id = requestId(message.requestId);
  try {
    const session = targetSession(context, message.sessionId, message.tabId);
    const result = publishRemoteMouseCommandResult({
      sessionId: session.id,
      commandId: clean(message.commandId, 128),
      targetUserId: context.userId,
      targetTabId: session.targetTabId,
      status: message.status,
      reason: message.reason,
    });
    enqueueRemoteSupportCommandAudit({
      event: result.status === "blocked" ? "command_blocked" : "mouse_result",
      session,
      actorUserId: context.userId,
      actorUsername: context.username,
      details: {
        capability: "mouse",
        status: result.status,
        reason: result.reason,
        route: session.targetRoute,
      },
    });
    response(socket, id, { result: serializeMouseResult(result) });
  } catch (error) {
    commandError(socket, id, error);
  }
}

function publishKeyboardResultFromTarget(
  socket: WebSocket,
  context: ScreenFeedSocketContext,
  message: Record<string, unknown>
): void {
  const id = requestId(message.requestId);
  try {
    const session = targetSession(context, message.sessionId, message.tabId);
    const result = publishRemoteKeyboardCommandResult({
      sessionId: session.id,
      commandId: clean(message.commandId, 128),
      targetUserId: context.userId,
      targetTabId: session.targetTabId,
      status: message.status,
      reason: message.reason,
    });
    enqueueRemoteSupportCommandAudit({
      event: result.status === "blocked" ? "command_blocked" : "keyboard_result",
      session,
      actorUserId: context.userId,
      actorUsername: context.username,
      details: {
        capability: "keyboard",
        status: result.status,
        reason: result.reason,
        route: session.targetRoute,
      },
    });
    response(socket, id, { result: serializeKeyboardResult(result) });
  } catch (error) {
    commandError(socket, id, error);
  }
}

/**
 * The socket itself was authenticated once by wsServer's express-session
 * resolver. Control messages below are then constrained to an already-created,
 * already-authorized in-memory support session and exact target tab. This is
 * what removes the per-command session-store + user_company_roles reads.
 */
export async function handleRemoteControlWebSocketMessage(
  socket: WebSocket,
  context: ScreenFeedSocketContext,
  message: Record<string, unknown>
): Promise<boolean> {
  switch (message.type) {
    case "remote-control:bind-mouse-target":
      bindMouseTarget(socket, context, message);
      return true;
    case "remote-control:bind-mouse-controller":
      bindMouseController(socket, context, message);
      return true;
    case "remote-control:bind-keyboard-target":
      bindKeyboardTarget(socket, context, message);
      return true;
    case "remote-control:bind-keyboard-controller":
      bindKeyboardController(socket, context, message);
      return true;
    case "remote-control:unbind-keyboard-target": {
      const sessionId = clean(message.sessionId);
      if (sessionId) removeBinding(socket, bindingKey("keyboard-target", sessionId));
      response(socket, requestId(message.requestId), { sessionId });
      return true;
    }
    case "remote-control:unbind-keyboard-controller": {
      const sessionId = clean(message.sessionId);
      if (sessionId) removeBinding(socket, bindingKey("keyboard-controller", sessionId));
      response(socket, requestId(message.requestId), { sessionId });
      return true;
    }
    case "remote-control:mouse-command":
      await publishMouseFromController(socket, context, message);
      return true;
    case "remote-control:keyboard-command":
      await publishKeyboardFromController(socket, context, message);
      return true;
    case "remote-control:mouse-result":
      publishMouseResultFromTarget(socket, context, message);
      return true;
    case "remote-control:keyboard-result":
      publishKeyboardResultFromTarget(socket, context, message);
      return true;
    default:
      return false;
  }
}

export function cleanupRemoteControlWebSocket(socket: WebSocket): void {
  const map = bindingsBySocket.get(socket);
  if (map) {
    for (const unsubscribe of map.values()) unsubscribe();
    map.clear();
  }
  bindingsBySocket.delete(socket);
}

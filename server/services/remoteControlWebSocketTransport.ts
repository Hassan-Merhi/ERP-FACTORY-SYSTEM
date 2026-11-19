import type { WebSocket } from "ws";
import { publishRemoteMouseCommandResult } from "./remoteControlCommandService";
import {
  RemoteKeyboardControlError,
  assertRemoteKeyboardCommandAdmission,
  publishRemoteKeyboardCommand,
  publishRemoteKeyboardCommandResult,
  subscribeRemoteKeyboardCommands,
} from "./remoteKeyboardCommandService";
import { remoteSupportCommandAuditDetails } from "./remoteSupportAuditService";
import {
  enqueueRemoteSupportCommandAudit,
  isRemoteSupportCommandAuditAccepting,
} from "./remoteSupportCommandAuditQueue";
import { isRemoteKeyboardAllowedOnRoute } from "./remoteSupportSensitiveActionPolicy";
import type { ScreenFeedSocketContext } from "./screenFeedWebSocketTransport";
import {
  auditUnavailable,
  bindMouseController,
  bindMouseTarget,
  bindingKey,
  bindingsBySocket,
  clean,
  commandError,
  controllerSession,
  errorResponse,
  installBinding,
  recordSensitiveBlock,
  removeBinding,
  requestId,
  response,
  sendJson,
  serializeKeyboardCommand,
  serializeKeyboardResult,
  serializeMouseResult,
  targetSession,
} from "./remoteControlWebSocketTransportControllerSession";
import { bindKeyboardController, publishMouseFromController } from "./remoteControlWebSocketTransportHelpers";

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

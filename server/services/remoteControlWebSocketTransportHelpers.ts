// Extracted from ./remoteControlWebSocketTransport.ts
import type { WebSocket } from "ws";
import { assertRemoteMouseCommandAdmission, publishRemoteMouseCommand } from "./remoteControlCommandService";
import { subscribeRemoteKeyboardResults } from "./remoteKeyboardCommandService";
import { remoteSupportCommandAuditDetails } from "./remoteSupportAuditService";
import {
  enqueueRemoteSupportCommandAudit,
  isRemoteSupportCommandAuditAccepting,
} from "./remoteSupportCommandAuditQueue";
import { isRemoteMouseCommandAllowedOnRoute } from "./remoteSupportSensitiveActionPolicy";
import type { ScreenFeedSocketContext } from "./screenFeedWebSocketTransport";
import {
  auditUnavailable,
  bindingKey,
  commandError,
  controllerSession,
  errorResponse,
  installBinding,
  recordSensitiveBlock,
  requestId,
  response,
  sendJson,
  serializeKeyboardResult,
  serializeMouseCommand,
} from "./remoteControlWebSocketTransportControllerSession";

export function bindKeyboardController(
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

export async function publishMouseFromController(
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

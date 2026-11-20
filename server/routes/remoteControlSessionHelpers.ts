// Extracted from ./remoteControlSessionRoutes.ts: shared helpers.
import type { Request, Response } from "express";
import { requireActionAccess } from "../lib/permissionMiddleware";
import { getSessionRole, getSessionUserId, getSessionUsername } from "../lib/requestContext";
import {
  RemoteMouseControlError,
  type RemoteMouseAuthorization,
  type RemoteMouseCommand,
  type RemoteMouseCommandResult,
} from "../services/remoteControlCommandService";
import {
  RemoteControlSessionError,
  isRemoteControlControllerRole,
  type RemoteControlSession,
} from "../services/remoteControlSessionService";
import { type RemoteKeyboardAuthorization } from "../services/remoteKeyboardCommandService";
import { writeRemoteSupportAudit } from "../services/remoteSupportAuditService";

export const STATUS_REFRESH_MS = 5000;

export const COMMAND_HEARTBEAT_MS = 5000;

export const viewPermission = requireActionAccess("remote_support_view");

export const mousePermission = requireActionAccess("remote_support_mouse");

export type FlushableResponse = Response & { flush?: () => void };

export function sessionUserId(req: Request): string {
  const value = getSessionUserId(req);
  return value === null || value === undefined ? "" : String(value);
}

export function sessionUsername(req: Request): string {
  return getSessionUsername(req) || sessionUserId(req);
}

export function sessionRole(req: Request): string {
  return getSessionRole(req) || "";
}

export function passwordConfirmedAt(req: Request): number | null {
  const value = (req.session as { passwordConfirmedAt?: unknown }).passwordConfirmedAt;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function requireController(req: Request, res: Response): boolean {
  if (!isRemoteControlControllerRole(sessionRole(req))) {
    res.status(403).json({ message: "Access denied." });
    return false;
  }
  return true;
}

export function serializeSession(session: RemoteControlSession | null) {
  if (!session) return null;
  return {
    ...session,
    startedAt: new Date(session.startedAt).toISOString(),
    expiresAt: new Date(session.expiresAt).toISOString(),
    lastControllerHeartbeatAt: new Date(session.lastControllerHeartbeatAt).toISOString(),
    lastTargetHeartbeatAt: new Date(session.lastTargetHeartbeatAt).toISOString(),
    stoppedAt: session.stoppedAt ? new Date(session.stoppedAt).toISOString() : null,
  };
}

export function serializeMouseAuthorization(authorization: RemoteMouseAuthorization | null) {
  if (!authorization) return null;
  return {
    ...authorization,
    authorizedAt: new Date(authorization.authorizedAt).toISOString(),
    expiresAt: new Date(authorization.expiresAt).toISOString(),
  };
}

export function serializeKeyboardAuthorization(authorization: RemoteKeyboardAuthorization | null) {
  if (!authorization) return null;
  return {
    ...authorization,
    authorizedAt: new Date(authorization.authorizedAt).toISOString(),
    expiresAt: new Date(authorization.expiresAt).toISOString(),
  };
}

export function serializeMouseCommand(command: RemoteMouseCommand) {
  return {
    ...command,
    createdAt: new Date(command.createdAt).toISOString(),
  };
}

export function serializeMouseCommandResult(result: RemoteMouseCommandResult) {
  return {
    ...result,
    completedAt: new Date(result.completedAt).toISOString(),
  };
}

export function openEventStream(res: Response): void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  // The stream echoes request ids (tab, session); never let a browser sniff it as HTML.
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.flushHeaders();
  res.write("retry: 3000\n\n");
}

/**
 * JSON for an SSE data line. JSON.stringify already escapes newlines, so a value
 * cannot start a new event; <, > and & are escaped too (\u003c, \u003e, \u0026),
 * which clients parse back to the same characters, so no request-supplied string
 * reaches the response as raw markup.
 */
export function eventData(payload: unknown): string {
  return JSON.stringify(payload).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

export function writeEvent(res: Response, event: string, payload: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${eventData(payload)}\n\n`);
  (res as FlushableResponse).flush?.();
}

export function writeHeartbeat(res: Response): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`: heartbeat ${Date.now()}\n\n`);
  (res as FlushableResponse).flush?.();
}

export function handleSessionError(error: unknown, res: Response): void {
  if (error instanceof RemoteControlSessionError || error instanceof RemoteMouseControlError) {
    const retryAfterMs = error instanceof RemoteMouseControlError ? error.retryAfterMs : undefined;
    if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs)) {
      // Controllers coalesce input locally; telling them exactly how long the
      // window has left stops a refused burst from becoming a retry storm.
      res.setHeader("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
      res.status(error.statusCode).json({ code: error.code, message: error.message, retryAfterMs });
      return;
    }
    res.status(error.statusCode).json({ code: error.code, message: error.message });
    return;
  }
  res.status(500).json({ message: "Unable to manage the support session." });
}

export function respondAuditUnavailable(res: Response): void {
  res.status(503).json({
    code: "REMOTE_SUPPORT_AUDIT_UNAVAILABLE",
    message: "Remote support auditing is temporarily unavailable. Control remains blocked.",
  });
}

export async function writeAuditOrUnavailable(input: Parameters<typeof writeRemoteSupportAudit>[0], res: Response) {
  try {
    await writeRemoteSupportAudit(input);
    return true;
  } catch {
    respondAuditUnavailable(res);
    return false;
  }
}

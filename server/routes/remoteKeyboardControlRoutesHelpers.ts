// Extracted from ./remoteKeyboardControlRoutes.ts
import type { Request, Response } from "express";
import { getSessionRole, getSessionUserId, getSessionUsername } from "../lib/requestContext";
import {
  RemoteKeyboardControlError,
  type RemoteKeyboardAuthorization,
  type RemoteKeyboardCommand,
} from "../services/remoteKeyboardCommandService";
import { isRemoteControlControllerRole } from "../services/remoteControlSessionService";
import { writeRemoteSupportAudit } from "../services/remoteSupportAuditService";

export const STREAM_HEARTBEAT_MS = 5000;

type FlushableResponse = Response & { flush?: () => void };

export function sessionUserId(req: Request): string {
  const value = getSessionUserId(req);
  return value === null || value === undefined ? "" : String(value);
}

export function sessionUsername(req: Request): string {
  return getSessionUsername(req) || sessionUserId(req);
}

export function passwordConfirmedAt(req: Request): number | null {
  const value = (req.session as { passwordConfirmedAt?: unknown }).passwordConfirmedAt;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function requireController(req: Request, res: Response): boolean {
  if (!isRemoteControlControllerRole(getSessionRole(req))) {
    res.status(403).json({ message: "Access denied." });
    return false;
  }
  return true;
}

export function openEventStream(res: Response): void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write("retry: 3000\n\n");
}

export function writeEvent(res: Response, event: string, payload: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  (res as FlushableResponse).flush?.();
}

export function writeHeartbeat(res: Response): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`: heartbeat ${Date.now()}\n\n`);
  (res as FlushableResponse).flush?.();
}

export function serializeAuthorization(authorization: RemoteKeyboardAuthorization | null) {
  if (!authorization) return null;
  return {
    ...authorization,
    authorizedAt: new Date(authorization.authorizedAt).toISOString(),
    expiresAt: new Date(authorization.expiresAt).toISOString(),
  };
}

export function serializeCommand(command: RemoteKeyboardCommand) {
  return { ...command, createdAt: new Date(command.createdAt).toISOString() };
}

export function handleError(error: unknown, res: Response): void {
  if (error instanceof RemoteKeyboardControlError) {
    const { retryAfterMs } = error;
    if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs)) {
      // Refusing fast is only useful if the controller knows when to resume.
      res.setHeader("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
      res.status(error.statusCode).json({ code: error.code, message: error.message, retryAfterMs });
      return;
    }
    res.status(error.statusCode).json({ code: error.code, message: error.message });
    return;
  }
  res.status(500).json({ message: "Unable to manage keyboard control." });
}

export function respondAuditUnavailable(res: Response): void {
  res.status(503).json({
    code: "REMOTE_SUPPORT_AUDIT_UNAVAILABLE",
    message: "Remote support auditing is temporarily unavailable. Keyboard control remains blocked.",
  });
}

export async function auditOrBlock(
  input: Parameters<typeof writeRemoteSupportAudit>[0],
  res: Response
): Promise<boolean> {
  try {
    await writeRemoteSupportAudit(input);
    return true;
  } catch {
    respondAuditUnavailable(res);
    return false;
  }
}

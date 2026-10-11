import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

import { hashSessionId, runWithAuditActor } from "../services/audit/auditActorContext";

/**
 * Phase 21 (A), AT2/AT6: every API request runs with its audit context — the
 * signed-in user as actor (none before sign-in), the request id, the client IP,
 * a hash of the session id and an optional `X-Audit-Reason` header. Every
 * database lease the request takes writes them as settings
 * (server/db.ts), so the voucher / line audit trigger and every audit_log
 * insert of the request carry them, whatever route or service writes.
 */
export const AUDIT_REASON_HEADER = "x-audit-reason";

function headerText(value: string | string[] | undefined): string | null {
  const text = Array.isArray(value) ? value[0] : value;
  return text?.trim() || null;
}

export function auditRequestContextMiddleware(req: Request, _res: Response, next: NextFunction): void {
  if (!req.path.startsWith("/api")) {
    next();
    return;
  }
  const session = req.session as { userId?: string | number | null; username?: string | null } | undefined;
  const userId = session?.userId != null ? String(session.userId) : "";
  // requestLogger (mounted before) assigns the id it logs and returns as X-Request-Id.
  const requestId =
    (req as unknown as { requestId?: string }).requestId ?? headerText(req.headers["x-request-id"]) ?? randomUUID();
  runWithAuditActor(
    {
      actorId: userId,
      actorName: session?.username || userId,
      requestId,
      ip: req.ip ?? req.socket?.remoteAddress ?? null,
      sessionHash: userId ? hashSessionId(req.sessionID) : null,
      reason: headerText(req.headers[AUDIT_REASON_HEADER]),
    },
    () => next()
  );
}

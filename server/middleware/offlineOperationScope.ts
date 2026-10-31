import type { NextFunction, Request, Response } from "express";

/**
 * This must run BEFORE the voucher creation handlers. A client-side session
 * check alone races with a different tab switching company. The business write
 * is refused if the session is no longer the recorded operation's owner.
 * Requests without offline headers keep their existing behavior.
 */
export function matchesOfflineOperationScope(input: {
  operationId: string | undefined;
  idempotencyKey: string | undefined;
  bodyRequestId: unknown;
  headerCompanyId: string | undefined;
  headerUserId: string | undefined;
  sessionCompanyId: number | undefined;
  sessionUserId: string | undefined;
}): boolean {
  const id = input.operationId ?? "";
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) &&
    id === input.idempotencyKey &&
    id === input.bodyRequestId &&
    Number.isSafeInteger(input.sessionCompanyId) &&
    Number(input.sessionCompanyId) > 0 &&
    input.headerCompanyId === String(input.sessionCompanyId) &&
    !!input.sessionUserId &&
    input.headerUserId === input.sessionUserId
  );
}

export function enforceOfflineOperationScope(req: Request, res: Response, next: NextFunction): void {
  const operationId = req.get("X-Offline-Operation-Id");
  if (!operationId) {
    next();
    return;
  }
  if (
    req.method !== "POST" ||
    !matchesOfflineOperationScope({
      operationId,
      idempotencyKey: req.get("X-Idempotency-Key"),
      bodyRequestId: req.body?.clientRequestId,
      headerCompanyId: req.get("X-Offline-Company-Id"),
      headerUserId: req.get("X-Offline-User-Id"),
      sessionCompanyId: req.session?.currentCompanyId,
      sessionUserId: req.session?.userId,
    })
  ) {
    res.status(409).json({ code: "OFFLINE_SCOPE_MISMATCH", message: "offline.scopeMismatch" });
    return;
  }
  next();
}

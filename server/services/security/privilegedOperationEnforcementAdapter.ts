import type { NextFunction, Request, Response } from "express";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { AuthorizationDeniedError, type AuthorizationActor } from "./authorizationPolicy";
import {
  PrivilegedOperationError,
  authorizePrivilegedOperation,
  type PrivilegedOperationKind,
} from "./privilegedOperationPolicy";
import { persistSecurityEvent } from "./securityAuditRuntime";
import { hydrateSessionNamedPermissions } from "./namedPermissionService";

export interface PrivilegedRouteOptions {
  domain: "administration" | "accounting" | "inventory" | "factory" | "reporting";
  action: string;
  kind: PrivilegedOperationKind;
  requiredPermission: string;
  sourceType: string;
  expectedConfirmationToken: (companyId: number) => string;
  allowDryRun?: boolean;
}

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function actorFromRequest(req: Request): AuthorizationActor | null {
  const session = req.session;
  const companyId = session.currentCompanyId;
  const role = session.currentRole;
  const userId = session.userId;
  if (!companyId || !role || !userId) return null;
  const permissions = Array.isArray(session.securityPermissions)
    ? session.securityPermissions.filter((item): item is string => typeof item === "string")
    : [];
  return { userId, role, companyId, permissions };
}

function auditUsername(req: Request): string {
  const session = req.session;
  // `currentUsername` is read nowhere else and assigned nowhere in the
  // server; `username` is what login stores.
  return session.username || String(session.userId || "anonymous");
}

async function recordPrivilegedDecision(
  req: Request,
  options: PrivilegedRouteOptions,
  outcome: "allowed" | "denied",
  reasonCode: string
) {
  const session = req.session;
  await persistSecurityEvent(
    db,
    {
      kind: "privileged-operation",
      action: options.action,
      outcome,
      companyId: session.currentCompanyId ?? null,
      actorUserId: session.userId ?? null,
      targetType: options.sourceType,
      targetId: normalizedText(req.body?.sourceId) || null,
      reasonCode,
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
      metadata: {
        domain: options.domain,
        operationKind: options.kind,
        role: session.currentRole ?? null,
        method: req.method,
        path: req.path,
      },
    },
    auditUsername(req)
  );
}

export function requirePrivilegedOperation(options: PrivilegedRouteOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    if (options.allowDryRun && body.dryRun !== false) return next();

    const companyId = req.session.currentCompanyId;
    if (!companyId) {
      try {
        await recordPrivilegedDecision(req, options, "denied", "COMPANY_CONTEXT_REQUIRED");
      } catch (auditError) {
        logger.error("Security audit persistence failed:", { error: auditError });
      }
      return res.status(403).json({ message: "Forbidden" });
    }

    try {
      await hydrateSessionNamedPermissions(db, req.session);
      authorizePrivilegedOperation({
        actor: actorFromRequest(req),
        companyId,
        domain: options.domain,
        action: options.action,
        kind: options.kind,
        requiredPermission: options.requiredPermission,
        reason: normalizedText(body.reason),
        confirmationToken: normalizedText(body.confirmationToken),
        expectedConfirmationToken: options.expectedConfirmationToken(companyId),
        idempotencyKey: normalizedText(body.idempotencyKey),
        sourceType: options.sourceType,
        sourceId: normalizedText(body.sourceId),
        passwordConfirmedAt: req.session.passwordConfirmedAt,
      });
      await recordPrivilegedDecision(req, options, "allowed", "AUTHORIZED");
      return next();
    } catch (error: unknown) {
      if (error instanceof PrivilegedOperationError || error instanceof AuthorizationDeniedError) {
        try {
          await recordPrivilegedDecision(req, options, "denied", error.code);
        } catch (auditError) {
          logger.error("Security audit persistence failed:", { error: auditError });
        }
        return res.status(403).json({ message: "Forbidden" });
      }
      return next(error);
    }
  };
}

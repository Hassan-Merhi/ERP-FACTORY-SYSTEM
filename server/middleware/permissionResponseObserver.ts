/**
 * Permissions Control Center V2 — response observer for monitoring.
 *
 * Classifies every refused API response into a permission signal after it is
 * sent: role or permission denials, cross-company attempts, and 403s that do
 * not carry a recognised permission reason ("unexpected"). It reads only the
 * response status and the `code`/`message` field of a JSON error body; request
 * bodies, query strings, headers and response data are never recorded.
 *
 * Responses whose signal is already recorded at the source (V2 enforcement,
 * role assignment refusals, policy conflicts) are skipped to avoid double
 * counting. The observer never changes a response.
 */
import type { NextFunction, Request, Response } from "express";
import { recordPermissionSignal, type PermissionSignalKind } from "../services/security/permissionMonitor";

const CROSS_COMPANY_CODES: ReadonlySet<string> = new Set([
  "CROSS_COMPANY_ACCESS_DENIED",
  "CROSS_COMPANY_FORBIDDEN",
  "CROSS_COMPANY_REFERENCE_FORBIDDEN",
  "COMPANY_ACCESS_DENIED",
  "TENANT_ACCESS_DENIED",
  "COMPANY_ID_CONFLICT",
  "EDGE_OPERATOR_COMPANY_MISMATCH",
]);

const PERMISSION_CODES: ReadonlySet<string> = new Set([
  "BUSINESS_ACTION_NOT_VERIFIED",
  "BUSINESS_ACTION_DENIED",
  "PERMISSION_REQUIRED",
  "FACTORY_PAGE_ACCESS_DENIED",
  "FACTORY_TAB_ACCESS_DENIED",
  "FACTORY_ROLE_ACCESS_DENIED",
  "FACTORY_COMPANY_ACCESS_REQUIRED",
  "ROLE_NOT_ALLOWED",
  "POS_VIEW_ONLY_WRITE_DENIED",
  "VIEW_ONLY_WRITE_DENIED",
  "ERP_TESTER_SETTINGS_DENIED",
  "SP_PERMISSION_DENIED",
  "PRIVILEGED_MAINTENANCE_ROLE_REQUIRED",
  "PRIVILEGED_MAINTENANCE_PERMISSION_REQUIRED",
  "POLICY_ADMIN_REQUIRED",
  "DEVELOPER_ROLE_ASSIGNMENT_DENIED",
  "SELF_ESCALATION_FORBIDDEN",
  "SYSTEM_ROLE_LOCKED",
  "PROTECTED_POLICY_ACTION",
  "CREATE_ONLY_IMMUTABLE",
  "CSRF_TOKEN_MISMATCH",
]);

/** Already recorded where they happen. */
const RECORDED_AT_SOURCE: ReadonlySet<string> = new Set([
  "PERMISSION_V2_DENIED",
  "PERMISSION_SERVICE_UNAVAILABLE",
  "SELF_ROLE_CHANGE_FORBIDDEN",
  "LAST_COMPANY_ADMINISTRATOR",
  "POLICY_STALE_REVISION",
]);

// Legacy guards that answer with a message only.
const PERMISSION_MESSAGE =
  /^(View Only accounts cannot make changes|ERP Tester accounts cannot access|Forbidden$|Access denied|Insufficient permissions|Only (Admin|a Developer|Admin and Owner|Admin or Owner|Admin\/Developer))/i;

export function classifyRefusal(input: {
  status: number;
  code?: unknown;
  message?: unknown;
  role?: string | null;
}): { kind: PermissionSignalKind; code: string } | null {
  const code = typeof input.code === "string" ? input.code.slice(0, 80) : "";
  if (code && RECORDED_AT_SOURCE.has(code)) return null;
  if (code && CROSS_COMPANY_CODES.has(code)) return { kind: "cross_company_attempt", code };
  if (input.status !== 403) return null;
  if (code && PERMISSION_CODES.has(code)) return { kind: "permission_denied", code };
  const message = typeof input.message === "string" ? input.message : "";
  if (!code && PERMISSION_MESSAGE.test(message)) return { kind: "permission_denied", code: "LEGACY_FORBIDDEN" };
  return { kind: "unexpected_forbidden", code: code || "FORBIDDEN_WITHOUT_CODE" };
}

export function permissionResponseObserver(req: Request, res: Response, next: NextFunction): void {
  if (!req.path.startsWith("/api/")) return next();
  let errorCode: unknown;
  let errorMessage: unknown;
  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode >= 400 && body && typeof body === "object") {
      errorCode = (body as { code?: unknown }).code;
      errorMessage = (body as { message?: unknown }).message;
    }
    return originalJson(body);
  };
  res.on("finish", () => {
    if (res.statusCode !== 403 && res.statusCode !== 400) return;
    const role = req.session?.currentRole ?? null;
    const signal = classifyRefusal({ status: res.statusCode, code: errorCode, message: errorMessage, role });
    if (!signal) return;
    recordPermissionSignal({
      kind: signal.kind,
      code: signal.code,
      companyId: req.session?.currentCompanyId ?? null,
      userId: req.session?.userId ?? null,
      role,
      method: req.method,
      path: req.path,
    });
  });
  next();
}

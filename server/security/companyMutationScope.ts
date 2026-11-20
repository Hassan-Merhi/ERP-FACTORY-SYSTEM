import type { Request } from "express";

/**
 * Session-scoped optimistic write token. A legacy session without an explicit
 * token is still versioned: the first successful set-company changes it away
 * from this sentinel, invalidating old browser tabs even if they switch back.
 */
export const LEGACY_COMPANY_REVISION = "legacy";
export const EXPECTED_COMPANY_ID_HEADER = "x-expected-company-id";
export const EXPECTED_COMPANY_REVISION_HEADER = "x-expected-company-revision";

type CompanyGuardDecision =
  | { allowed: true }
  | { allowed: false; code: "COMPANY_SCOPE_INVALID" | "COMPANY_SESSION_CHANGED" };

const SESSION_LIFECYCLE_PATH = /^\/api\/(?:auth(?:\/|$)|csrf-token\/?$)/;
const GLOBAL_ACCOUNT_PATH =
  /^\/api\/(?:user-preferences(?:\/|$)|language-preference(?:\/|$)|user-presence(?:\/|$)|build-info(?:\/|$)|health(?:\/|$))/;

/** Exempt session/bootstrap and account preferences, never business writes. */
export function isCompanyScopedMutation(method: string, path: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase()) &&
    path.startsWith("/api/") &&
    !SESSION_LIFECYCLE_PATH.test(path) &&
    !GLOBAL_ACCOUNT_PATH.test(path);
}

/**
 * A browser or mobile client that declares its expected company must declare
 * both company ID and revision. Untagged legacy/native requests retain their
 * existing authorization/CSRF checks for backward compatibility.
 *
 * This is a stale-tab guard, not an alternative to route-level authorization.
 */
export function verifyExpectedCompanyMutation(
  req: Pick<Request, "method" | "path" | "headers" | "session">
): CompanyGuardDecision {
  if (!isCompanyScopedMutation(req.method, req.path)) return { allowed: true };
  const companyHeader = req.headers[EXPECTED_COMPANY_ID_HEADER];
  const revisionHeader = req.headers[EXPECTED_COMPANY_REVISION_HEADER];
  if (companyHeader === undefined && revisionHeader === undefined) return { allowed: true };

  const expectedCompanyId =
    typeof companyHeader === "string" && /^\d+$/.test(companyHeader)
      ? Number(companyHeader)
      : NaN;
  if (
    !Number.isSafeInteger(expectedCompanyId) ||
    expectedCompanyId <= 0 ||
    typeof revisionHeader !== "string" ||
    revisionHeader.length === 0 ||
    revisionHeader.length > 80 ||
    !/^[a-zA-Z0-9_-]+$/.test(revisionHeader)
  ) {
    return { allowed: false, code: "COMPANY_SCOPE_INVALID" };
  }

  if (
    Number(req.session?.currentCompanyId) !== expectedCompanyId ||
    (req.session?.companyRevision ?? LEGACY_COMPANY_REVISION) !== revisionHeader
  ) {
    return { allowed: false, code: "COMPANY_SESSION_CHANGED" };
  }
  return { allowed: true };
}

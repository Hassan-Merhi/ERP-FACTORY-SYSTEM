import type { Request, RequestHandler, Response } from "express";

import { logger } from "../lib/logger";
import { isTrustedOriginHost } from "./originHostPolicy";
import {
  EXPECTED_COMPANY_ID_HEADER,
  EXPECTED_COMPANY_REVISION_HEADER,
  isCompanyScopedMutation,
  verifyExpectedCompanyMutation,
} from "./companyMutationScope";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MUTATION_EXEMPT_PATHS = new Set([
  "/api/health",
  "/api/health/db",
  "/api/build-info",
  "/api/boot",
  "/api/user-presence/leave",
]);
const CAPACITOR_ORIGINS = new Set([
  "capacitor://localhost",
  "ionic://localhost",
  "https://localhost",
  "http://localhost",
]);

function rejectBrowserMutation(res: Response, statusCode: number, code: string, message: string) {
  return res.status(statusCode).json({ code, message });
}

function browserSourceAllowed(
  req: Request
):
  | { browserRequest: false }
  | { browserRequest: true; allowed: true }
  | { browserRequest: true; allowed: false; code: string; message: string } {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  const referer = typeof req.headers.referer === "string" ? req.headers.referer : undefined;

  if (!origin && !referer) return { browserRequest: false };
  if (origin && CAPACITOR_ORIGINS.has(origin)) return { browserRequest: true, allowed: true };

  const source = origin ?? referer;
  if (!source) return { browserRequest: false };

  let sourceHost: string;
  try {
    sourceHost = new URL(source).host;
  } catch {
    return {
      browserRequest: true,
      allowed: false,
      code: "CSRF_ORIGIN_INVALID",
      message: "Browser mutation request contained an invalid Origin or Referer.",
    };
  }

  const requestHost = req.headers.host;
  if (!requestHost || !isTrustedOriginHost(sourceHost, requestHost)) {
    return {
      browserRequest: true,
      allowed: false,
      code: "CSRF_ORIGIN_MISMATCH",
      message: "Cross-origin state-changing request rejected by origin guard.",
    };
  }

  return { browserRequest: true, allowed: true };
}

/**
 * Final browser-mutation fail-closed boundary.
 *
 * The older global CSRF middleware intentionally permits native clients that do
 * not send Origin/Referer and permits first-touch unauthenticated auth routes.
 * This boundary preserves those compatibility cases while closing two browser
 * fail-open edges:
 *
 * 1. a present but malformed/opaque Origin (including `Origin: null`) is denied
 *    instead of being treated like a native request; and
 * 2. once a browser session is authenticated, every non-exempt API mutation
 *    must have an established session CSRF token and the exact matching header.
 *
 * The frontend mutation interceptor fetches `/api/csrf-token` before sending a
 * state-changing request, so ordinary browser and Capacitor flows satisfy this
 * boundary without changing route contracts.
 */
export const browserMutationFailClosedBoundary: RequestHandler = (req, res, next) => {
  const method = req.method.toUpperCase();
  if (SAFE_METHODS.has(method)) return next();
  if (!req.path.startsWith("/api")) return next();
  if (MUTATION_EXEMPT_PATHS.has(req.path)) return next();

  // The session middleware may have loaded this request before a sibling
  // tab's company-switch POST finished saving. Refresh the persisted session
  // before admitting a stamped business write, or a stale in-memory snapshot
  // would defeat the revision comparison.
  const hasScopeHeader =
    req.headers[EXPECTED_COMPANY_ID_HEADER] !== undefined ||
    req.headers[EXPECTED_COMPANY_REVISION_HEADER] !== undefined;
  if (
    req.session?.userId &&
    hasScopeHeader &&
    isCompanyScopedMutation(method, req.path) &&
    typeof req.session.reload === "function"
  ) {
    req.session.reload((error) => {
      if (error) {
        logger.warn("Cannot revalidate the active company session before a mutation", {
          module: "security",
          action: "companyMutationSessionReloadFailure",
          path: req.path,
          method,
          userId: req.session?.userId ?? null,
        });
        rejectBrowserMutation(
          res,
          503,
          "COMPANY_SESSION_UNVERIFIED",
          "The active company could not be verified. Retry after the session is available."
        );
        return;
      }
      if (!req.session?.userId) {
        rejectBrowserMutation(res, 401, "SESSION_EXPIRED", "The authenticated session is no longer available.");
        return;
      }
      applyBrowserMutationBoundary(req, res, next, method);
    });
    return;
  }
  return applyBrowserMutationBoundary(req, res, next, method);
};

function applyBrowserMutationBoundary(
  req: Parameters<RequestHandler>[0],
  res: Parameters<RequestHandler>[1],
  next: Parameters<RequestHandler>[2],
  method: string
) {
  // Compare the company's session revision before the route performs any
  // state changes. This check applies to any client that declares the expected
  // session, including native/Capacitor clients without an Origin header.
  if (req.session?.userId) {
    const companyScope = verifyExpectedCompanyMutation(req);
    if (!companyScope.allowed) {
      logger.warn("Company-scoped mutation rejected: the browser session has moved", {
        module: "security",
        action: "companyMutationSessionConflict",
        code: companyScope.code,
        method,
        path: req.path,
        userId: req.session.userId,
        companyId: req.session.currentCompanyId ?? null,
      });
      return rejectBrowserMutation(
        res,
        409,
        companyScope.code,
        companyScope.code === "COMPANY_SCOPE_INVALID"
          ? "The request company scope is invalid."
          : "The active company changed. Review the draft and retry under the correct company."
      );
    }
  }

  const sourceDecision = browserSourceAllowed(req);
  if (!sourceDecision.browserRequest) return next();
  if (!sourceDecision.allowed) {
    logger.warn("Browser mutation rejected by fail-closed origin boundary", {
      module: "security",
      action: "browserMutationOriginRejected",
      code: sourceDecision.code,
      method,
      path: req.path,
      userId: req.session?.userId ?? null,
      companyId: req.session?.currentCompanyId ?? null,
    });
    return rejectBrowserMutation(res, 403, sourceDecision.code, sourceDecision.message);
  }

  if (!req.session?.userId) return next();

  const expected = req.session.csrfToken;
  const received = req.headers["x-csrf-token"];
  if (typeof expected !== "string" || expected.length === 0) {
    logger.warn("Authenticated browser mutation rejected because the session has no CSRF token", {
      module: "security",
      action: "browserMutationMissingSessionCsrf",
      code: "CSRF_TOKEN_REQUIRED",
      method,
      path: req.path,
      userId: req.session.userId,
      companyId: req.session.currentCompanyId ?? null,
    });
    return rejectBrowserMutation(
      res,
      403,
      "CSRF_TOKEN_REQUIRED",
      "CSRF token must be established before an authenticated browser mutation."
    );
  }

  if (typeof received !== "string" || received !== expected) {
    logger.warn("Authenticated browser mutation rejected because the CSRF token did not match", {
      module: "security",
      action: "browserMutationCsrfMismatch",
      code: "CSRF_TOKEN_MISMATCH",
      method,
      path: req.path,
      userId: req.session.userId,
      companyId: req.session.currentCompanyId ?? null,
    });
    return rejectBrowserMutation(res, 403, "CSRF_TOKEN_MISMATCH", "CSRF token missing or invalid.");
  }

  return next();
};

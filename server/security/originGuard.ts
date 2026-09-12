import type { RequestHandler } from "express";

import { logger } from "../lib/logger";
import { isTrustedOriginHost } from "./originHostPolicy";

// ── Phase D: Origin / Referer guard (CSRF defense layer 1) ─────────────────
// Rejects state-changing API requests whose Origin (or Referer fallback) host
// does not match the request host. Blocks classic cross-site form-post CSRF
// attacks regardless of cookie SameSite setting. GET/HEAD/OPTIONS pass through.
// Allowlist: exact same-origin plus explicitly enumerated production host aliases.
// Replit dev URLs naturally satisfy the exact-host rule.
export const ORIGIN_GUARD_EXEMPT_PATHS = new Set<string>([
  "/api/health",
  "/api/health/db",
  "/api/build-info",
  "/api/boot",
  // /api/user-presence/leave is the only sendBeacon-driven write path (fired
  // on tab close from use-presence.ts:53). sendBeacon cannot attach custom
  // headers so it cannot send X-CSRF-Token. The endpoint only marks the user
  // as offline — non-sensitive. The PATCH /api/user-presence heartbeat goes
  // through window.fetch and IS subject to CSRF + Origin enforcement.
  "/api/user-presence/leave",
  // /api/csp-report receives browser-generated violation reports, which carry
  // no X-CSRF-Token and no Origin guarantee. The endpoint is throttled and
  // log-only (see server/security/contentSecurityPolicy.ts), so there is
  // nothing to forge: it accepts best-effort telemetry and always answers 204.
  "/api/csp-report",
]);

export const originGuard: RequestHandler = (req, res, next) => {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  if (!req.path.startsWith("/api")) return next();
  if (ORIGIN_GUARD_EXEMPT_PATHS.has(req.path)) return next();

  const host = req.headers.host;
  if (!host) return next(); // pathological — let downstream handle

  const originHeader = req.headers.origin;
  const refererHeader = req.headers.referer;
  let sourceHost: string | null = null;
  try {
    if (originHeader) sourceHost = new URL(originHeader).host;
    else if (refererHeader) sourceHost = new URL(refererHeader).host;
  } catch {
    sourceHost = null;
  }

  // Native (non-browser) clients (curl, Postman, server-to-server, mobile)
  // typically omit both headers — allow them since they cannot be CSRF'd.
  if (!sourceHost) return next();

  if (isTrustedOriginHost(sourceHost, host)) return next();

  // Capacitor WebView origins — cannot be spoofed by web-based CSRF attacks.
  // iOS:     capacitor://localhost
  // Android: http://localhost or https://localhost (depending on androidScheme)
  // Ionic:   ionic://localhost
  if (
    originHeader &&
    (originHeader === "capacitor://localhost" ||
      originHeader === "http://localhost" ||
      originHeader === "https://localhost" ||
      originHeader === "ionic://localhost")
  )
    return next();

  logger.warn(
    `[OriginGuard] BLOCKED ${method} ${req.path} | host=${host} origin=${originHeader || "-"} referer=${refererHeader || "-"}`
  );
  return res.status(403).json({
    message: "Cross-origin state-changing request rejected by origin guard.",
    code: "CSRF_ORIGIN_MISMATCH",
  });
};

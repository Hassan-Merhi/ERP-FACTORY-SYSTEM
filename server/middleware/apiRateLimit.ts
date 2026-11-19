import type { NextFunction, Request, RequestHandler, Response } from "express";
import rateLimit from "express-rate-limit";

/**
 * Global API rate limiter — the baseline flood/abuse guard for every /api/*
 * route. Narrower limiters (login, privileged mutations) still apply on top.
 *
 * Authenticated callers are bucketed per user, not per IP: factory and POS
 * terminals routinely share one NAT address, so IP-only bucketing would let a
 * single abusive client exhaust the budget for a whole site — or lock the
 * site out. Anonymous callers fall back to per-IP buckets.
 *
 * Authenticated background reads must not exhaust the budget needed for a
 * voucher post or ERP permission check. Use separate capped read, write, and
 * critical-access lanes; anonymous traffic keeps its single IP flood guard.
 * Tune via API_RATE_LIMIT_* (see .env.example).
 */

// NOTE: the tuning variables are read as direct `process.env.X` accesses (not
// through a computed key) so scripts/verify-env-documentation.mjs can see them.
function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const WINDOW_MS = readPositiveInt(process.env.API_RATE_LIMIT_WINDOW_MS, 60_000);
const AUTHED_MAX = readPositiveInt(process.env.API_RATE_LIMIT_MAX, 600);
const AUTHED_WRITE_MAX = readPositiveInt(process.env.API_RATE_LIMIT_WRITE_MAX, 120);
const AUTHED_ACCESS_MAX = readPositiveInt(process.env.API_RATE_LIMIT_ACCESS_MAX, 120);
const ANON_MAX = readPositiveInt(process.env.API_RATE_LIMIT_ANON_MAX, 120);

function clientKey(req: Request): string {
  const sessionUserId = req.session?.userId;
  if (sessionUserId !== undefined && sessionUserId !== null && String(sessionUserId) !== "") {
    return `user:${String(sessionUserId)}`;
  }
  // Same client-IP derivation as the login limiter: left-most X-Forwarded-For
  // entry (Render/Replit terminate TLS in front of us) else the socket.
  const forwarded = req.headers["x-forwarded-for"];
  const first = typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : undefined;
  return `ip:${first || req.socket.remoteAddress || "unknown"}`;
}

function isExempt(req: Request): boolean {
  // CORS preflights must never consume budget.
  if (req.method === "OPTIONS") return true;
  // Only API traffic is limited; static assets and the SPA shell pass through.
  if (!req.path.startsWith("/api")) return true;
  // Liveness/readiness probes and the pre-auth bootstrap endpoints.
  if (req.path === "/api/health" || req.path.startsWith("/api/health/")) return true;
  if (req.path === "/api/build-info" || req.path === "/api/csrf-token") return true;
  return false;
}

function tooManyRequests(_req: Request, res: Response): void {
  res.status(429).json({
    message: "Too many requests. Please slow down and try again shortly.",
    code: "API_RATE_LIMITED",
  });
}

function buildLimiter(max: number): RequestHandler {
  return rateLimit({
    windowMs: WINDOW_MS,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: clientKey,
    skip: isExempt,
    handler: tooManyRequests,
  });
}

// These reads are needed to keep an already authenticated ERP/Factory shell
// available. They receive their own finite budget, not an unbounded exemption.
const CRITICAL_AUTHED_READS = new Set([
  "/api/auth/me",
  "/api/my-erp-pages",
  "/api/factory/my-access",
]);

const authedReadLimiter = buildLimiter(AUTHED_MAX);
const authedWriteLimiter = buildLimiter(AUTHED_WRITE_MAX);
const authedAccessLimiter = buildLimiter(AUTHED_ACCESS_MAX);
const anonLimiter = buildLimiter(ANON_MAX);

export function apiRateLimit(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    anonLimiter(req, res, next);
    return;
  }

  const method = req.method.toUpperCase();
  // Never let read-heavy pages, polling or a QA harness cause a normal manual
  // voucher write to fail with API_RATE_LIMITED. Financial writes still have a
  // bounded budget; route-specific security limiters continue to apply.
  const limiter =
    (method === "GET" || method === "HEAD") && CRITICAL_AUTHED_READS.has(req.path)
      ? authedAccessLimiter
      : method === "GET" || method === "HEAD" || method === "OPTIONS"
        ? authedReadLimiter
        : authedWriteLimiter;
  limiter(req, res, next);
}

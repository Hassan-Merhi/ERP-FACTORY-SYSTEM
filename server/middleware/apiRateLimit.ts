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
 * Budgets are generous on purpose (~10 req/s sustained per signed-in user):
 * this lane exists to stop floods and scrapers, not to police normal ERP,
 * POS, and polling traffic. Tune via API_RATE_LIMIT_* (see .env.example).
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

const authedLimiter = buildLimiter(AUTHED_MAX);
const anonLimiter = buildLimiter(ANON_MAX);

export function apiRateLimit(req: Request, res: Response, next: NextFunction): void {
  const limiter = req.session?.userId ? authedLimiter : anonLimiter;
  limiter(req, res, next);
}

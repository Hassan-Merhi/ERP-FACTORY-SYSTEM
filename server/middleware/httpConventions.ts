/**
 * HTTP response conventions shared by the API surface.
 *
 * Three small middlewares extracted from server/index.ts, each preserving its
 * original position in the middleware chain (callers register them in order):
 *   - buildVersionHeader: X-Build-Version on every response, so the frontend
 *     can detect server updates.
 *   - apiNoCache: disables HTTP-level caching for all /api routes. Without
 *     this, Express generates ETags and the browser returns 304 "Not Modified"
 *     for every subsequent request — causing TanStack Query's
 *     invalidateQueries to have no effect.
 *   - slowRequestLogger: logs slow API responses on res.finish; never logs
 *     response bodies.
 */
import type { RequestHandler } from "express";
import { log } from "../vite";

export function buildVersionHeader(buildVersion: string): RequestHandler {
  return (_req, res, next) => {
    res.setHeader("X-Build-Version", buildVersion);
    next();
  };
}

export const apiNoCache: RequestHandler = (req, res, next) => {
  if (req.path.startsWith("/api")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
  next();
};

// Structured request logging — never logs response bodies to avoid leaking sensitive data.
export const slowRequestLogger: RequestHandler = (req, res, next) => {
  const start = Date.now();
  const reqPath = req.path;
  res.on("finish", () => {
    const duration = Date.now() - start;
    if (reqPath.startsWith("/api") && duration > 500) {
      log(`[SLOW API] ${req.method} ${reqPath} ${res.statusCode} in ${duration}ms`);
    }
  });
  next();
};

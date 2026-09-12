/**
 * CSRF synchroniser-token middleware (ENFORCING by default).
 *
 * Generates a per-session CSRF token, exposes it via GET /api/csrf-token, and
 * inspects state-changing requests for a matching X-CSRF-Token header. The
 * frontend's window.fetch interceptor (client/src/lib/queryClient.ts) auto-
 * attaches the token to every state-changing /api/* request — covering both
 * apiRequest() callers and the ~350 raw fetch sites in legacy pages. Set
 * CSRF_ENFORCE=0 to fall back to warn-only mode if a regression surfaces.
 * Extracted from server/index.ts; behaviour is unchanged.
 */
import type { Express } from "express";
import { randomBytes } from "crypto";
import { logger } from "../lib/logger";
import { ORIGIN_GUARD_EXEMPT_PATHS } from "./originGuard";

export function registerCsrfProtection(app: Express): void {
  const CSRF_ENFORCE = process.env.CSRF_ENFORCE !== "0";
  app.get("/api/csrf-token", (req, res) => {
    const sess = req.session;
    if (!sess.csrfToken) {
      sess.csrfToken = randomBytes(32).toString("hex");
    }
    res.json({ csrfToken: sess.csrfToken });
  });
  app.use((req, res, next) => {
    const method = req.method.toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
    if (!req.path.startsWith("/api")) return next();
    if (ORIGIN_GUARD_EXEMPT_PATHS.has(req.path)) return next();
    if (req.path === "/api/csrf-token") return next();

    const sess = req.session;
    const expected: string | undefined = sess?.csrfToken;
    const got = req.headers["x-csrf-token"];

    // No token in session yet means user is not authenticated / hasn't fetched one.
    // Don't gate auth/login endpoints on CSRF — first-touch endpoints by design.
    if (!expected) return next();

    if (typeof got === "string" && got === expected) return next();

    if (CSRF_ENFORCE) {
      logger.warn(
        `[CSRF] BLOCKED ${method} ${req.path} | expected=${expected.slice(0, 8)}… got=${typeof got === "string" ? got.slice(0, 8) + "…" : "<missing>"}`
      );
      return res.status(403).json({
        message: "CSRF token missing or invalid.",
        code: "CSRF_TOKEN_MISMATCH",
      });
    } else {
      logger.warn(`[CSRF warn-only] ${method} ${req.path} | got=${typeof got === "string" ? "present" : "missing"}`);
      next();
    }
  });
}

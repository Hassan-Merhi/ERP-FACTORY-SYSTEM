import type { Express, Request, Response } from "express";
import express from "express";
import type helmet from "helmet";

import { logger } from "../lib/logger";

export type CspMode = "off" | "report-only" | "enforce";

/**
 * The policy ships report-only in production by default: violations are
 * collected at /api/csp-report without breaking the app. Set CSP_ENFORCE=true
 * to switch the same policy to enforcing once the report stream is clean.
 * Outside production the header stays off (Vite HMR relies on inline scripts)
 * unless CSP_ENFORCE=true is set explicitly to preview enforcement locally.
 */
export function resolveCspMode(env: NodeJS.ProcessEnv = process.env): CspMode {
  if (env.CSP_ENFORCE === "true") return "enforce";
  if (env.NODE_ENV === "production") return "report-only";
  return "off";
}

const CSP_DIRECTIVES: Record<string, string[]> = {
  "default-src": ["'self'"],
  // The production bundle is external module scripts only (client/index.html
  // carries no inline scripts), so scripts stay locked to 'self'.
  "script-src": ["'self'"],
  // 'unsafe-inline' is required for React/Radix inline styles and the app's
  // own <style> blocks; Google Fonts serves the Inter/JetBrains stylesheets.
  "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
  // https: covers operator-configured external logos; data:/blob: cover QR
  // codes, label previews, and in-memory exports.
  "img-src": ["'self'", "https:", "data:", "blob:"],
  "font-src": ["'self'", "data:", "https://fonts.gstatic.com"],
  // ws:/wss: cover the realtime socket; the font origins cover preconnect hints.
  "connect-src": ["'self'", "ws:", "wss:", "https://fonts.googleapis.com", "https://fonts.gstatic.com"],
  "media-src": ["'self'", "blob:", "data:"],
  "object-src": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
  "frame-ancestors": ["'self'"],
  "report-uri": ["/api/csp-report"],
};

type HelmetCspOption = NonNullable<Parameters<typeof helmet>[0]>["contentSecurityPolicy"];

export function helmetContentSecurityPolicyOption(env: NodeJS.ProcessEnv = process.env): HelmetCspOption {
  const mode = resolveCspMode(env);
  if (mode === "off") return false;
  return { directives: CSP_DIRECTIVES, reportOnly: mode === "report-only" };
}

// ── Violation report collection ─────────────────────────────────────────────
// Browsers POST reports unauthenticated and without CSRF tokens, so
// /api/csp-report is exempt from the origin/CSRF guards (see
// ORIGIN_GUARD_EXEMPT_PATHS) and throttled here instead: one log line per
// directive per window, with a bounded key set so a flood cannot grow memory.

const REPORT_THROTTLE_MS = 5 * 60 * 1000;
const REPORT_THROTTLE_MAX_KEYS = 200;
const REPORT_LOG_MAX_CHARS = 200;
const recentCspReports = new Map<string, number>();

function shouldLogCspReport(key: string, now: number): boolean {
  const last = recentCspReports.get(key);
  if (last !== undefined && now - last < REPORT_THROTTLE_MS) return false;
  recentCspReports.set(key, now);
  if (recentCspReports.size > REPORT_THROTTLE_MAX_KEYS) {
    const oldest = recentCspReports.keys().next();
    if (!oldest.done) recentCspReports.delete(oldest.value);
  }
  return true;
}

export function resetCspReportThrottleForTests(): void {
  recentCspReports.clear();
}

function asLogSnippet(value: unknown): string {
  if (typeof value !== "string") return "";
  // Strip any query string before logging: a blocked URI must never smuggle
  // tokens or PII into the logs.
  return value.split("?")[0].slice(0, REPORT_LOG_MAX_CHARS);
}

function readCspReportPayload(body: unknown): { directive: string; blocked: string } {
  if (typeof body !== "object" || body === null) return { directive: "", blocked: "" };
  const record = body as Record<string, unknown>;
  const nested = record["csp-report"];
  const report = (typeof nested === "object" && nested !== null ? nested : record) as Record<string, unknown>;
  return {
    directive: asLogSnippet(report["effective-directive"] ?? report["violated-directive"]),
    blocked: asLogSnippet(report["blocked-uri"] ?? report["blockedURL"]),
  };
}

export function registerCspReportRoute(app: Express): void {
  app.post(
    "/api/csp-report",
    express.json({ type: ["application/json", "application/csp-report"], limit: "100kb" }),
    (req: Request, res: Response) => {
      const { directive, blocked } = readCspReportPayload(req.body as unknown);
      const key = `${directive}|${blocked}`;
      if (shouldLogCspReport(key, Date.now())) {
        logger.warn("[CSP] policy violation reported", {
          directive: directive || "unknown",
          blocked: blocked || "unknown",
        });
      }
      // Reports are best-effort telemetry: always acknowledge.
      res.sendStatus(204);
    }
  );
}

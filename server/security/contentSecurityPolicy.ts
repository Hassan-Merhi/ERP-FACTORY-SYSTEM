import type { Express, Request, Response } from "express";
import express from "express";

import { logger } from "../lib/logger";

/**
 * Violation reports for the Content-Security-Policy. The policy itself is
 * built and enforced in server/security/securityHeaders.ts, which points
 * report-uri here.
 */
export const CSP_REPORT_PATH = "/api/csp-report";

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
    CSP_REPORT_PATH,
    express.json({ type: ["application/json", "application/csp-report"], limit: "100kb" }),
    (req: Request, res: Response) => {
      const { directive, blocked } = readCspReportPayload(req.body as unknown);
      const key = `${directive}|${blocked}`;
      if (shouldLogCspReport(key, Date.now())) {
        const detail = {
          event: "security.csp_report",
          directive: directive || "unknown",
          blocked: blocked || "unknown",
        };
        // The directive and blocked URI go in the message itself: the pretty log
        // format prints only whitelisted context keys, so they would be dropped
        // from the context alone, leaving reports that cannot be acted on.
        const summary = `${detail.directive} blocked ${detail.blocked}`;
        logger.warn(`[CSP] enforced policy violation reported: ${summary}`, detail);
      }
      // Reports are best-effort telemetry: always acknowledge.
      res.sendStatus(204);
    }
  );
}

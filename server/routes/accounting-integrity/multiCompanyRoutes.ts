/**
 * Phase 26 multi-company routes (accounting audit):
 *
 *   GET  /api/accounting/consolidation?parentCompanyId=&asOf=&from=   financial-report roles; the
 *        consolidated trial balance, balance sheet and P&L of the group (consolidationService.ts;
 *        phase 27 builds the page and export on it)
 *   GET  /api/accounting/multi-company/diagnostic                      Admin/Owner, read-only
 *   GET  /api/accounting/cross-company-lines/plan?owner=&accountMap=   Owner/Admin, read-only plan (MC-10)
 *   POST /api/accounting/cross-company-lines/apply                     Owner, { confirm: true, planHash, owner?, accountMap? }
 *
 * All act on the session's current company (the consolidation on its group).
 */
import type { Express, Request, Response } from "express";

import { requireAuth, requireRole } from "../../auth";
import { closedPeriodErrorResponse } from "../../lib/closedPeriodError";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { getAccessibleCompanyIds } from "../../security/companyAccessBoundary";
import { companyBusinessDate } from "../../services/accounting/companyBusinessDate";
import { ConsolidationRefusal, buildConsolidation } from "../../services/accounting/consolidation/consolidationService";
import {
  CrossCompanyReclassRefusal,
  applyCrossCompanyLineReclass,
  planCrossCompanyLineReclass,
  type CrossCompanyLineOwner,
} from "../../services/accounting/intercompany/crossCompanyLineReclass";
import { runMultiCompanyDiagnostic } from "../../services/accounting/intercompany/multiCompanyDiagnostic";
import { IntercompanyScopeError } from "../../services/accounting/intercompany/intercompanyScope";
import { resolveRequestCompanyId } from "../../services/security/requestCompanyScope";
import { storage } from "../../storage";
import { requireFinancialReportAccess } from "../stats/financialReportAccess";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PLAN_HASH = /^[0-9a-f]{64}$/;

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function reclassOptions(
  source: Record<string, unknown> | undefined
): { owner: CrossCompanyLineOwner; accountMap: Record<string, number> } | string {
  const owner = source?.owner ?? "account-company";
  if (owner !== "account-company" && owner !== "voucher-company") {
    return "owner must be account-company or voucher-company";
  }
  let raw: unknown = source?.accountMap ?? {};
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return "accountMap must be a JSON object of account ids";
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "accountMap must be an object of account ids";
  const accountMap: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const from = Number(key);
    const to = Number(value);
    if (!Number.isSafeInteger(from) || from <= 0 || !Number.isSafeInteger(to) || to <= 0) {
      return "accountMap must map account ids to account ids";
    }
    accountMap[String(from)] = to;
  }
  return { owner, accountMap };
}

function sendRefusal(res: Response, error: unknown): boolean {
  if (error instanceof ConsolidationRefusal || error instanceof CrossCompanyReclassRefusal) {
    res.status(error.status).json({
      code: error.code,
      message: error.message,
      ...(error instanceof ConsolidationRefusal ? error.details : {}),
    });
    return true;
  }
  if (error instanceof IntercompanyScopeError) {
    res.status(error.status).json({ code: error.code, message: error.message });
    return true;
  }
  const closed = closedPeriodErrorResponse(error);
  if (closed) {
    res.status(closed.status).json(closed.body);
    return true;
  }
  return false;
}

export function registerMultiCompanyRoutes(app: Express): void {
  app.get(
    "/api/accounting/consolidation",
    requireAuth,
    requireFinancialReportAccess,
    async (req: Request, res: Response) => {
      try {
        const companyId = resolveRequestCompanyId(req);
        const requested = req.query.parentCompanyId ? Number(req.query.parentCompanyId) : null;
        if (requested !== null && (!Number.isSafeInteger(requested) || requested <= 0)) {
          return res.status(400).json({ message: "Invalid parentCompanyId" });
        }
        const parentCompanyId = requested ?? (await storage.getParentCompanyId(companyId)) ?? companyId;
        const asOf = req.query.asOf ? req.query.asOf : await companyBusinessDate(companyId);
        if (!isIsoDate(asOf)) return res.status(400).json({ message: "Invalid date" });
        const from = req.query.from ?? null;
        if (from !== null && (!isIsoDate(from) || from > asOf))
          return res.status(400).json({ message: "Invalid date" });
        const allowedCompanyIds = await getAccessibleCompanyIds(String(req.session.userId ?? ""));
        res.json(await buildConsolidation({ parentCompanyId, asOf, from, allowedCompanyIds }));
      } catch (error: unknown) {
        if (sendRefusal(res, error)) return;
        logger.error("GET /api/accounting/consolidation error", { error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.get(
    "/api/accounting/multi-company/diagnostic",
    requireAuth,
    requireRole("Admin", "Owner"),
    async (req: Request, res: Response) => {
      try {
        res.json(await runMultiCompanyDiagnostic(resolveRequestCompanyId(req)));
      } catch (error: unknown) {
        logger.error("GET /api/accounting/multi-company/diagnostic error", { error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.get(
    "/api/accounting/cross-company-lines/plan",
    requireAuth,
    requireRole("Owner", "Admin"),
    async (req: Request, res: Response) => {
      try {
        const options = reclassOptions(req.query as Record<string, unknown>);
        if (typeof options === "string") return res.status(400).json({ message: options });
        res.json(await planCrossCompanyLineReclass(resolveRequestCompanyId(req), options));
      } catch (error: unknown) {
        logger.error("GET /api/accounting/cross-company-lines/plan error", { error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.post(
    "/api/accounting/cross-company-lines/apply",
    requireAuth,
    requireRole("Owner"),
    async (req: Request, res: Response) => {
      try {
        if (req.body?.confirm !== true) return res.status(400).json({ message: "Confirmation is required" });
        const planHash = req.body?.planHash;
        if (typeof planHash !== "string" || !PLAN_HASH.test(planHash)) {
          return res.status(400).json({ message: "The reviewed plan hash is required" });
        }
        const options = reclassOptions(req.body);
        if (typeof options === "string") return res.status(400).json({ message: options });
        const result = await applyCrossCompanyLineReclass(resolveRequestCompanyId(req), {
          ...options,
          planHash,
          actor: {
            userId: String(req.session.userId ?? ""),
            username: req.session.username || String(req.session.userId ?? "unknown"),
          },
        });
        res.json({ applied: true, ...result });
      } catch (error: unknown) {
        if (sendRefusal(res, error)) return;
        logger.error("POST /api/accounting/cross-company-lines/apply error", { error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}

/** Phase 9 — authorized multi-company, read-only ledger consolidation routes. */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth";
import { getAccessibleCompanyIds } from "../security/companyAccessBoundary";
import { storage } from "../storage";
import { getClientDate } from "../lib/dateUtils";
import { getErrorMessage } from "../lib/httpHandlers";
import { consolidatedAccountingReport } from "../services/accounting/groupConsolidationService";
import { intercompanyTransferEvidence } from "../services/accounting/groupTransferEvidence";

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const querySchema = z.object({
  asOfDate: iso.optional(),
  fromDate: iso.optional(),
  companyIds: z.string().min(1).max(350),
});
function businessDay(req: Request) {
  return getClientDate(req);
}
function validDay(s: string) {
  const t = new Date(s + "T00:00:00.000Z");
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(t.valueOf()) && t.toISOString().slice(0, 10) === s;
}
function companyIds(raw: string) {
  if (!/^\d+(,\d+)*$/.test(raw))
    throw Object.assign(new Error("companyIds must be a comma-separated list of company IDs"), { status: 400 });
  const v = [...new Set(raw.split(",").map(Number))];
  if (!v.length || v.length > 50 || v.some((n) => !Number.isSafeInteger(n) || n < 1))
    throw Object.assign(new Error("Choose between 1 and 50 valid companies"), { status: 400 });
  return v;
}
async function allowedCompanies(req: Request) {
  const id = String(req.session?.userId ?? req.user?.id ?? "").trim();
  if (!id) throw Object.assign(new Error("Authenticated user not available"), { status: 401 });
  return getAccessibleCompanyIds(id);
}
function sendError(res: Response, error: unknown) {
  if (error instanceof z.ZodError)
    return res.status(400).json({
      code: "CONSOLIDATION_INVALID_REQUEST",
      message: error.issues.map((x) => x.message).join("; "),
    });
  const e = error as { status?: number; message?: string };
  const msg = getErrorMessage(error);
  const status =
    e?.status ??
    (/not authorized|not accessible|outside the authorized/i.test(msg)
      ? 403
      : /invalid|selected|select |must contain|USD functional currency/i.test(msg)
        ? 400
        : 500);
  return res.status(status).json({
    code:
      status === 403
        ? "CONSOLIDATION_ACCESS_DENIED"
        : status === 400
          ? "CONSOLIDATION_INVALID_REQUEST"
          : "CONSOLIDATION_FAILED",
    message: status === 500 ? "Could not calculate the intercompany report" : msg,
  });
}
async function validated(req: Request) {
  const parsed = querySchema.parse(req.query);
  const allowed = await allowedCompanies(req);
  const ids = companyIds(parsed.companyIds);
  if (ids.some((id) => !allowed.has(id)))
    throw Object.assign(new Error("Selected company is not authorized for this user"), { status: 403 });
  const all = await storage.getAllCompanies();
  if (ids.some((id) => !all.some((c) => c.id === id && c.active !== false)))
    throw Object.assign(new Error("Selected company is inactive or unavailable"), { status: 400 });
  const asOfDate = parsed.asOfDate ?? businessDay(req);
  const fromDate = parsed.fromDate ?? asOfDate.slice(0, 4) + "-01-01";
  if (!validDay(asOfDate) || !validDay(fromDate) || fromDate > asOfDate)
    throw Object.assign(new Error("Invalid fromDate or asOfDate accounting period"), { status: 400 });
  return { allowed, ids, asOfDate, fromDate };
}
export function registerGroupConsolidationRoutes(app: Express) {
  const gate = [requireAuth, requireRole("Admin", "Owner", "Developer")] as const;
  app.get("/api/accounting/consolidation/companies", ...gate, async (req, res) => {
    try {
      const allowed = await allowedCompanies(req);
      const all = await storage.getAllCompanies();
      const items = all
        .filter((c) => c.active !== false && allowed.has(c.id))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((c) => ({
          id: c.id,
          code: c.code,
          name: c.name,
          companyType: c.companyType,
          baseCurrency: c.baseCurrency ?? "USD",
          parentCompanyId: c.parentCompanyId ?? null,
        }));
      res.setHeader("Cache-Control", "no-store");
      return res.json({ companies: items, scope: "authorized-active-companies" });
    } catch (e) {
      return sendError(res, e);
    }
  });
  app.get("/api/accounting/consolidation/report", ...gate, async (req, res) => {
    try {
      const params = await validated(req);
      const report = await consolidatedAccountingReport({
        allowedCompanyIds: params.allowed,
        selectedCompanyIds: params.ids,
        asOfDate: params.asOfDate,
        fromDate: params.fromDate,
      });
      res.setHeader("Cache-Control", "no-store");
      return res.json(report);
    } catch (e) {
      return sendError(res, e);
    }
  });
  app.get("/api/accounting/consolidation/transfers", ...gate, async (req, res) => {
    try {
      const params = await validated(req);
      const result = await intercompanyTransferEvidence({
        allowedCompanyIds: params.allowed,
        companyIds: params.ids,
        asOfDate: params.asOfDate,
      });
      res.setHeader("Cache-Control", "no-store");
      return res.json(result);
    } catch (e) {
      return sendError(res, e);
    }
  });
}

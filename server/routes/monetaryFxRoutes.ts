/**
 * Phase 5: shared FX reporting and explicitly requested realized FX journals.
 * The session company always decides tenant scope; client cannot select it.
 */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth";
import { db } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { companyBusinessDate } from "../services/accounting/companyBusinessDate";
import { datedMonetaryRateTx, fxDay, MonetaryFxError } from "../services/accounting/monetaryFxRates";
import { monetaryAccountValuationTx } from "../services/accounting/monetaryFxValuation";
import { getManualFxCorrectionPreflight } from "../services/accounting/manualFxCorrectionPreflight";
import { applyFxCorrection, previewFxCorrection, FxCorrectionError } from "../services/accounting/fxRevaluationCorrection";
import { verifyManualFxCorrection } from "../services/accounting/manualFxCorrectionVerification";
import { getZambiaSalesNetPositionReconciliation } from "../services/accounting/zambiaSalesNetPositionReconciliation";
import { previewRealizedFxTx, listRealizedFxTx, recognizeRealizedFxTx } from "../services/accounting/realizedFxService";
import {
  UNIFIED_FINANCIAL_POSTING_LOCKED,
  UNIFIED_FINANCIAL_POSTING_RELEASED,
} from "../middleware/unifiedAccountingRolloutBoundary";

const positive = z.coerce.number().int().positive();
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional();
const cashBank = z.object({ accountKind: z.enum(["bank", "ledger"]), accountId: positive, asOfDate: date });
const realizedFilter = z.object({
  domain: z.enum(["customer", "supplier", "factory_supplier"]).optional(),
  partyId: positive.optional(),
  asOfDate: date,
});
function company(req: Request) {
  const id = Number(req.session.currentCompanyId);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new MonetaryFxError("FX_COMPANY_REQUIRED", "Select an accounting company", 400);
  return id;
}
const actor = (req: Request) => ({
  userId: String(req.session.userId ?? ""),
  username: String(req.session.username ?? req.session.userId ?? "unknown"),
});
function fail(res: Response, e: unknown) {
  if (e instanceof z.ZodError)
    return res.status(400).json({ code: "FX_REQUEST_INVALID", message: e.issues.map((x) => x.message).join("; ") });
  if (e instanceof MonetaryFxError) return res.status(e.status).json({ code: e.code, message: e.message });
  if (e instanceof FxCorrectionError) return res.status(e.status).json({ code: e.code, message: e.message });
  return res.status(500).json({ code: "FX_INTERNAL_ERROR", message: getErrorMessage(e) });
}
export function registerMonetaryFxRoutes(app: Express): void {
  // Owner/Admin only. Preview has no side effects; commit verifies the preview
  // again, then exact-reverses and reposts in one audited transaction.
  app.get("/api/accounting/monetary-fx/revaluation/:id/correction-preview",
    requireAuth, requireRole("Admin", "Owner"), async (req, res) => {
      try {
        const c = company(req), voucherId = positive.parse(req.params.id);
        const { targetDate } = z.object({ targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.query);
        return res.json((await previewFxCorrection(c, voucherId, targetDate)).preview);
      } catch (e) { return fail(res, e); }
    }
  );
  app.post("/api/accounting/monetary-fx/revaluation/:id/correct",
    requireAuth, requireRole("Admin", "Owner"), async (req, res) => {
      try {
        const c = company(req), voucherId = positive.parse(req.params.id);
        const body = z.object({
          targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          previewKey: z.string().length(64),
          reason: z.string().trim().min(10).max(1000),
        }).parse(req.body);
        return res.status(201).json(await applyFxCorrection({
          companyId: c, voucherId, actor: actor(req), ...body,
        }));
      } catch (e) { return fail(res, e); }
    }
  );

  const gate = [requireAuth, requireRole("Admin", "Owner", "Developer")] as const;
  // Core ERP/Factory/Rental currency set. Never manufacture a rate for
  // dates without an actual company exchange-rate record.
  app.get("/api/accounting/monetary-fx/rates", ...gate, async (req, res) => {
    try {
      const input = z.object({ asOfDate: date }).parse(req.query),
        c = company(req);
      const asOfDate = fxDay(input.asOfDate ?? (await companyBusinessDate(c)));
      const currencies = ["USD", "EUR", "AUD", "GBP", "CDF", "CFA"];
      const rates = await db.transaction(async (tx) => {
        const rows = [];
        for (const code of currencies) {
          const rate = await datedMonetaryRateTx(tx, c, code, asOfDate);
          rows.push({ currency: code, rate });
        }
        return rows;
      });
      return res.json({ asOfDate, baseCurrency: "USD", rates });
    } catch (e) {
      return fail(res, e);
    }
  });
  app.get("/api/accounting/monetary-fx/rate", ...gate, async (req, res) => {
    try {
      const input = z.object({ currency: z.string().min(3).max(3), asOfDate: date }).parse(req.query);
      const c = company(req),
        asOfDate = fxDay(input.asOfDate ?? (await companyBusinessDate(c)));
      return res.json({
        rate: await db.transaction((tx) => datedMonetaryRateTx(tx, c, input.currency, asOfDate)),
        asOfDate,
      });
    } catch (e) {
      return fail(res, e);
    }
  });
  // Phase 3 recovery: inspect an old manual FX journal without writing, reclassifying
  // accounts, deleting vouchers or creating an automatic FX journal.
  app.get("/api/accounting/monetary-fx/manual-revaluation/preflight", ...gate, async (req, res) => {
    try {
      const c = company(req);
      const { voucherId } = z.object({ voucherId: positive }).parse(req.query);
      const preview = await getManualFxCorrectionPreflight(c, voucherId);
      return res.status(preview.status === "not_found" ? 404 : 200).json(preview);
    } catch (e) {
      return fail(res, e);
    }
  });

  // Phase 4: read-only, company-scoped proof of a reviewed FX recovery.
  // This GET never posts, reclassifies, reverses or accepts a company override.
  app.get("/api/accounting/monetary-fx/manual-revaluation/verify", ...gate, async (req, res) => {
    try {
      const c = company(req);
      const { voucherId } = z.object({ voucherId: positive }).parse(req.query);
      const evidence = await verifyManualFxCorrection(c, voucherId);
      return res.status(evidence.blockers.includes("ORIGINAL_VOUCHER_NOT_FOUND") ? 404 : 200).json(evidence);
    } catch (e) {
      return fail(res, e);
    }
  });

  // Phase 5: read-only Sales Report, actual inventory-cost and Net Position
  // bridge. Never accepts a company override or makes a correcting journal.
  app.get("/api/accounting/monetary-fx/sales-net-position/reconciliation", ...gate, async (req, res) => {
    try {
      return res.json(await getZambiaSalesNetPositionReconciliation(company(req)));
    } catch (e) {
      return fail(res, e);
    }
  });

  app.get("/api/accounting/monetary-fx/cash-bank", ...gate, async (req, res) => {
    try {
      const input = cashBank.parse(req.query),
        c = company(req);
      const asOfDate = fxDay(input.asOfDate ?? (await companyBusinessDate(c)));
      return res.json(
        await db.transaction((tx) =>
          monetaryAccountValuationTx(tx, {
            ...input,
            companyId: c,
            asOfDate,
          })
        )
      );
    } catch (e) {
      return fail(res, e);
    }
  });
  app.get("/api/accounting/monetary-fx/realized", ...gate, async (req, res) => {
    try {
      const input = realizedFilter.parse(req.query),
        c = company(req);
      const asOfDate = fxDay(input.asOfDate ?? (await companyBusinessDate(c)));
      return res.json(
        await db.transaction((tx) =>
          listRealizedFxTx(tx, {
            ...input,
            companyId: c,
            asOfDate,
          })
        )
      );
    } catch (e) {
      return fail(res, e);
    }
  });
  app.get("/api/accounting/monetary-fx/realized/:id", ...gate, async (req, res) => {
    try {
      const c = company(req),
        matchId = positive.parse(req.params.id);
      return res.json(await db.transaction((tx) => previewRealizedFxTx(tx, c, matchId)));
    } catch (e) {
      return fail(res, e);
    }
  });
  app.post("/api/accounting/monetary-fx/realized/:id/recognize", ...gate, async (req, res) => {
    // Defense in depth: never rely on the path-matching middleware alone.
    if (!UNIFIED_FINANCIAL_POSTING_RELEASED) return res.status(423).json(UNIFIED_FINANCIAL_POSTING_LOCKED);
    try {
      const c = company(req),
        matchId = positive.parse(req.params.id);
      const input = z.object({ reason: z.string().trim().min(3).max(1000) }).parse(req.body);
      const recognized = await db.transaction((tx) =>
        recognizeRealizedFxTx(tx, {
          companyId: c,
          matchId,
          actor: actor(req),
          reason: input.reason,
        })
      );
      return res.status(recognized.replayed ? 200 : 201).json(recognized);
    } catch (e) {
      return fail(res, e);
    }
  });
}

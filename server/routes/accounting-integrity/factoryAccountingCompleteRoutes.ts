/**
 * Phase 28 Owner tools (accounting audit, factory accounting complete):
 *
 *   GET  /api/accounting/factory-opening-receivable/plan?effectiveFrom=YYYY-MM-DD   Owner/Admin (F1)
 *   POST /api/accounting/factory-opening-receivable/apply   Owner, { confirm, planHash, effectiveFrom }
 *   GET  /api/accounting/factory-no-mix-bales/plan          Owner/Admin (F4/F6)
 *   POST /api/accounting/factory-no-mix-bales/apply         Owner, { confirm, planHash, actions?, unmatched?, reason? }
 *   GET  /api/accounting/factory-legacy-postings/plan       Owner/Admin (F10/F11)
 *   POST /api/accounting/factory-legacy-postings/apply      Owner, { confirm, planHash, families? }
 *   GET  /api/accounting/bale-mirror-write-off/plan         Owner/Admin (I8)
 *   POST /api/accounting/bale-mirror-write-off/apply        Owner, { confirm, planHash }
 *   POST /api/accounting/perpetual-inventory/factory-stock-journal/catch-up   Admin/Owner (F9)
 *
 * The services hold the rules. Each acts on the session's current company only.
 * The paths avoid the maintenance keywords (backfill, repair, …), which admit
 * only Admin and Developer: these are Owner tools.
 */
import type { Express, Request, Response } from "express";

import { requireAuth, requireRole } from "../../auth";
import { db } from "../../db";
import { closedPeriodErrorResponse } from "../../lib/closedPeriodError";
import { getErrorMessage, HttpError } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { companyBusinessDate } from "../../services/accounting/companyBusinessDate";
import { catchUpFactoryStockJournalsTx } from "../../services/accounting/perpetualInventory/factoryStockJournal";
import {
  applyFactoryOpeningReceivable,
  planFactoryOpeningReceivable,
} from "../../services/factory/factoryOpeningReceivable";
import {
  LEGACY_POSTING_FAMILIES,
  applyLegacyFactoryPostings,
  planLegacyFactoryPostings,
  type LegacyPostingFamily,
} from "../../services/factory/factoryLegacyPostings";
import {
  NO_MIX_RESOLUTION_ACTIONS,
  applyNoMixBaleResolution,
  planNoMixBaleResolution,
  type NoMixResolutionAction,
  type NoMixResolutionInput,
} from "../../services/factory/noMixBaleResolution";
import { applyBaleMirrorWriteOff, planBaleMirrorWriteOff } from "../../services/inventory/baleMirrorWriteOff";
import { resolveRequestCompanyId } from "../../services/security/requestCompanyScope";

const PLAN_HASH = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const BASE = "/api/accounting";

const actorOf = (req: Request) => ({
  userId: String(req.session.userId ?? ""),
  username: req.session.username || String(req.session.userId ?? "unknown"),
});

function reviewedHash(req: Request, res: Response): string | null {
  if (req.body?.confirm !== true) {
    res.status(400).json({ message: "Confirmation is required" });
    return null;
  }
  const planHash = req.body?.planHash;
  if (typeof planHash !== "string" || !PLAN_HASH.test(planHash)) {
    res.status(400).json({ message: "The reviewed plan hash is required" });
    return null;
  }
  return planHash;
}

function sendFailure(res: Response, route: string, error: unknown) {
  const refusal = error as { body?: unknown } | null;
  if (error instanceof HttpError) {
    return res.status(error.statusCode).json(refusal?.body ?? { message: error.message });
  }
  const closed = closedPeriodErrorResponse(error);
  if (closed) return res.status(closed.status).json(closed.body);
  logger.error(`${route} error`, { error });
  return res.status(500).json({ message: getErrorMessage(error) });
}

export function registerFactoryAccountingCompleteRoutes(app: Express): void {
  const owners = [requireAuth, requireRole("Owner", "Admin")] as const;
  const owner = [requireAuth, requireRole("Owner")] as const;

  // F1 — opening receivable at the factory receivable cut-over.
  app.get(`${BASE}/factory-opening-receivable/plan`, ...owners, async (req, res) => {
    try {
      const effectiveFrom = String(req.query.effectiveFrom ?? "");
      if (!ISO_DATE.test(effectiveFrom)) return res.status(400).json({ message: "Invalid date" });
      res.json(await planFactoryOpeningReceivable(resolveRequestCompanyId(req), effectiveFrom));
    } catch (error) {
      sendFailure(res, "GET factory-opening-receivable/plan", error);
    }
  });
  app.post(`${BASE}/factory-opening-receivable/apply`, ...owner, async (req, res) => {
    try {
      const planHash = reviewedHash(req, res);
      if (!planHash) return;
      const effectiveFrom = String(req.body?.effectiveFrom ?? "");
      if (!ISO_DATE.test(effectiveFrom)) return res.status(400).json({ message: "Invalid date" });
      const result = await applyFactoryOpeningReceivable(resolveRequestCompanyId(req), {
        effectiveFrom,
        planHash,
        actor: actorOf(req),
      });
      res.json({ applied: true, ...result });
    } catch (error) {
      sendFailure(res, "POST factory-opening-receivable/apply", error);
    }
  });

  // F4/F6 — bales with no costed mix.
  app.get(`${BASE}/factory-no-mix-bales/plan`, ...owners, async (req, res) => {
    try {
      res.json(await planNoMixBaleResolution(resolveRequestCompanyId(req)));
    } catch (error) {
      sendFailure(res, "GET factory-no-mix-bales/plan", error);
    }
  });
  app.post(`${BASE}/factory-no-mix-bales/apply`, ...owner, async (req, res) => {
    try {
      const planHash = reviewedHash(req, res);
      if (!planHash) return;
      const actions = Array.isArray(req.body?.actions) ? req.body.actions : [];
      const parsed: NonNullable<NoMixResolutionInput["actions"]> = [];
      for (const entry of actions as Array<Record<string, unknown>>) {
        const baleId = Number(entry?.baleId);
        const action = String(entry?.action ?? "");
        if (!Number.isInteger(baleId) || !NO_MIX_RESOLUTION_ACTIONS.includes(action as never)) {
          return res.status(400).json({ message: "Each action needs a bale id and assign, writeOff or accept" });
        }
        const mixBatchId = entry?.mixBatchId == null ? null : Number(entry.mixBatchId);
        if (mixBatchId !== null && !Number.isInteger(mixBatchId)) {
          return res.status(400).json({ message: "Invalid mix" });
        }
        parsed.push({ baleId, action: action as NoMixResolutionAction, mixBatchId });
      }
      const unmatched = req.body?.unmatched;
      if (unmatched !== undefined && unmatched !== null && unmatched !== "writeOff" && unmatched !== "accept") {
        return res.status(400).json({ message: "unmatched must be writeOff or accept" });
      }
      const result = await applyNoMixBaleResolution(resolveRequestCompanyId(req), {
        planHash,
        actions: parsed,
        unmatched: unmatched ?? null,
        reason: typeof req.body?.reason === "string" ? req.body.reason : null,
        actor: actorOf(req),
      });
      res.json({ resolved: result.applied.length, applied: result.applied, plan: result.plan });
    } catch (error) {
      sendFailure(res, "POST factory-no-mix-bales/apply", error);
    }
  });

  // F10/F11 — legacy factory postings.
  app.get(`${BASE}/factory-legacy-postings/plan`, ...owners, async (req, res) => {
    try {
      res.json(await planLegacyFactoryPostings(resolveRequestCompanyId(req)));
    } catch (error) {
      sendFailure(res, "GET factory-legacy-postings/plan", error);
    }
  });
  app.post(`${BASE}/factory-legacy-postings/apply`, ...owner, async (req, res) => {
    try {
      const planHash = reviewedHash(req, res);
      if (!planHash) return;
      const families = req.body?.families;
      if (
        families !== undefined &&
        (!Array.isArray(families) || families.some((family) => !LEGACY_POSTING_FAMILIES.includes(family as never)))
      ) {
        return res.status(400).json({ message: `families must be among ${LEGACY_POSTING_FAMILIES.join(", ")}` });
      }
      const result = await applyLegacyFactoryPostings(resolveRequestCompanyId(req), {
        planHash,
        families: families as LegacyPostingFamily[] | undefined,
        actor: actorOf(req),
      });
      res.json({ applied: true, ...result });
    } catch (error) {
      sendFailure(res, "POST factory-legacy-postings/apply", error);
    }
  });

  // I8 — ERP bale-mirror values.
  app.get(`${BASE}/bale-mirror-write-off/plan`, ...owners, async (req, res) => {
    try {
      res.json(await planBaleMirrorWriteOff(resolveRequestCompanyId(req)));
    } catch (error) {
      sendFailure(res, "GET bale-mirror-write-off/plan", error);
    }
  });
  app.post(`${BASE}/bale-mirror-write-off/apply`, ...owner, async (req, res) => {
    try {
      const planHash = reviewedHash(req, res);
      if (!planHash) return;
      const plan = await applyBaleMirrorWriteOff(resolveRequestCompanyId(req), { planHash, actor: actorOf(req) });
      res.json({ applied: true, plan });
    } catch (error) {
      sendFailure(res, "POST bale-mirror-write-off/apply", error);
    }
  });

  // F9 — missed daily factory stock journals.
  app.post(`${BASE}/perpetual-inventory/factory-stock-journal/catch-up`, ...owners, async (req, res) => {
    try {
      const companyId = resolveRequestCompanyId(req);
      const today = await companyBusinessDate(companyId);
      res.json(await db.transaction((tx) => catchUpFactoryStockJournalsTx(tx, companyId, today)));
    } catch (error) {
      sendFailure(res, "POST factory-stock-journal/catch-up", error);
    }
  });
}

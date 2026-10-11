/**
 * Retail cash movement reasons and the Retail inventory opening (accounting
 * audit wave 17 D, owner decisions 2 and 3 of 2026-10-09).
 *
 *   GET  /api/retail/financial/cash-reasons                 reasons and the account each posts to
 *   PUT  /api/retail/financial/cash-reasons                 { reasons: [{ reasonCode, ledgerAccountId, bankAccountId }] }
 *   GET  /api/retail/financial/inventory-opening/preview    Owner, ?openingDate=YYYY-MM-DD, read-only plan + planHash
 *   POST /api/retail/financial/inventory-opening/apply      Owner, { openingDate, planHash, confirm: true }
 *   GET  /api/retail/financial/inventory-reconciliation     RETAIL-INVENTORY against the Retail stock sub-ledger
 */
import type { Express } from "express";
import { z } from "zod";

import { requireAuth, requireNonPOS, requireRole } from "../auth";
import { db } from "../db";
import { closedPeriodErrorResponse } from "../lib/closedPeriodError";
import { getErrorMessage, HttpError } from "../lib/httpHandlers";
import { currentUserId, requireRetailCompany } from "./pos/retailPosContext";
import {
  RETAIL_CASH_REASON_CODE,
  RETAIL_CASH_REASONS,
  listRetailCashReasonTargetsTx,
  saveRetailCashReasonAccountsTx,
} from "../services/retail/retailCashJournal";
import {
  RetailInventoryOpeningRefusal,
  applyRetailInventoryOpening,
  previewRetailInventoryOpening,
  retailInventoryReconciliationTx,
} from "../services/retail/retailInventoryJournal";
import { RetailAccountConflictError } from "../services/retail/retailFinancialService";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PLAN_HASH = /^[0-9a-f]{64}$/;
const optionalId = z.union([z.coerce.number().int().positive(), z.null()]).optional();

const reasonsSchema = z.object({
  reasons: z
    .array(
      z.object({
        reasonCode: z.string().trim().regex(RETAIL_CASH_REASON_CODE),
        ledgerAccountId: optionalId,
        bankAccountId: optionalId,
      })
    )
    .min(1)
    .max(50),
});

function sendError(res: import("express").Response, error: unknown) {
  if (error instanceof RetailInventoryOpeningRefusal) return res.status(error.statusCode).json(error.body);
  if (error instanceof RetailAccountConflictError) {
    return res.status(409).json({ message: error.message, code: error.code, conflicts: error.conflicts });
  }
  if (error instanceof HttpError) return res.status(error.statusCode).json({ message: error.message });
  if (error instanceof z.ZodError) return res.status(400).json({ message: "Invalid request", issues: error.issues });
  const closed = closedPeriodErrorResponse(error);
  if (closed) return res.status(closed.status).json(closed.body);
  return res.status(500).json({ message: getErrorMessage(error) });
}

export function registerRetailLedgerRoutes(app: Express): void {
  app.get("/api/retail/financial/cash-reasons", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const reasons = await db.transaction((tx) => listRetailCashReasonTargetsTx(tx, companyId));
      res.json({ reasons, builtIn: RETAIL_CASH_REASONS });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.put("/api/retail/financial/cash-reasons", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const body = reasonsSchema.parse(req.body);
      const reasons = await db.transaction((tx) =>
        saveRetailCashReasonAccountsTx(
          tx,
          companyId,
          body.reasons.map((reason) => ({
            reasonCode: reason.reasonCode,
            ledgerAccountId: reason.ledgerAccountId ?? null,
            bankAccountId: reason.bankAccountId ?? null,
          })),
          { userId: currentUserId(req), username: req.user?.username ?? req.session.username ?? "unknown" }
        )
      );
      res.json({ reasons, builtIn: RETAIL_CASH_REASONS });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/retail/financial/inventory-opening/preview", requireAuth, requireRole("Owner"), async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const openingDate = String(req.query.openingDate ?? "");
      if (!ISO_DATE.test(openingDate)) return res.status(400).json({ message: "Invalid date" });
      res.json(await previewRetailInventoryOpening(companyId, openingDate));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/retail/financial/inventory-opening/apply", requireAuth, requireRole("Owner"), async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      if (req.body?.confirm !== true) return res.status(400).json({ message: "Confirmation is required" });
      const openingDate = String(req.body?.openingDate ?? "");
      if (!ISO_DATE.test(openingDate)) return res.status(400).json({ message: "Invalid date" });
      const planHash = req.body?.planHash;
      if (typeof planHash !== "string" || !PLAN_HASH.test(planHash)) {
        return res.status(400).json({ message: "The reviewed plan hash is required" });
      }
      res.json(
        await applyRetailInventoryOpening(companyId, {
          openingDate,
          planHash,
          actor: { userId: currentUserId(req), username: req.user?.username ?? req.session.username ?? null },
        })
      );
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/retail/financial/inventory-reconciliation", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      res.json(await retailInventoryReconciliationTx(db, companyId));
    } catch (error) {
      sendError(res, error);
    }
  });
}

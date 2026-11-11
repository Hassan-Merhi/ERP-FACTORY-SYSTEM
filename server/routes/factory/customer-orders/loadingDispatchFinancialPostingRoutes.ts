/** Phase 4 financial finalization/reversal of individually closed truck trips. */
import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { requireFactoryTabAccess, getFactoryAccessState } from "../../../lib/factoryAccessControl";
import { getClientDate } from "../../../lib/dateUtils";
import { parseId } from "../../../lib/parseId";
import { resultRows } from "../../../lib/queryResult";
import { logger } from "../../../lib/logger";
import { closedPeriodErrorResponse } from "../../../lib/closedPeriodError";
import { DispatchFinancialSourceError } from "../../../services/factory/dispatchTripFinancialSource";
import {
  postDispatchTripFinancialTx, reverseDispatchTripFinancialTx,
  TripFinancialPostingError, type DispatchPostingScope,
} from "../../../services/factory/dispatchTripFinancialPosting";
import { TripChargeValidationError } from "./loadingDispatchFinancialChargeModel";

const base = "/api/factory/customer-orders/:id/loading-dispatches/:dispatchId";
const loadings = requireFactoryTabAccess("factory/invoicing", "hide_invoicing_loadings_tab");
class Refusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
async function scopeFor(req: Request): Promise<DispatchPostingScope> {
  const access = await getFactoryAccessState(req);
  if (!access?.hasFactoryAccess || !["admin", "owner", "developer"].includes(access.role.toLowerCase())) {
    throw new Refusal(403, "TRIP_ACCOUNTING_ROLE_REQUIRED", "Only Admin, Owner or Developer may finalize Factory trip accounting");
  }
  const orderId = parseId(req.params.id);
  const dispatchId = parseId(req.params.dispatchId);
  if (!orderId || !dispatchId) throw new Refusal(400, "INVALID_ID", "Invalid loading or trip");
  return {
    companyId: access.companyId, orderId, dispatchId, userId: access.userId,
    username: req.session.username || access.userId,
  };
}
function errorResponse(res: Response, error: unknown) {
  if (error instanceof Refusal || error instanceof TripFinancialPostingError) {
    return res.status(error.status).json({ code: error.code, message: error.message });
  }
  if (error instanceof TripChargeValidationError || error instanceof DispatchFinancialSourceError) {
    return res.status(409).json({ code: error.name, message: error.message });
  }
  const period = closedPeriodErrorResponse(error);
  if (period) return res.status(period.status).json(period.body);
  if ((error as { code?: string } | null)?.code === "42P01") {
    return res.status(503).json({
      code: "TRIP_FINANCIAL_SCHEMA_PENDING",
      message: "The trip financial schema has not been installed yet. Your final TablePlus SQL handoff is required.",
    });
  }
  logger.error("Factory dispatch financial posting failed", { error });
  return res.status(500).json({ code: "TRIP_POSTING_ERROR", message: "Unable to post Factory dispatch trip; no partial journal was saved" });
}
function body(req: Request): Record<string, unknown> {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    throw new Refusal(400, "INVALID_BODY", "A financial posting confirmation is required");
  }
  return req.body as Record<string, unknown>;
}
export function registerFactoryLoadingDispatchPostingRoutes(app: Express): void {
  app.post(base + "/financial-finalize", requireAuth, loadings, async (req, res) => {
    try {
      const scope = await scopeFor(req);
      const input = body(req);
      if (input.confirm !== true || typeof input.sourceFingerprint !== "string" ||
          !/^[0-9a-f]{64}$/.test(input.sourceFingerprint) ||
          typeof input.chargeFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(input.chargeFingerprint)) {
        throw new Refusal(400, "TRIP_POSTING_CONFIRM_REQUIRED", "Refresh and explicitly confirm the exact signed trip and charges");
      }
      const result = await db.transaction(tx => postDispatchTripFinancialTx(tx, scope, {
        sourceFingerprint: input.sourceFingerprint as string,
        chargeFingerprint: input.chargeFingerprint as string,
        postingDate: getClientDate(req),
      }));
      res.set("Cache-Control", "private, no-store");
      return res.json(result);
    } catch (error) { return errorResponse(res, error); }
  });

  app.post(base + "/financial-reverse", requireAuth, loadings, async (req, res) => {
    try {
      const scope = await scopeFor(req);
      const input = body(req);
      if (input.confirm !== true || typeof input.reason !== "string" ||
          input.reason.trim().length < 10 || input.reason.trim().length > 1000) {
        throw new Refusal(400, "TRIP_REVERSAL_CONFIRM_REQUIRED", "Confirm the reversal and explain why (10–1,000 characters)");
      }
      const result = await db.transaction(tx => reverseDispatchTripFinancialTx(tx, scope, {
        reason: (input.reason as string).trim(), date: getClientDate(req),
      }));
      return res.json(result);
    } catch (error) { return errorResponse(res, error); }
  });

  app.get(base + "/financial-history", requireAuth, loadings, async (req, res) => {
    try {
      const scope = await scopeFor(req);
      const [financial] = resultRows(await db.execute(sql`
        SELECT id,status,posting_revision AS "postingRevision",
               valuation_date::text AS "valuationDate",
               goods_subtotal::text AS "goodsSubtotal",
               billable_charges_total::text AS "billableChargesTotal",
               discount_total::text AS "discountTotal",
               customer_total::text AS "customerTotal",posted_at AS "postedAt"
          FROM factory_dispatch_trip_financials
         WHERE company_id=${scope.companyId} AND order_id=${scope.orderId}
           AND dispatch_id=${scope.dispatchId} LIMIT 1
      `));
      const events = resultRows(await db.execute(sql`
        SELECT event_type AS "eventType",actor_username AS "actorUsername",
               details,reason,created_at AS "createdAt"
          FROM factory_dispatch_financial_events
         WHERE company_id=${scope.companyId} AND order_id=${scope.orderId}
           AND dispatch_id=${scope.dispatchId}
         ORDER BY id DESC LIMIT 100
      `));
      const postings = resultRows(await db.execute(sql`
        SELECT posting_revision AS "revision",kind,amount::text,
               voucher_ids AS "voucherIds",posted_at AS "postedAt",reason
          FROM factory_dispatch_trip_postings
         WHERE company_id=${scope.companyId} AND order_id=${scope.orderId}
           AND dispatch_id=${scope.dispatchId}
         ORDER BY id DESC LIMIT 100
      `));
      res.set("Cache-Control", "private, no-store");
      return res.json({ financial: financial ?? null, postings, events });
    } catch (error) { return errorResponse(res, error); }
  });
}

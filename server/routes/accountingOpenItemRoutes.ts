/**
 * One scoped open-item API for ERP customer/supplier, Factory supplier and
 * Rental contract/month reconciliation. Explicit matching is accounting
 * metadata only; neither this API nor its services create financial vouchers.
 */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth";
import { db } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { companyBusinessDate } from "../services/accounting/companyBusinessDate";
import {
  OpenItemError,
  applyPartyOpenItemMatchTx,
  loadPartyOpenItemsTx,
  voidPartyOpenItemMatchTx,
} from "../services/accounting/partyOpenItemService";
import { loadRentalOpenItemsTx } from "../services/rental/rentalOpenItemsService";

const domain = z.enum(["customer", "supplier", "factory_supplier"]);
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const positiveId = z.coerce.number().int().positive();
const target = z.object({
  domain,
  partyId: positiveId,
  asOfDate: iso.optional(),
});
const rentTarget = z.object({
  module: z.enum(["ERP", "FACTORY", "PROPERTIES"]),
  contractId: positiveId,
  asOfDate: iso.optional(),
});
const matchInput = z.object({
  domain,
  partyId: positiveId,
  chargeEntryId: positiveId,
  settlementEntryId: positiveId,
  amount: z.union([z.string(), z.number()]).transform((v) => String(v)),
  idempotencyKey: z.string().min(1).max(191),
  reason: z.string().nullable().optional(),
});
function company(req: Request): number {
  const id = Number(req.session.currentCompanyId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new OpenItemError("COMPANY_REQUIRED", "Select a company first", 400);
  return id;
}
function actor(req: Request) {
  return {
    userId: String(req.session.userId ?? ""),
    username: String(req.session.username ?? req.session.userId ?? "unknown"),
  };
}
function respondError(res: Response, error: unknown) {
  if (error instanceof z.ZodError)
    return res
      .status(400)
      .json({ code: "OPEN_ITEM_INVALID_REQUEST", message: error.issues.map((e) => e.message).join("; ") });
  if (error instanceof OpenItemError)
    return res.status(error.status).json({ code: error.code, message: error.message });
  return res.status(500).json({ code: "OPEN_ITEM_ERROR", message: getErrorMessage(error) });
}
export function registerAccountingOpenItemRoutes(app: Express): void {
  app.get(
    "/api/accounting/open-items",
    requireAuth,
    requireRole("Admin", "Owner", "Developer"),
    async (req: Request, res: Response) => {
      try {
        const c = company(req);
        const t = target.parse(req.query);
        return res.json(await db.transaction((tx) => loadPartyOpenItemsTx(tx, { ...t, companyId: c })));
      } catch (error) {
        return respondError(res, error);
      }
    }
  );
  app.get(
    "/api/accounting/open-items/rentals",
    requireAuth,
    requireRole("Admin", "Owner", "Developer"),
    async (req: Request, res: Response) => {
      try {
        const c = company(req),
          t = rentTarget.parse(req.query);
        const asOfDate = t.asOfDate ?? (await companyBusinessDate(c));
        return res.json(
          await db.transaction((tx) =>
            loadRentalOpenItemsTx(tx, {
              companyId: c,
              module: t.module,
              contractId: t.contractId,
              asOfDate,
            })
          )
        );
      } catch (error) {
        return respondError(res, error);
      }
    }
  );
  app.post(
    "/api/accounting/open-items/matches",
    requireAuth,
    requireRole("Admin", "Owner", "Developer"),
    async (req: Request, res: Response) => {
      try {
        const c = company(req),
          payload = matchInput.parse(req.body);
        const result = await db.transaction((tx) =>
          applyPartyOpenItemMatchTx(tx, {
            ...payload,
            companyId: c,
            actor: actor(req),
          })
        );
        return res.status(result.replayed ? 200 : 201).json(result);
      } catch (error) {
        return respondError(res, error);
      }
    }
  );
  app.post(
    "/api/accounting/open-items/matches/:id/void",
    requireAuth,
    requireRole("Admin", "Owner", "Developer"),
    async (req: Request, res: Response) => {
      try {
        const c = company(req),
          id = positiveId.parse(req.params.id);
        const body = z.object({ reason: z.string().trim().min(1) }).parse(req.body);
        const result = await db.transaction((tx) =>
          voidPartyOpenItemMatchTx(tx, {
            companyId: c,
            matchId: id,
            actor: actor(req),
            reason: body.reason,
          })
        );
        return res.json(result);
      } catch (error) {
        return respondError(res, error);
      }
    }
  );
}

/** Unified ERP/Factory/Properties rental accounting and maintenance attribution. */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { db } from "../db";
import { requireAuth, requireRole } from "../auth";
import { getErrorMessage } from "../lib/httpHandlers";
import { companyBusinessDate } from "../services/accounting/companyBusinessDate";
import {
  RentalAccountingError,
  linkRentalExpenseTx,
  voidRentalExpenseLinkTx,
} from "../services/rental/rentalExpenseAttributionService";
import {
  listRentalAccountingContractsTx,
  rentalContractAccountingTx,
} from "../services/rental/unifiedRentalAccountingService";
const moduleName = z.enum(["ERP", "FACTORY", "PROPERTIES"]);
const positive = z.coerce.number().int().positive();
const asOf = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional();
const category = z.enum(["maintenance", "repairs", "utilities", "insurance", "property_tax", "other_property_cost"]);
function company(req: Request) {
  const n = Number(req.session.currentCompanyId);
  if (!Number.isSafeInteger(n) || n < 1)
    throw new RentalAccountingError("RENTAL_COMPANY_REQUIRED", "Select a company", 400);
  return n;
}
function actor(req: Request) {
  return {
    userId: String(req.session.userId ?? ""),
    username: String(req.session.username ?? req.session.userId ?? "unknown"),
  };
}
function fail(res: Response, error: unknown) {
  if (error instanceof z.ZodError)
    return res.status(400).json({
      code: "RENTAL_ACCOUNTING_INVALID_REQUEST",
      message: error.issues.map((e) => e.message).join("; "),
    });
  if (error instanceof RentalAccountingError)
    return res.status(error.status).json({ code: error.code, message: error.message });
  return res.status(500).json({ code: "RENTAL_ACCOUNTING_ERROR", message: getErrorMessage(error) });
}
export function registerUnifiedRentalAccountingRoutes(app: Express): void {
  const gate = [requireAuth, requireRole("Admin", "Owner", "Developer")] as const;
  app.get("/api/accounting/rentals/contracts", ...gate, async (req, res) => {
    try {
      const c = company(req),
        body = z.object({ module: moduleName }).parse(req.query);
      return res.json(
        await db.transaction((tx) =>
          listRentalAccountingContractsTx(tx, {
            companyId: c,
            module: body.module,
          })
        )
      );
    } catch (e) {
      return fail(res, e);
    }
  });
  app.get("/api/accounting/rentals/contracts/:id", ...gate, async (req, res) => {
    try {
      const c = company(req),
        contractId = positive.parse(req.params.id);
      const body = z.object({ module: moduleName, asOfDate: asOf }).parse(req.query);
      const asOfDate = body.asOfDate ?? (await companyBusinessDate(c));
      return res.json(
        await db.transaction((tx) =>
          rentalContractAccountingTx(tx, {
            companyId: c,
            contractId,
            module: body.module,
            asOfDate,
          })
        )
      );
    } catch (e) {
      return fail(res, e);
    }
  });
  app.post("/api/accounting/rentals/expense-links", ...gate, async (req, res) => {
    try {
      const c = company(req);
      const b = z
        .object({
          module: moduleName,
          contractId: positive,
          voucherId: positive,
          category,
          amountUsd: z.string().regex(/^[0-9]+(?:\.[0-9]{1,6})?$/),
          clientRequestKey: z.string().min(8).max(128),
          note: z.string().max(1000).nullable().optional(),
        })
        .parse(req.body);
      const response = await db.transaction((tx) =>
        linkRentalExpenseTx(tx, {
          ...b,
          companyId: c,
          actor: actor(req),
        })
      );
      return res.status(response.replayed ? 200 : 201).json(response);
    } catch (e) {
      return fail(res, e);
    }
  });
  app.post("/api/accounting/rentals/expense-links/:id/void", ...gate, async (req, res) => {
    try {
      const c = company(req),
        linkId = positive.parse(req.params.id);
      const body = z.object({ reason: z.string().trim().min(1).max(1000) }).parse(req.body);
      return res.json(
        await db.transaction((tx) =>
          voidRentalExpenseLinkTx(tx, {
            companyId: c,
            linkId,
            reason: body.reason,
            actor: actor(req),
          })
        )
      );
    } catch (e) {
      return fail(res, e);
    }
  });
}

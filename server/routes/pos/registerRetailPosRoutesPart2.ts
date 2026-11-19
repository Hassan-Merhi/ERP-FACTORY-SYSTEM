// Extracted from ./retailPosRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { and, desc, eq } from "drizzle-orm";
import { listRetailPaymentAccounts } from "../../services/retail/retailPaymentAccounts";
import { retailPosSales } from "@shared/schema";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { retailReturnRefusal } from "./retailCheckoutPolicy";
import { currentUserId, ensureCompanyLocation, requireRetailCompany } from "./retailPosContext";
import { createRetailReturnInTx, loadSaleResponse } from "../../services/retail/retailSaleService";
import {
  postRetailRefundAccountingTx,
  refundRetailPaymentsTx,
  validateRetailShiftTx,
} from "../../services/retail/retailFinancialService";
import { returnSchema } from "./registerRetailPosRoutesPart1";
import { registerRetailPosRoutesPart3 } from "./registerRetailPosRoutesPart3";

export function registerRetailPosRoutesPart2(app: Express) {
  registerRetailPosRoutesPart3(app);

  app.get("/api/pos/retail/sales", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const locationId = Number(req.query.locationId);
      const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
      if (!Number.isInteger(locationId) || locationId <= 0)
        return res.status(400).json({ message: "Location is required" });
      await ensureCompanyLocation(companyId, locationId);
      const sales = await db
        .select({ id: retailPosSales.id })
        .from(retailPosSales)
        .where(and(eq(retailPosSales.companyId, companyId), eq(retailPosSales.locationId, locationId)))
        .orderBy(desc(retailPosSales.createdAt))
        .limit(limit);
      const details = await Promise.all(sales.map((sale) => loadSaleResponse(companyId, sale.id)));
      res.json(details.filter(Boolean));
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/pos/retail/payment-accounts", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      res.json(await listRetailPaymentAccounts(companyId));
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/pos/retail/sales/:saleId/returns", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const saleId = Number(req.params.saleId);
      if (!Number.isInteger(saleId) || saleId <= 0) return res.status(400).json({ message: "Invalid sale" });
      const body = returnSchema.parse(req.body);
      await ensureCompanyLocation(companyId, body.locationId);
      const userId = currentUserId(req);
      const refusal = await retailReturnRefusal({ companyId, saleId, role: req.user?.role, ...body });
      if (refusal) return res.status(refusal.status).json(refusal.body);

      const result = await db.transaction(async (tx) => {
        const returned = await createRetailReturnInTx(tx, {
          companyId,
          saleId,
          locationId: body.locationId,
          idempotencyKey: body.idempotencyKey,
          notes: body.notes ?? null,
          items: body.items,
          userId,
        });
        if (!returned.replayed) {
          const shift = await validateRetailShiftTx(tx, {
            companyId,
            locationId: body.locationId,
            userId,
            shiftId: body.shiftId ?? null,
          });
          const refunds = await refundRetailPaymentsTx(tx, {
            companyId,
            saleId,
            locationId: body.locationId,
            shiftId: shift?.id ?? null,
            refundAmount: returned.refundAmount,
            idempotencyKey: body.idempotencyKey,
            destination: body.refundDestination,
            refundAccount: { ledgerAccountId: body.refundLedgerAccountId, bankAccountId: body.refundBankAccountId },
            userId,
          });
          const refundPosting = await postRetailRefundAccountingTx(tx, {
            companyId,
            locationId: body.locationId,
            saleId,
            sourceType: "retail-pos-return",
            sourceId: String(returned.returnId),
            idempotencyKey: `retail-pos-return:${returned.returnId}`,
            refundAmount: returned.refundAmount,
            refundTaxAmount: returned.refundTaxAmount,
            restoredCost: returned.costValue,
            refunds,
            userId,
            username: req.user?.username ?? null,
          });
          // Wave 17 (D): what the refund journal did not put back on Retail inventory.
          await returned.stockValue?.post({
            kind: "return",
            sourceId: returned.returnId,
            description: `Retail return #${returned.returnId} for sale #${saleId}`,
            actor: { userId, username: req.user?.username ?? null },
            alreadyDebited: refundPosting.costReversed ? returned.costValue : undefined,
          });
        }
        return returned;
      });

      res.status(result.replayed ? 200 : 201).json({
        ...result,
        // Exact amounts inside; a number only in the response.
        refundAmount: result.refundAmount.toDecimalPlaces(2).toNumber(),
        refundTaxAmount: result.refundTaxAmount.toDecimalPlaces(2).toNumber(),
        refundValue: result.refundValue.toNumber(),
        costValue: result.costValue.toNumber(),
        sale: await loadSaleResponse(companyId, saleId),
      });
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}

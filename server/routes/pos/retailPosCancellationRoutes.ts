import type { Express } from "express";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { retailPosSaleItems, retailPosSales, retailStockOperations } from "@shared/schema";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { currentUserId, ensureCompanyLocation, requireRetailCompany } from "./retailPosContext";
import { lineAmount, MoneyDecimal, toMoney } from "../../lib/money";
import {
  addMovement,
  lockInventoryRow,
  nextAverageCost,
  setInventoryQuantity,
} from "../../services/retail/retailStockLedger";
import { trackRetailStockValueTx } from "../../services/retail/retailInventoryJournal";

import { loadSaleResponse } from "../../services/retail/retailSaleService";
import {
  postRetailRefundAccountingTx,
  refundRetailPaymentsTx,
  validateRetailShiftTx,
} from "../../services/retail/retailFinancialService";

const idempotencyKeySchema = z.string().trim().min(8).max(191);

const cancelSchema = z.object({
  locationId: z.coerce.number().int().positive(),
  idempotencyKey: idempotencyKeySchema,
  shiftId: z.coerce.number().int().positive().optional(),
  reason: z.string().trim().min(1).max(500).optional(),
});

function toNumber(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Cancels a whole retail sale: restores stock, refunds tenders and reverses its journal. */
export function registerRetailPosCancellationRoute(app: Express): void {
  app.post("/api/pos/retail/sales/:saleId/cancel", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const saleId = Number(req.params.saleId);
      if (!Number.isInteger(saleId) || saleId <= 0) return res.status(400).json({ message: "Invalid sale" });
      const body = cancelSchema.parse(req.body);
      await ensureCompanyLocation(companyId, body.locationId);
      const userId = currentUserId(req);
      const result = await db.transaction(async (tx) => {
        const [operation] = await tx
          .insert(retailStockOperations)
          .values({
            companyId,
            operationType: "cancellation",
            idempotencyKey: body.idempotencyKey,
            referenceId: String(saleId),
            createdBy: userId,
            metadata: { reason: body.reason ?? null },
          })
          .onConflictDoNothing({ target: [retailStockOperations.companyId, retailStockOperations.idempotencyKey] })
          .returning({ id: retailStockOperations.id });
        if (!operation) return { replayed: true };

        await tx.execute(
          sql`select id from retail_pos_sales where id = ${saleId} and company_id = ${companyId} for update`
        );
        const [sale] = await tx
          .select({ id: retailPosSales.id, locationId: retailPosSales.locationId, status: retailPosSales.status })
          .from(retailPosSales)
          .where(and(eq(retailPosSales.id, saleId), eq(retailPosSales.companyId, companyId)))
          .limit(1);
        if (!sale) throw new Error("Retail sale not found");
        if (sale.locationId !== body.locationId)
          throw new Error("Cancellation location must match the original sale location");
        if (sale.status === "canceled") return { replayed: true };

        const saleItems = await tx
          .select({
            id: retailPosSaleItems.id,
            variantId: retailPosSaleItems.variantId,
            quantity: retailPosSaleItems.quantity,
            returnedQuantity: retailPosSaleItems.returnedQuantity,
            unitPrice: retailPosSaleItems.unitPrice,
            grossUnitPrice: retailPosSaleItems.grossUnitPrice,
            taxAmount: retailPosSaleItems.taxAmount,
            unitCost: retailPosSaleItems.unitCost,
          })
          .from(retailPosSaleItems)
          .where(and(eq(retailPosSaleItems.saleId, saleId), eq(retailPosSaleItems.companyId, companyId)));

        // Exact money (wave 17 C).
        let refundAmount = new MoneyDecimal(0);
        let refundTaxAmount = new MoneyDecimal(0);
        let restoredCost = new MoneyDecimal(0);
        const stockValue = await trackRetailStockValueTx(
          tx,
          companyId,
          saleItems.map((item) => ({ variantId: item.variantId, locationId: sale.locationId }))
        );
        for (const item of saleItems) {
          const sold = toNumber(item.quantity);
          const quantityToRestore = Math.max(0, sold - toNumber(item.returnedQuantity));
          if (quantityToRestore <= 0) continue;
          // Refund what was paid: the tax-inclusive gross price, as returns do.
          const grossPerUnit = toMoney(item.grossUnitPrice).gt(0)
            ? toMoney(item.grossUnitPrice)
            : toMoney(item.unitPrice);
          refundAmount = refundAmount.plus(lineAmount(quantityToRestore, grossPerUnit));
          if (sold > 0) {
            refundTaxAmount = refundTaxAmount.plus(toMoney(item.taxAmount).times(quantityToRestore).div(sold));
          }
          restoredCost = restoredCost.plus(lineAmount(quantityToRestore, item.unitCost));
          const stock = await lockInventoryRow(tx, companyId, item.variantId, sale.locationId);
          const after = stock.quantity + quantityToRestore;
          // Wave 17 (D): the units come back at the cost they left with, blended into the average.
          await setInventoryQuantity(
            tx,
            companyId,
            item.variantId,
            sale.locationId,
            after,
            nextAverageCost(stock.quantity, stock.averageCost, quantityToRestore, toNumber(item.unitCost))
          );
          await addMovement(tx, {
            companyId,
            variantId: item.variantId,
            locationId: sale.locationId,
            movementType: "cancellation",
            quantityDelta: quantityToRestore,
            before: stock.quantity,
            after,
            eventKey: `cancellation:${operation.id}:${item.id}`,
            referenceType: "retail_pos_sale",
            referenceId: saleId,
            createdBy: userId,
            metadata: { saleItemId: item.id, reason: body.reason ?? null },
          });
        }
        await tx
          .update(retailPosSales)
          .set({ status: "canceled", canceledAt: new Date(), updatedAt: new Date() })
          .where(eq(retailPosSales.id, saleId));
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
          refundAmount,
          idempotencyKey: body.idempotencyKey,
          userId,
        });
        const cancelVoucherId = await postRetailRefundAccountingTx(tx, {
          companyId,
          locationId: body.locationId,
          saleId,
          sourceType: "retail-pos-cancel",
          sourceId: String(saleId),
          idempotencyKey: `retail-pos-cancel:${saleId}`,
          refundAmount,
          refundTaxAmount: refundTaxAmount.toDecimalPlaces(6),
          restoredCost,
          refunds,
          userId,
          username: req.user?.username ?? null,
        });
        await stockValue.post({
          kind: "cancel",
          sourceId: saleId,
          description: `Retail cancellation of sale #${saleId}`,
          actor: { userId, username: req.user?.username ?? null },
          alreadyDebited: cancelVoucherId ? restoredCost : undefined,
        });
        return {
          replayed: false,
          operationId: operation.id,
          refundAmount: refundAmount.toNumber(),
          restoredCost: restoredCost.toNumber(),
        };
      });
      res.status(result.replayed ? 200 : 201).json({ ...result, sale: await loadSaleResponse(companyId, saleId) });
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}

import { infrastructurePostingIdentity } from "../services/accounting/infrastructureVoucherIdentity";
/**
 * Stock-adjustment & waste-dispatch routes.
 *
 * Stock-adjustment listing/create/update and waste-dispatch CRUD. Extracted
 * from fiscalTransferRoutes.ts as a sub-registrar; behaviour is unchanged.
 */
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { eq, and, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth, requireNonPOS } from "../auth";
import { logger } from "../lib/logger";
import { locations, wasteDispatches, wasteDispatchItems } from "@shared/schema";
import { allStockItemsOwned } from "./helpers/companyOwnership";
import { parseMoneyInput, sumMoney, toMoney } from "../lib/money";
import { createStockAdjustmentWithVoucherTx } from "../storage/stock-ops/transfers-create";
import { registerStockAdjustmentWasteRoutesPart1 } from "./registerStockAdjustmentWasteRoutesPart1";

export function registerStockAdjustmentWasteRoutes(app: Express) {
  registerStockAdjustmentWasteRoutesPart1(app);

  app.post("/api/waste-dispatches", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { locationId, dispatchDate, notes, items } = req.body;

      if (!locationId || !dispatchDate || !items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: "locationId, dispatchDate, and items are required" });
      }

      // Validate items
      for (const item of items) {
        if (!item.stockItemId || !item.quantity || !(parseMoneyInput(item.quantity)?.gt(0) ?? false)) {
          return res.status(400).json({ message: "Each item must have stockItemId and positive quantity" });
        }
      }

      // Generate dispatch number: WD-{YEAR}-{padded seq}
      const year = new Date(dispatchDate).getFullYear();
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(wasteDispatches)
        .where(eq(wasteDispatches.companyId, companyId));
      const seq = (count || 0) + 1;
      const dispatchNumber = `WD-${year}-${String(seq).padStart(4, "0")}`;

      // Get location name for voucher description
      const [location] = await db
        .select()
        .from(locations)
        .where(and(eq(locations.id, locationId), eq(locations.companyId, companyId)));
      if (!location) return res.status(400).json({ message: "Location not found" });
      if (
        !(await allStockItemsOwned(
          companyId,
          items.map((item: { stockItemId?: unknown }) => item?.stockItemId)
        ))
      ) {
        return res.status(400).json({ message: "Stock item not found" });
      }

      // Calculate total (will be updated after createStockAdjustment to use actual rates)
      const itemsForAdj = items.map((item) => ({
        stockItemId: parseInt(item.stockItemId),
        quantity: toMoney(item.quantity).abs().negated().toFixed(3), // negative = consumption
        rate: "0", // rate will be determined from inventory by createStockAdjustment
      }));

      // Wave 15: the voucher, its adjustment and the dispatch rows commit
      // together (they were separate transactions, so a failure could leave a
      // consumption voucher with no dispatch, or a dispatch with no stock).
      const dispatch = await db.transaction(async (tx) => {
        const adjResult = await createStockAdjustmentWithVoucherTx(
          tx,
          {
            companyId,
            voucherType: "Consumption",
            voucherNumber: dispatchNumber,
            voucherDate: dispatchDate,
            description: `Waste dispatch from ${location.name}`,
            totalAmount: "0",
            currency: "USD",
            sourceModule: "ERP",
            optional: false,
            locationId,
          },
          infrastructurePostingIdentity("waste-dispatch", `${companyId}:${dispatchNumber}`, "consumption"),
          locationId,
          notes || "",
          itemsForAdj
        );

        // Calculate total from actual rates used
        const totalAmount = sumMoney(adjResult.items.map((item: { totalAmount: string }) => item.totalAmount));

        const [created] = await tx
          .insert(wasteDispatches)
          .values({
            companyId,
            locationId,
            voucherId: adjResult.voucher.id,
            dispatchNumber,
            dispatchDate,
            notes: notes || null,
            totalAmount: totalAmount.toFixed(2),
          })
          .returning();

        for (const adjItem of adjResult.items) {
          await tx.insert(wasteDispatchItems).values({
            dispatchId: created.id,
            stockItemId: adjItem.stockItemId,
            quantity: toMoney(adjItem.quantity).abs().toFixed(3),
            rate: adjItem.rate,
            totalAmount: adjItem.totalAmount,
          });
        }
        return created;
      });

      res.json({ ...dispatch, voucherNumber: dispatchNumber });
    } catch (error: unknown) {
      logger.error("[Waste Dispatch POST] Error:", { error: getErrorMessage(error) });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/waste-dispatches/:id", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const [dispatch] = await db
        .select()
        .from(wasteDispatches)
        .where(and(eq(wasteDispatches.id, id), eq(wasteDispatches.companyId, companyId)));

      if (!dispatch) return res.status(404).json({ message: "Dispatch not found" });

      // Delete voucher (reverses inventory changes automatically via deleteVoucher logic)
      if (dispatch.voucherId) {
        await storage.deleteVoucher(dispatch.voucherId, {
          userId: req.session.userId ?? "unknown",
          username: req.session.username || "unknown",
        });
      }

      // Delete waste dispatch items and dispatch record
      await db.delete(wasteDispatchItems).where(eq(wasteDispatchItems.dispatchId, id));
      await db.delete(wasteDispatches).where(eq(wasteDispatches.id, id));

      res.json({ message: "Waste dispatch deleted and inventory reversed" });
    } catch (error: unknown) {
      logger.error("[Waste Dispatch DELETE] Error:", { error: getErrorMessage(error) });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

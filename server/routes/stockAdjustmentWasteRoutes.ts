import { infrastructurePostingIdentity } from "../services/accounting/infrastructureVoucherIdentity";
/**
 * Stock-adjustment & waste-dispatch routes.
 *
 * Stock-adjustment listing/create/update and waste-dispatch CRUD. Extracted
 * from fiscalTransferRoutes.ts as a sub-registrar; behaviour is unchanged.
 */
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth, requireNonPOS } from "../auth";
import { logger } from "../lib/logger";
import {
  locations,
  stockAdjustmentVouchers,
  stockItems,
  vouchers,
  wasteDispatches,
  wasteDispatchItems,
  updateStockAdjustmentSchema,
} from "@shared/schema";
import { stockAdjustmentCreateHandler } from "./stockAdjustmentCreateHandler";
import { requireActionAccess } from "../lib/permissionMiddleware";
import { allStockItemsOwned, ownLocationIds } from "./helpers/companyOwnership";
import { parseMoneyInput, sumMoney, toMoney } from "../lib/money";
import { createStockAdjustmentWithVoucherTx } from "../storage/stock-ops/transfers-create";

export function registerStockAdjustmentWasteRoutes(app: Express) {
  // Stock Adjustments - GET endpoint
  app.get("/api/stock-adjustments", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const voucherId = req.query.voucherId ? parseInt(req.query.voucherId as string) : null;

      if (!voucherId) {
        return res.status(400).json({ message: "voucherId query parameter is required" });
      }

      const adjustment = await storage.getStockAdjustmentByVoucherId(voucherId);
      res.json(adjustment);
    } catch (error: unknown) {
      logger.error("[Stock Adjustment GET] Error:", { error: getErrorMessage(error) });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Stock Adjustments - POST endpoint
  //
  // The create path lives in ./stockAdjustmentCreateHandler so it can align the
  // voucher with the company's native/base currency rather than the browser's
  // display-currency toggle. The route position and guard chain are unchanged.
  // Wave 12: the form creates its voucher here (POST /api/vouchers refuses stock
  // types), so the voucher-create permission that route required applies here.
  app.post(
    "/api/stock-adjustments",
    requireAuth,
    requireNonPOS,
    requireActionAccess("act_create_voucher"),
    stockAdjustmentCreateHandler
  );

  // Stock Adjustments - PUT endpoint (update)
  app.put("/api/stock-adjustments/:id", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseInt(req.params.id);
      if (!id) {
        return res.status(400).json({ message: "Adjustment ID is required" });
      }

      // Validate request body using Zod
      const parseResult = updateStockAdjustmentSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          message: "Invalid request data",
          errors: parseResult.error.issues,
        });
      }

      const { locationId, adjustmentType, notes, items } = parseResult.data;

      // The adjustment is reached by id and its location and items come from
      // the body; none of them is under the path-based company scope.
      const [owned] = await db
        .select({ id: stockAdjustmentVouchers.id })
        .from(stockAdjustmentVouchers)
        .innerJoin(vouchers, eq(vouchers.id, stockAdjustmentVouchers.voucherId))
        .where(and(eq(stockAdjustmentVouchers.id, id), eq(vouchers.companyId, companyId)));
      if (!owned) return res.status(404).json({ message: "Adjustment not found" });
      if (!(await ownLocationIds(companyId, [locationId])).has(locationId)) {
        return res.status(400).json({ message: "Location not found" });
      }
      if (
        !(await allStockItemsOwned(
          companyId,
          items.map((item) => item.stockItemId)
        ))
      ) {
        return res.status(400).json({ message: "Stock item not found" });
      }

      // Convert numbers back to strings with fixed precision for storage layer
      const itemsForStorage = items.map((item) => ({
        stockItemId: item.stockItemId,
        quantity: item.quantity.toFixed(3),
        rate: item.rate.toFixed(2),
      }));

      // Update the stock adjustment using the storage method
      const updated = await storage.updateStockAdjustment(id, locationId, adjustmentType, notes || "", itemsForStorage);

      res.json(updated);
    } catch (error: unknown) {
      logger.error("[Stock Adjustment PUT] Error:", { error: getErrorMessage(error) });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ===== WASTE DISPATCHES =====

  app.get("/api/waste-dispatches", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const dispatches = await db
        .select({
          id: wasteDispatches.id,
          companyId: wasteDispatches.companyId,
          locationId: wasteDispatches.locationId,
          voucherId: wasteDispatches.voucherId,
          dispatchNumber: wasteDispatches.dispatchNumber,
          dispatchDate: wasteDispatches.dispatchDate,
          notes: wasteDispatches.notes,
          totalAmount: wasteDispatches.totalAmount,
          createdAt: wasteDispatches.createdAt,
          locationName: locations.name,
        })
        .from(wasteDispatches)
        .leftJoin(locations, eq(locations.id, wasteDispatches.locationId))
        .where(eq(wasteDispatches.companyId, companyId))
        .orderBy(desc(wasteDispatches.createdAt));

      res.json(dispatches);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/waste-dispatches/:id", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const [dispatch] = await db
        .select({
          id: wasteDispatches.id,
          companyId: wasteDispatches.companyId,
          locationId: wasteDispatches.locationId,
          voucherId: wasteDispatches.voucherId,
          dispatchNumber: wasteDispatches.dispatchNumber,
          dispatchDate: wasteDispatches.dispatchDate,
          notes: wasteDispatches.notes,
          totalAmount: wasteDispatches.totalAmount,
          createdAt: wasteDispatches.createdAt,
          locationName: locations.name,
        })
        .from(wasteDispatches)
        .leftJoin(locations, eq(locations.id, wasteDispatches.locationId))
        .where(and(eq(wasteDispatches.id, id), eq(wasteDispatches.companyId, companyId)));

      if (!dispatch) return res.status(404).json({ message: "Dispatch not found" });

      const items = await db
        .select({
          id: wasteDispatchItems.id,
          stockItemId: wasteDispatchItems.stockItemId,
          quantity: wasteDispatchItems.quantity,
          rate: wasteDispatchItems.rate,
          totalAmount: wasteDispatchItems.totalAmount,
          stockItemName: stockItems.name,
          stockItemUnit: stockItems.uom,
        })
        .from(wasteDispatchItems)
        .leftJoin(stockItems, eq(stockItems.id, wasteDispatchItems.stockItemId))
        .where(eq(wasteDispatchItems.dispatchId, id));

      res.json({ ...dispatch, items });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

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

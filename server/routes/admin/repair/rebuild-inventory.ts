/**
 * adminRepairRoutes: AdminRebuildInventory endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import Decimal from "decimal.js";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import {
  addInventoryValues,
  divideInventoryValues,
  inventoryMoney,
  inventoryQuantity,
  inventoryUnitCost,
  multiplyInventoryValues,
  subtractInventoryValues,
  toInventoryDecimal,
} from "../../../lib/inventoryMath";
import { db } from "../../../db";
import { requireAuth, requireRole } from "../../../auth";
import {
  assertNoInventoryCutoverTx,
  sendInventoryCutoverRefusal,
} from "../../../services/accounting/perpetualInventory/cutoverRefusal";
import {
  inventory,
  stockItems,
  stockTransferVouchers,
  stockTransferItems,
  stockAdjustmentVouchers,
  stockAdjustmentItems,
  containers,
  containerOffloads,
  containerOffloadItems,
  purchaseOrders,
  poLineItems,
  vouchers,
  salesItems,
  locations,
  creditNoteItems,
} from "@shared/schema";
import { eq, and, or, inArray, isNull, isNotNull } from "drizzle-orm";

export function registerAdminRebuildInventoryRoutes(app: Express) {
  app.post("/api/admin/rebuild-inventory", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { dryRun = true } = req.body;
      // Wave 11: applying the rebuild rewrites stock with no journal, so it is
      // refused after the company's perpetual-inventory cut-over (the dry run
      // stays available: it only reads).
      if (!dryRun) await assertNoInventoryCutoverTx(db, companyId, "rebuild-inventory");

      const staleOptionalTrue = await db
        .select({ stId: stockTransferVouchers.id, voucherId: stockTransferVouchers.voucherId })
        .from(stockTransferVouchers)
        .innerJoin(vouchers, eq(vouchers.id, stockTransferVouchers.voucherId))
        .where(
          and(
            eq(vouchers.companyId, companyId),
            eq(vouchers.optional, true),
            eq(stockTransferVouchers.inventoryApplied, true),
            isNull(vouchers.deletedAt)
          )
        );

      const staleNonOptionalFalse = await db
        .select({ stId: stockTransferVouchers.id, voucherId: stockTransferVouchers.voucherId })
        .from(stockTransferVouchers)
        .innerJoin(vouchers, eq(vouchers.id, stockTransferVouchers.voucherId))
        .where(
          and(
            eq(vouchers.companyId, companyId),
            eq(vouchers.optional, false),
            eq(stockTransferVouchers.inventoryApplied, false),
            isNull(vouchers.deletedAt)
          )
        );

      const staleFlagsTotalCount = staleOptionalTrue.length + staleNonOptionalFalse.length;

      if (!dryRun) {
        if (staleOptionalTrue.length > 0) {
          await db
            .update(stockTransferVouchers)
            .set({ inventoryApplied: false })
            .where(
              inArray(
                stockTransferVouchers.id,
                staleOptionalTrue.map((f) => f.stId)
              )
            );
        }
        if (staleNonOptionalFalse.length > 0) {
          await db
            .update(stockTransferVouchers)
            .set({ inventoryApplied: true })
            .where(
              inArray(
                stockTransferVouchers.id,
                staleNonOptionalFalse.map((f) => f.stId)
              )
            );
        }
      }

      const expectedInv = new Map<string, { quantity: Decimal; totalValue: Decimal }>();

      function addToExpected(locationId: number, stockItemId: number, qty: Decimal.Value, value: Decimal.Value) {
        const key = `${locationId}-${stockItemId}`;
        const existing = expectedInv.get(key) || {
          quantity: toInventoryDecimal(0),
          totalValue: toInventoryDecimal(0),
        };
        expectedInv.set(key, {
          quantity: addInventoryValues(existing.quantity, qty),
          totalValue: addInventoryValues(existing.totalValue, value),
        });
      }

      const allOffloads = await db
        .select({
          offloadId: containerOffloads.id,
          locationId: containerOffloads.locationId,
          containerId: containerOffloads.containerId,
        })
        .from(containerOffloads)
        .innerJoin(containers, eq(containers.id, containerOffloads.containerId))
        .where(eq(containers.companyId, companyId));

      for (const offload of allOffloads) {
        const offloadItems = await db
          .select()
          .from(containerOffloadItems)
          .where(eq(containerOffloadItems.offloadId, offload.offloadId));

        if (offloadItems.length > 0) {
          for (const item of offloadItems) {
            const qty = toInventoryDecimal(item.quantity);
            if (!qty.isZero()) addToExpected(offload.locationId, item.stockItemId, qty, item.totalValue);
          }
        } else {
          const pos = await db.select().from(purchaseOrders).where(eq(purchaseOrders.containerId, offload.containerId));
          for (const po of pos) {
            const lineItems = await db.select().from(poLineItems).where(eq(poLineItems.poId, po.id));
            for (const li of lineItems) {
              const qty = toInventoryDecimal(li.quantity);
              if (!qty.isZero()) addToExpected(offload.locationId, li.stockItemId, qty, li.lineTotal);
            }
          }
        }
      }

      const activeTransfers = await db
        .select({
          stId: stockTransferVouchers.id,
          sourceLocationId: stockTransferVouchers.sourceLocationId,
          destinationLocationId: stockTransferVouchers.destinationLocationId,
        })
        .from(stockTransferVouchers)
        .innerJoin(vouchers, eq(vouchers.id, stockTransferVouchers.voucherId))
        .where(and(eq(vouchers.companyId, companyId), isNull(vouchers.deletedAt), eq(vouchers.optional, false)));

      for (const transfer of activeTransfers) {
        const items = await db
          .select()
          .from(stockTransferItems)
          .where(eq(stockTransferItems.transferId, transfer.stId));
        for (const item of items) {
          const qty = toInventoryDecimal(item.quantity);
          if (qty.isZero()) continue;
          const value = multiplyInventoryValues(qty, item.rate);
          const srcLoc = item.sourceLocationId || transfer.sourceLocationId;
          if (srcLoc) addToExpected(srcLoc, item.stockItemId, qty.negated(), value.negated());
          addToExpected(transfer.destinationLocationId, item.stockItemId, qty, value);
        }
      }

      const activeAdjustments = await db
        .select({
          adjId: stockAdjustmentVouchers.id,
          locationId: stockAdjustmentVouchers.locationId,
          adjustmentType: stockAdjustmentVouchers.adjustmentType,
        })
        .from(stockAdjustmentVouchers)
        .innerJoin(vouchers, eq(vouchers.id, stockAdjustmentVouchers.voucherId))
        .where(and(eq(vouchers.companyId, companyId), isNull(vouchers.deletedAt), eq(vouchers.optional, false)));

      for (const adj of activeAdjustments) {
        const items = await db
          .select()
          .from(stockAdjustmentItems)
          .where(eq(stockAdjustmentItems.adjustmentId, adj.adjId));
        for (const item of items) {
          let qty = toInventoryDecimal(item.quantity);
          if (adj.adjustmentType === "Consumption") qty = qty.abs().negated();
          else if (adj.adjustmentType === "Production") qty = qty.abs();
          if (!qty.isZero())
            addToExpected(adj.locationId, item.stockItemId, qty, multiplyInventoryValues(qty, item.rate));
        }
      }

      const activeSalesVouchers = await db
        .select({ vId: vouchers.id, locationId: vouchers.locationId })
        .from(vouchers)
        .where(
          and(
            eq(vouchers.companyId, companyId),
            eq(vouchers.voucherType, "Sales"),
            isNull(vouchers.deletedAt),
            eq(vouchers.optional, false),
            isNotNull(vouchers.locationId)
          )
        );

      for (const sale of activeSalesVouchers) {
        if (!sale.locationId) continue;
        const items = await db.select().from(salesItems).where(eq(salesItems.voucherId, sale.vId));
        for (const item of items) {
          const qty = toInventoryDecimal(item.quantity);
          if (!qty.isZero()) {
            addToExpected(
              sale.locationId,
              item.stockItemId,
              qty.negated(),
              multiplyInventoryValues(qty, item.costPrice).negated()
            );
          }
        }
      }

      const activeCreditDebitVouchers = await db
        .select({ vId: vouchers.id, voucherType: vouchers.voucherType })
        .from(vouchers)
        .where(
          and(
            eq(vouchers.companyId, companyId),
            or(eq(vouchers.voucherType, "Credit Note"), eq(vouchers.voucherType, "Debit Note")),
            isNull(vouchers.deletedAt),
            eq(vouchers.optional, false)
          )
        );

      for (const note of activeCreditDebitVouchers) {
        const items = await db.select().from(creditNoteItems).where(eq(creditNoteItems.voucherId, note.vId));
        for (const item of items) {
          const qty = toInventoryDecimal(item.quantity);
          if (qty.isZero()) continue;
          const value = multiplyInventoryValues(qty, item.inventoryCost || item.rate);
          if (note.voucherType === "Credit Note") addToExpected(item.locationId, item.stockItemId, qty, value);
          else addToExpected(item.locationId, item.stockItemId, qty.negated(), value.negated());
        }
      }

      const currentInventory = await db.select().from(inventory).where(eq(inventory.companyId, companyId));
      const currentMap = new Map<string, { id: number; quantity: Decimal; totalValue: Decimal }>();
      for (const inv of currentInventory) {
        currentMap.set(`${inv.locationId}-${inv.stockItemId}`, {
          id: inv.id,
          quantity: toInventoryDecimal(inv.quantity),
          totalValue: toInventoryDecimal(inv.totalValue),
        });
      }

      const allKeys = new Set([...expectedInv.keys(), ...currentMap.keys()]);
      const discrepancies: Array<{
        locationId: number;
        stockItemId: number;
        currentQty: Decimal;
        expectedQty: Decimal;
        difference: Decimal;
        currentValue: Decimal;
        expectedValue: Decimal;
      }> = [];

      for (const key of allKeys) {
        const [locStr, itemStr] = key.split("-");
        const locationId = parseInt(locStr);
        const stockItemId = parseInt(itemStr);
        const expected = expectedInv.get(key) || {
          quantity: toInventoryDecimal(0),
          totalValue: toInventoryDecimal(0),
        };
        const current = currentMap.get(key) || {
          id: 0,
          quantity: toInventoryDecimal(0),
          totalValue: toInventoryDecimal(0),
        };

        const qtyDiff = subtractInventoryValues(expected.quantity, current.quantity).abs();
        const valDiff = subtractInventoryValues(expected.totalValue, current.totalValue).abs();
        if (qtyDiff.greaterThan("0.001") || valDiff.greaterThan("0.01")) {
          discrepancies.push({
            locationId,
            stockItemId,
            currentQty: current.quantity,
            expectedQty: toInventoryDecimal(inventoryQuantity(expected.quantity)),
            difference: toInventoryDecimal(
              inventoryQuantity(subtractInventoryValues(expected.quantity, current.quantity))
            ),
            currentValue: current.totalValue,
            expectedValue: toInventoryDecimal(inventoryMoney(expected.totalValue)),
          });
        }
      }

      let fixesApplied = 0;
      if (!dryRun && discrepancies.length > 0) {
        await db.transaction(async (tx) => {
          for (const d of discrepancies) {
            const key = `${d.locationId}-${d.stockItemId}`;
            const current = currentMap.get(key);
            const avgRate = divideInventoryValues(d.expectedValue, d.expectedQty);
            const values = {
              quantity: inventoryQuantity(d.expectedQty),
              totalValue: inventoryMoney(d.expectedValue),
              averageRate: inventoryUnitCost(avgRate),
              lastUpdated: new Date(),
            };

            if (current && current.id) {
              await tx.update(inventory).set(values).where(eq(inventory.id, current.id));
            } else {
              await tx.insert(inventory).values({
                companyId,
                locationId: d.locationId,
                stockItemId: d.stockItemId,
                ...values,
              });
            }
            fixesApplied++;
          }
        });
      }

      const companyLocations = await db
        .select({ id: locations.id, name: locations.name })
        .from(locations)
        .where(eq(locations.companyId, companyId));
      const companyStockItems = await db
        .select({ id: stockItems.id, name: stockItems.name, code: stockItems.code })
        .from(stockItems)
        .where(eq(stockItems.companyId, companyId));
      const locationMap = new Map(companyLocations.map((l) => [l.id, l.name]));
      const stockItemMap = new Map(companyStockItems.map((s) => [s.id, { name: s.name, code: s.code }]));

      const enrichedDiscrepancies = discrepancies.map((d) => ({
        locationId: d.locationId,
        stockItemId: d.stockItemId,
        currentQty: d.currentQty.toNumber(),
        expectedQty: d.expectedQty.toNumber(),
        difference: d.difference.toNumber(),
        currentValue: d.currentValue.toNumber(),
        expectedValue: d.expectedValue.toNumber(),
        locationName: locationMap.get(d.locationId) || `Location #${d.locationId}`,
        stockItemName: stockItemMap.get(d.stockItemId)?.name || `Item #${d.stockItemId}`,
        stockItemCode: stockItemMap.get(d.stockItemId)?.code || "",
      }));

      res.json({
        success: true,
        dryRun,
        staleFlagsFound: staleFlagsTotalCount,
        staleFlagsFixed: dryRun ? 0 : staleFlagsTotalCount,
        staleFlagDetails: {
          optionalWithAppliedTrue: staleOptionalTrue.length,
          nonOptionalWithAppliedFalse: staleNonOptionalFalse.length,
        },
        totalInventoryRecords: currentInventory.length,
        discrepanciesFound: discrepancies.length,
        fixesApplied,
        discrepancies: enrichedDiscrepancies,
        warnings: [
          "Quick adjustments (manual add/subtract) are not backed by vouchers and cannot be replayed. They may appear as discrepancies.",
        ],
      });
    } catch (error: unknown) {
      if (sendInventoryCutoverRefusal(res, error)) return;
      logger.error("Rebuild inventory error:", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

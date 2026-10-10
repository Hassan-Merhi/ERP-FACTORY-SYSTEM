/**
 * deletedItemsRoutes: LocationSummary endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getClientDate } from "../../../lib/dateUtils";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth, requireRole } from "../../../auth";
import { toMoney } from "../../../lib/money";
import { inventory, stockItems, stockGroups, containers, purchaseOrders, vouchers } from "@shared/schema";
import { eq, and, inArray, sql, isNull } from "drizzle-orm";
import { handleLocationSummaryBandwidthProfile } from "./location-summary-bandwidth";
import { retireVouchersTx, sessionRetirementActor } from "../../../services/accounting/voucherRetirement";

export function registerLocationSummaryRoutes(app: Express) {
  // Stock Item Monthly Summary - Get aggregated monthly data for a stock item
  app.get("/api/location-summary", requireAuth, async (req, res) => {
    if (await handleLocationSummaryBandwidthProfile(req, res)) return;

    try {
      const companyId = req.query.companyId ? parseInt(req.query.companyId as string) : req.session.currentCompanyId;
      const locationIds = req.query.locationIds
        ? (req.query.locationIds as string).split(",").map((id) => parseInt(id))
        : [];
      const asOfDate = (req.query.asOfDate as string) || getClientDate(req);

      if (!companyId) {
        return res.status(400).json({ message: "Company ID is required" });
      }

      if (locationIds.length === 0) {
        return res.json({ stockGroups: [], grandTotals: {} });
      }

      // Get all stock groups for the company
      const allStockGroups = await db
        .select()
        .from(stockGroups)
        .where(and(eq(stockGroups.companyId, companyId), eq(stockGroups.active, true)))
        .orderBy(stockGroups.name);

      // Get all stock items with their groups (excluding deleted)
      const allStockItems = await db
        .select()
        .from(stockItems)
        .where(and(eq(stockItems.companyId, companyId), eq(stockItems.active, true), isNull(stockItems.deletedAt)))
        .orderBy(stockItems.name);

      // Get inventory for the selected locations
      const inventoryData = await db
        .select({
          locationId: inventory.locationId,
          stockItemId: inventory.stockItemId,
          quantity: inventory.quantity,
          averageRate: inventory.averageRate,
          totalValue: inventory.totalValue,
        })
        .from(inventory)
        .where(and(eq(inventory.companyId, companyId), inArray(inventory.locationId, locationIds)));

      // Lookup maps for inventory data; the value is the stored total_value
      // (wave 11), never quantity × the rounded average rate.
      const inventoryMap = new Map<string, { quantity: number; rate: number; value: number }>();
      for (const inv of inventoryData) {
        const key = `${inv.locationId}-${inv.stockItemId}`;
        const qty = parseFloat(inv.quantity || "0");
        const rate = parseFloat(inv.averageRate || "0");
        inventoryMap.set(key, {
          quantity: qty,
          rate: rate,
          value: toMoney(inv.totalValue).toNumber(),
        });
      }

      // Build response structure with stock groups containing items
      const result: Array<{
        id: number;
        code: string;
        name: string;
        locationData: Record<number, { quantity: number; rate: number; value: number }>;
        items: Array<{
          id: number;
          code: string;
          name: string;
          uom: string;
          locationData: Record<number, { quantity: number; rate: number; value: number }>;
        }>;
      }> = [];

      // Group stock items by their stockGroupId
      const itemsByGroup = new Map<number, typeof allStockItems>();
      const ungroupedItems: typeof allStockItems = [];

      for (const item of allStockItems) {
        if (item.stockGroupId) {
          if (!itemsByGroup.has(item.stockGroupId)) {
            itemsByGroup.set(item.stockGroupId, []);
          }
          itemsByGroup.get(item.stockGroupId)!.push(item);
        } else {
          ungroupedItems.push(item);
        }
      }

      // Build stock groups with their items and location data
      for (const group of allStockGroups) {
        const groupItems = itemsByGroup.get(group.id) || [];

        // Skip groups with no items that have inventory
        const groupHasInventory = groupItems.some((item) =>
          locationIds.some((locId) => {
            const key = `${locId}-${item.id}`;
            const inv = inventoryMap.get(key);
            return inv && inv.quantity !== 0;
          })
        );

        if (!groupHasInventory) continue;

        const groupLocationData: Record<number, { quantity: number; rate: number; value: number }> = {};

        // Initialize location totals for the group
        for (const locId of locationIds) {
          groupLocationData[locId] = { quantity: 0, rate: 0, value: 0 };
        }

        const itemsData: Array<{
          id: number;
          code: string;
          name: string;
          uom: string;
          locationData: Record<number, { quantity: number; rate: number; value: number }>;
        }> = [];

        for (const item of groupItems) {
          const itemLocationData: Record<number, { quantity: number; rate: number; value: number }> = {};
          let itemHasInventory = false;

          for (const locId of locationIds) {
            const key = `${locId}-${item.id}`;
            const inv = inventoryMap.get(key);

            if (inv && inv.quantity !== 0) {
              itemHasInventory = true;
              itemLocationData[locId] = inv;

              // Add to group totals
              groupLocationData[locId].quantity += inv.quantity;
              groupLocationData[locId].value += inv.value;
            } else {
              itemLocationData[locId] = { quantity: 0, rate: 0, value: 0 };
            }
          }

          if (itemHasInventory) {
            itemsData.push({
              id: item.id,
              code: item.code,
              name: item.name,
              uom: item.uom,
              locationData: itemLocationData,
            });
          }
        }

        // Calculate average rate for group totals
        for (const locId of locationIds) {
          if (groupLocationData[locId].quantity > 0) {
            groupLocationData[locId].rate = groupLocationData[locId].value / groupLocationData[locId].quantity;
          }
        }

        result.push({
          id: group.id,
          code: group.code,
          name: group.name,
          locationData: groupLocationData,
          items: itemsData,
        });
      }

      // Handle ungrouped items
      if (ungroupedItems.length > 0) {
        const ungroupedLocationData: Record<number, { quantity: number; rate: number; value: number }> = {};
        for (const locId of locationIds) {
          ungroupedLocationData[locId] = { quantity: 0, rate: 0, value: 0 };
        }

        const ungroupedItemsData: Array<{
          id: number;
          code: string;
          name: string;
          uom: string;
          locationData: Record<number, { quantity: number; rate: number; value: number }>;
        }> = [];

        for (const item of ungroupedItems) {
          const itemLocationData: Record<number, { quantity: number; rate: number; value: number }> = {};
          let itemHasInventory = false;

          for (const locId of locationIds) {
            const key = `${locId}-${item.id}`;
            const inv = inventoryMap.get(key);

            if (inv && inv.quantity !== 0) {
              itemHasInventory = true;
              itemLocationData[locId] = inv;
              ungroupedLocationData[locId].quantity += inv.quantity;
              ungroupedLocationData[locId].value += inv.value;
            } else {
              itemLocationData[locId] = { quantity: 0, rate: 0, value: 0 };
            }
          }

          if (itemHasInventory) {
            ungroupedItemsData.push({
              id: item.id,
              code: item.code,
              name: item.name,
              uom: item.uom,
              locationData: itemLocationData,
            });
          }
        }

        if (ungroupedItemsData.length > 0) {
          for (const locId of locationIds) {
            if (ungroupedLocationData[locId].quantity > 0) {
              ungroupedLocationData[locId].rate =
                ungroupedLocationData[locId].value / ungroupedLocationData[locId].quantity;
            }
          }

          result.push({
            id: 0,
            code: "UNGROUPED",
            name: "Ungrouped Items",
            locationData: ungroupedLocationData,
            items: ungroupedItemsData,
          });
        }
      }

      // Calculate grand totals per location
      const grandTotals: Record<number, { quantity: number; rate: number; value: number }> = {};
      for (const locId of locationIds) {
        grandTotals[locId] = { quantity: 0, rate: 0, value: 0 };
      }

      for (const group of result) {
        for (const locId of locationIds) {
          grandTotals[locId].quantity += group.locationData[locId]?.quantity || 0;
          grandTotals[locId].value += group.locationData[locId]?.value || 0;
        }
      }

      // Calculate average rate for grand totals
      for (const locId of locationIds) {
        if (grandTotals[locId].quantity > 0) {
          grandTotals[locId].rate = grandTotals[locId].value / grandTotals[locId].quantity;
        }
      }

      res.json({
        stockGroups: result,
        grandTotals,
        asOfDate,
      });
    } catch (error: unknown) {
      logger.error("Location summary error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Cleanup endpoint to remove orphaned charge vouchers - admin only (destructive)
  app.post("/api/cleanup/orphaned-charges", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      // Wave 16 (A): the current company's live CHARGE vouchers only (it read
      // every company's), retired rather than hard-deleted.
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const chargeVouchers = await db
        .select()
        .from(vouchers)
        .where(
          and(
            eq(vouchers.companyId, companyId),
            isNull(vouchers.deletedAt),
            sql`${vouchers.voucherNumber} LIKE 'CHARGE-%'`
          )
        );

      let deletedCount = 0;

      for (const chargeVoucher of chargeVouchers) {
        // Extract container number from voucher number (format: CHARGE-CONT-XXXX-YYYY-...)
        const containerNumber =
          chargeVoucher.voucherNumber.split("-")[1] + "-" + chargeVoucher.voucherNumber.split("-")[2];

        // Check if any POs exist for this container
        const remainingPOs = await db
          .select()
          .from(purchaseOrders)
          .leftJoin(containers, eq(purchaseOrders.containerId, containers.id))
          .where(and(eq(containers.containerNumber, containerNumber), eq(containers.companyId, companyId)))
          .limit(1);

        // If no POs for this container, delete the charge voucher
        if (remainingPOs.length === 0) {
          const retired = await db.transaction((tx) =>
            retireVouchersTx(tx, {
              companyId,
              voucherIds: [chargeVoucher.id],
              reason: "orphaned-charge-voucher-cleanup",
              actor: sessionRetirementActor(req),
            })
          );
          deletedCount += retired.length;
        }
      }

      res.json({
        message: `Cleaned up ${deletedCount} orphaned charge vouchers`,
        deletedCount,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ============================================================
  // DELETED ITEMS MANAGEMENT (Trash/Recycle Bin)
  // ============================================================
}

/**
 * stockTransferAdjRoutes: PosPriceList endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour. GET /api/pos/price-list therefore
 * has to carry the price-group (follower -> master) inheritance itself: a
 * second, later registration elsewhere would simply never be reached.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { requireAuth, requireNonPOS } from "../../../auth";
import {
  inventory,
  stockItems,
  stockGroups,
  stockItemLocationPrices,
  locations,
  locationPriceGroups,
} from "@shared/schema";
import { eq, and, inArray, sql, isNull } from "drizzle-orm";
import { registerPosPriceListRoutesPart1 } from "./registerPosPriceListRoutesPart1";

export function registerPosPriceListRoutes(app: Express) {
  registerPosPriceListRoutesPart1(app);

  // Price list for All Locations view: one price column per configured master location
  app.get("/api/pos/price-list-by-masters", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const isPrivileged = ["Admin", "Owner", "Manager", "Developer"].includes(req.user?.role || "");

      // Get all configured master location IDs
      const groupRows = await db
        .select({ masterLocationId: locationPriceGroups.masterLocationId })
        .from(locationPriceGroups)
        .where(eq(locationPriceGroups.companyId, companyId));

      const masterIds = [...new Set(groupRows.map((r) => r.masterLocationId))];

      // Get master location names
      const masterLocations =
        masterIds.length > 0
          ? await db
              .select({ id: locations.id, name: locations.name })
              .from(locations)
              .where(and(eq(locations.companyId, companyId), inArray(locations.id, masterIds)))
          : [];

      // Get all active stock items
      const items = await db
        .select({
          stockItemId: stockItems.id,
          code: stockItems.code,
          name: stockItems.name,
          stockGroupName: sql<string>`COALESCE(${stockGroups.name}, '')`,
          baseSellingPrice: stockItems.sellingPrice,
        })
        .from(stockItems)
        .leftJoin(stockGroups, eq(stockItems.stockGroupId, stockGroups.id))
        .where(and(eq(stockItems.companyId, companyId), isNull(stockItems.deletedAt)))
        .orderBy(stockItems.name);

      // Get location-specific prices for all master locations in one query
      const masterPriceRows =
        masterIds.length > 0
          ? await db
              .select({
                stockItemId: stockItemLocationPrices.stockItemId,
                locationId: stockItemLocationPrices.locationId,
                sellingPrice: stockItemLocationPrices.sellingPrice,
              })
              .from(stockItemLocationPrices)
              .where(
                and(
                  inArray(stockItemLocationPrices.locationId, masterIds),
                  inArray(
                    stockItemLocationPrices.stockItemId,
                    items.map((i) => i.stockItemId)
                  )
                )
              )
          : [];

      // Build a nested map: stockItemId -> locationId -> price
      const priceMap = new Map<number, Map<number, string>>();
      for (const p of masterPriceRows) {
        if (!priceMap.has(p.stockItemId)) priceMap.set(p.stockItemId, new Map());
        priceMap.get(p.stockItemId)!.set(p.locationId, p.sellingPrice);
      }

      // Sum live stock across every location in the current company.
      const totalQuantityRows =
        items.length > 0
          ? await db
              .select({
                stockItemId: inventory.stockItemId,
                totalQuantity: sql<string>`COALESCE(SUM(CAST(${inventory.quantity} AS numeric)), 0)::text`,
              })
              .from(inventory)
              .innerJoin(locations, eq(inventory.locationId, locations.id))
              .where(
                and(
                  eq(locations.companyId, companyId),
                  inArray(
                    inventory.stockItemId,
                    items.map((i) => i.stockItemId)
                  )
                )
              )
              .groupBy(inventory.stockItemId)
          : [];

      const totalQuantityMap = new Map<number, string>();
      for (const row of totalQuantityRows) {
        totalQuantityMap.set(row.stockItemId, row.totalQuantity);
      }

      // Attach cost data for privileged users
      const dubaiMap = new Map<number, string>();
      const offloadMap = new Map<number, string>();
      if (isPrivileged && items.length > 0) {
        const [dubaiCostRes, offloadCostRes] = await Promise.all([
          db.execute(sql`
            SELECT DISTINCT ON (pli.stock_item_id)
              pli.stock_item_id AS "stockItemId",
              pli.rate AS "costDubai"
            FROM po_line_items pli
            JOIN purchase_orders po ON pli.po_id = po.id
            JOIN containers c ON po.container_id = c.id
            WHERE po.company_id = ${companyId}
            ORDER BY pli.stock_item_id, pli.id DESC
          `),
          db.execute(sql`
            SELECT DISTINCT ON (pli.stock_item_id)
              pli.stock_item_id AS "stockItemId",
              co.additional_cost_per_bale AS "offloadingCost"
            FROM container_offloads co
            JOIN containers c ON co.container_id = c.id
            JOIN purchase_orders po ON po.container_id = c.id
            JOIN po_line_items pli ON pli.po_id = po.id
            WHERE c.company_id = ${companyId}
            ORDER BY pli.stock_item_id, co.offloaded_at DESC
          `),
        ]);
        for (const r of dubaiCostRes.rows) dubaiMap.set(Number(r.stockItemId), String(r.costDubai ?? "0"));
        for (const r of offloadCostRes.rows) offloadMap.set(Number(r.stockItemId), String(r.offloadingCost ?? "0"));
      }

      const result = items.map((item) => {
        const itemPrices: Record<number, string> = {};
        for (const mloc of masterLocations) {
          const custom = priceMap.get(item.stockItemId)?.get(mloc.id);
          itemPrices[mloc.id] = custom ?? item.baseSellingPrice ?? "0";
        }
        const base: {
          masterPrices: Record<number, string>;
          stockItemId: number;
          code: string;
          name: string;
          stockGroupName: string;
          baseSellingPrice: string | null;
          totalQuantity: string;
          costPrice?: string | null;
          offloadingCost?: string | null;
        } = {
          ...item,
          masterPrices: itemPrices,
          totalQuantity: totalQuantityMap.get(item.stockItemId) ?? "0",
        };
        if (isPrivileged) {
          base.costPrice = dubaiMap.get(item.stockItemId) ?? null;
          base.offloadingCost = offloadMap.get(item.stockItemId) ?? null;
        }
        return base;
      });

      res.json({ masters: masterLocations, items: result });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

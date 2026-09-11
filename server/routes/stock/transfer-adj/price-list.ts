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
  userLocations,
  locationPriceGroups,
} from "@shared/schema";
import { eq, and, inArray, sql, isNull } from "drizzle-orm";

type PriceListRow = {
  stockItemId: number;
  code: string;
  name: string;
  stockGroupName: string;
  baseSellingPrice: string | null;
  hasCustomPrice: boolean;
  sellingPrice: string | null;
  quantity: string;
  costPrice?: string | null;
  offloadingCost?: string | null;
};

export function registerPosPriceListRoutes(app: Express) {
  // POS Price List: get all stock items with location-specific selling prices
  // Fallback rule: if no custom location price, falls back to stock item base selling price
  app.get("/api/pos/price-list", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const locationIdParam = req.query.locationId as string;
      const showAll = locationIdParam === "all";
      const locationId = showAll ? null : parseInt(locationIdParam);

      if (!showAll && isNaN(locationId as number)) {
        return res.status(400).json({ message: "locationId query parameter is required" });
      }

      const isPOS = req.user?.role === "POS";
      const isPrivileged = ["Admin", "Owner", "Manager", "Developer"].includes(req.user?.role || "");

      if (showAll && isPOS) {
        return res.status(403).json({ message: "Forbidden" });
      }

      if (!showAll) {
        if (isPOS) {
          const assigned = await db
            .select({ locationId: userLocations.locationId })
            .from(userLocations)
            .where(and(eq(userLocations.userId, req.user!.id), eq(userLocations.companyId, companyId)));
          const assignedIds = assigned.map((r) => r.locationId);
          if (!assignedIds.includes(locationId as number)) {
            return res.status(403).json({ message: "Forbidden: location not assigned to this user" });
          }
        } else {
          const [loc] = await db
            .select({ id: locations.id })
            .from(locations)
            .where(and(eq(locations.id, locationId as number), eq(locations.companyId, companyId)));
          if (!loc) {
            return res.status(403).json({ message: "Forbidden: location not found" });
          }
        }
      }

      let rows: PriceListRow[];

      if (showAll) {
        rows = await db
          .select({
            stockItemId: stockItems.id,
            code: stockItems.code,
            name: stockItems.name,
            stockGroupName: sql<string>`COALESCE(${stockGroups.name}, '')`,
            baseSellingPrice: stockItems.sellingPrice,
            hasCustomPrice: sql<boolean>`false`,
            sellingPrice: stockItems.sellingPrice,
            quantity: sql<string>`'0'`,
          })
          .from(stockItems)
          .leftJoin(stockGroups, eq(stockItems.stockGroupId, stockGroups.id))
          .where(and(eq(stockItems.companyId, companyId), isNull(stockItems.deletedAt)))
          .orderBy(stockItems.name);
      } else {
        // Followers inherit the master's price. Masters and ungrouped locations
        // continue to use their own location-specific price. Inventory quantity
        // always comes from the requested location itself.
        const [priceGroup] = await db
          .select({ masterLocationId: locationPriceGroups.masterLocationId })
          .from(locationPriceGroups)
          .where(
            and(
              eq(locationPriceGroups.companyId, companyId),
              eq(locationPriceGroups.followerLocationId, locationId as number)
            )
          )
          .limit(1);

        const effectivePriceLocationId = priceGroup?.masterLocationId ?? (locationId as number);

        rows = await db
          .select({
            stockItemId: stockItems.id,
            code: stockItems.code,
            name: stockItems.name,
            stockGroupName: sql<string>`COALESCE(${stockGroups.name}, '')`,
            baseSellingPrice: stockItems.sellingPrice,
            hasCustomPrice: sql<boolean>`(${stockItemLocationPrices.sellingPrice} IS NOT NULL)`,
            sellingPrice: sql<string>`COALESCE(${stockItemLocationPrices.sellingPrice}, ${stockItems.sellingPrice})`,
            quantity: sql<string>`COALESCE(${inventory.quantity}::text, '0')`,
          })
          .from(stockItems)
          .leftJoin(stockGroups, eq(stockItems.stockGroupId, stockGroups.id))
          .leftJoin(
            stockItemLocationPrices,
            and(
              eq(stockItemLocationPrices.stockItemId, stockItems.id),
              eq(stockItemLocationPrices.locationId, effectivePriceLocationId)
            )
          )
          .leftJoin(
            inventory,
            and(eq(inventory.stockItemId, stockItems.id), eq(inventory.locationId, locationId as number))
          )
          .where(and(eq(stockItems.companyId, companyId), isNull(stockItems.deletedAt)))
          .orderBy(stockItems.name);
      }

      // For privileged users, fetch Dubai cost (from latest PO line rate) and offloading cost
      if (isPrivileged && rows.length > 0) {
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

        const dubaiMap = new Map<number, string>();
        for (const r of dubaiCostRes.rows) {
          dubaiMap.set(Number(r.stockItemId), String(r.costDubai ?? "0"));
        }
        const offloadMap = new Map<number, string>();
        for (const r of offloadCostRes.rows) {
          offloadMap.set(Number(r.stockItemId), String(r.offloadingCost ?? "0"));
        }

        rows = rows.map((row) => ({
          ...row,
          costPrice: dubaiMap.get(row.stockItemId) ?? null,
          offloadingCost: offloadMap.get(row.stockItemId) ?? null,
        }));
      }

      res.json(rows);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

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
          costPrice?: string | null;
          offloadingCost?: string | null;
        } = { ...item, masterPrices: itemPrices };
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

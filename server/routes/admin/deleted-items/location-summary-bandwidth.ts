import type { Request, Response } from "express";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { inventory, stockGroups, stockItems } from "@shared/schema";
import { db } from "../../../db";
import { getClientDate } from "../../../lib/dateUtils";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";

type LocationCell = {
  quantity: number;
  rate: number;
  value: number;
};

type CompactGroup = {
  id: number;
  code: string;
  name: string;
  locationData: Record<number, LocationCell>;
  items: CompactItem[];
};

type CompactItem = {
  id: number;
  code: string;
  name: string;
  uom: string;
  locationData: Record<number, LocationCell>;
};

function parseLocationIds(value: unknown): number[] {
  if (typeof value !== "string") return [];
  return Array.from(
    new Set(
      value
        .split(",")
        .map((part) => Number.parseInt(part, 10))
        .filter((id) => Number.isInteger(id) && id > 0)
    )
  ).sort((left, right) => left - right);
}

function numeric(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function addCell(target: LocationCell, quantity: number, value: number): void {
  target.quantity += quantity;
  target.value += value;
}

function finalizeCell(cell: LocationCell): LocationCell {
  return {
    quantity: cell.quantity,
    value: cell.value,
    rate: cell.quantity > 0 ? cell.value / cell.quantity : 0,
  };
}

function emptyCell(): LocationCell {
  return { quantity: 0, rate: 0, value: 0 };
}

function responseAsOfDate(req: Request): string {
  return typeof req.query.asOfDate === "string" && req.query.asOfDate ? req.query.asOfDate : getClientDate(req);
}

/**
 * Handles bandwidth-optimized GET /api/location-summary contracts.
 *
 * No profile: backwards-compatible full shape for legacy callers, but generated
 * only from non-zero inventory rows and with sparse location cells. This removes
 * the old Cartesian-style zero cells while keeping every group/item the caller
 * actually needs.
 *
 * `profile=summary`: stock-group totals + grand totals only. The Location
 * Summary page uses this for its first paint, so thousands of item rows are not
 * transferred until a group is expanded.
 *
 * `profile=group&groupId=<id>`: item rows for one expanded stock group only.
 * `groupId=0` represents ungrouped items.
 */
export async function handleLocationSummaryBandwidthProfile(req: Request, res: Response): Promise<boolean> {
  const requestedProfile = typeof req.query.profile === "string" ? req.query.profile : "";
  const profile = requestedProfile === "" ? "full" : requestedProfile;
  if (profile !== "full" && profile !== "summary" && profile !== "group") return false;

  try {
    // Compact contracts are always scoped to the authenticated session company;
    // callers cannot widen the read by supplying an arbitrary companyId query.
    const companyId = req.session.currentCompanyId;
    const locationIds = parseLocationIds(req.query.locationIds);

    if (!companyId) {
      res.status(400).json({ message: "Company ID is required" });
      return true;
    }

    if (locationIds.length === 0) {
      if (profile === "group") res.json({ groupId: null, items: [] });
      else res.json({ stockGroups: [], grandTotals: {}, asOfDate: responseAsOfDate(req) });
      return true;
    }

    if (profile === "summary") {
      const rows = await db
        .select({
          locationId: inventory.locationId,
          groupId: sql<number>`COALESCE(${stockGroups.id}, 0)::int`,
          groupCode: sql<string>`COALESCE(${stockGroups.code}, 'UNGROUPED')`,
          groupName: sql<string>`COALESCE(${stockGroups.name}, 'Ungrouped Items')`,
          quantity: sql<string>`SUM(COALESCE(${inventory.quantity}, '0')::numeric)::text`,
          // Stored value (wave 11), not quantity × the rounded average rate.
          value: sql<string>`SUM(COALESCE(${inventory.totalValue}, '0')::numeric)::text`,
        })
        .from(inventory)
        .innerJoin(
          stockItems,
          and(
            eq(stockItems.id, inventory.stockItemId),
            eq(stockItems.companyId, companyId),
            eq(stockItems.active, true),
            isNull(stockItems.deletedAt)
          )
        )
        .leftJoin(
          stockGroups,
          and(
            eq(stockGroups.id, stockItems.stockGroupId),
            eq(stockGroups.companyId, companyId),
            eq(stockGroups.active, true)
          )
        )
        .where(
          and(
            eq(inventory.companyId, companyId),
            inArray(inventory.locationId, locationIds),
            sql`${inventory.quantity}::numeric <> 0`,
            sql`(${stockItems.stockGroupId} IS NULL OR ${stockGroups.id} IS NOT NULL)`
          )
        )
        .groupBy(inventory.locationId, stockGroups.id, stockGroups.code, stockGroups.name)
        .orderBy(sql`CASE WHEN ${stockGroups.id} IS NULL THEN 1 ELSE 0 END`, stockGroups.name);

      const groups = new Map<number, CompactGroup>();
      const grandTotals: Record<number, LocationCell> = {};

      for (const row of rows) {
        const locationId = Number(row.locationId);
        const quantity = numeric(row.quantity);
        const value = numeric(row.value);
        const groupId = Number(row.groupId);

        let group = groups.get(groupId);
        if (!group) {
          group = {
            id: groupId,
            code: row.groupCode || (groupId === 0 ? "UNGROUPED" : ""),
            name: row.groupName || (groupId === 0 ? "Ungrouped Items" : ""),
            locationData: {},
            items: [],
          };
          groups.set(groupId, group);
        }

        group.locationData[locationId] = finalizeCell({ quantity, value, rate: 0 });

        const grand = grandTotals[locationId] ?? emptyCell();
        addCell(grand, quantity, value);
        grandTotals[locationId] = grand;
      }

      for (const locationId of Object.keys(grandTotals)) {
        const id = Number(locationId);
        grandTotals[id] = finalizeCell(grandTotals[id]);
      }

      res.setHeader("X-ERP-Payload-Profile", "location-summary-groups");
      res.json({
        stockGroups: Array.from(groups.values()),
        grandTotals,
        asOfDate: responseAsOfDate(req),
      });
      return true;
    }

    if (profile === "group") {
      const groupId = Number.parseInt(String(req.query.groupId ?? ""), 10);
      if (!Number.isInteger(groupId) || groupId < 0) {
        res.status(400).json({ message: "groupId is required for profile=group" });
        return true;
      }

      if (groupId !== 0) {
        const existingGroup = await db
          .select({ id: stockGroups.id })
          .from(stockGroups)
          .where(and(eq(stockGroups.id, groupId), eq(stockGroups.companyId, companyId), eq(stockGroups.active, true)))
          .limit(1);
        if (existingGroup.length === 0) {
          res.status(404).json({ message: "Stock group not found" });
          return true;
        }
      }

      const itemRows = await db
        .select({
          id: stockItems.id,
          code: stockItems.code,
          name: stockItems.name,
          uom: stockItems.uom,
          locationId: inventory.locationId,
          quantity: inventory.quantity,
          averageRate: inventory.averageRate,
          totalValue: inventory.totalValue,
        })
        .from(inventory)
        .innerJoin(
          stockItems,
          and(
            eq(stockItems.id, inventory.stockItemId),
            eq(stockItems.companyId, companyId),
            eq(stockItems.active, true),
            isNull(stockItems.deletedAt)
          )
        )
        .where(
          and(
            eq(inventory.companyId, companyId),
            inArray(inventory.locationId, locationIds),
            groupId === 0 ? isNull(stockItems.stockGroupId) : eq(stockItems.stockGroupId, groupId),
            sql`${inventory.quantity}::numeric <> 0`
          )
        )
        .orderBy(stockItems.name, stockItems.id);

      const items = new Map<number, CompactItem>();
      for (const row of itemRows) {
        const itemId = Number(row.id);
        let item = items.get(itemId);
        if (!item) {
          item = {
            id: itemId,
            code: row.code,
            name: row.name,
            uom: row.uom,
            locationData: {},
          };
          items.set(itemId, item);
        }

        const quantity = numeric(row.quantity);
        const rate = numeric(row.averageRate);
        item.locationData[Number(row.locationId)] = {
          quantity,
          rate,
          // The stored value (wave 11), not quantity × the rounded rate.
          value: numeric(row.totalValue),
        };
      }

      res.setHeader("X-ERP-Payload-Profile", "location-summary-group-items");
      res.json({ groupId, items: Array.from(items.values()) });
      return true;
    }

    // Legacy full contract, optimized: one joined read of only non-zero inventory
    // and sparse location cells. This keeps Stock Transfer / Smart Transfer
    // callers compatible while removing the large zero-filled payload.
    const rows = await db
      .select({
        groupId: sql<number>`COALESCE(${stockGroups.id}, 0)::int`,
        groupCode: sql<string>`COALESCE(${stockGroups.code}, 'UNGROUPED')`,
        groupName: sql<string>`COALESCE(${stockGroups.name}, 'Ungrouped Items')`,
        itemId: stockItems.id,
        itemCode: stockItems.code,
        itemName: stockItems.name,
        uom: stockItems.uom,
        locationId: inventory.locationId,
        quantity: inventory.quantity,
        averageRate: inventory.averageRate,
        totalValue: inventory.totalValue,
      })
      .from(inventory)
      .innerJoin(
        stockItems,
        and(
          eq(stockItems.id, inventory.stockItemId),
          eq(stockItems.companyId, companyId),
          eq(stockItems.active, true),
          isNull(stockItems.deletedAt)
        )
      )
      .leftJoin(
        stockGroups,
        and(
          eq(stockGroups.id, stockItems.stockGroupId),
          eq(stockGroups.companyId, companyId),
          eq(stockGroups.active, true)
        )
      )
      .where(
        and(
          eq(inventory.companyId, companyId),
          inArray(inventory.locationId, locationIds),
          sql`${inventory.quantity}::numeric <> 0`,
          sql`(${stockItems.stockGroupId} IS NULL OR ${stockGroups.id} IS NOT NULL)`
        )
      )
      .orderBy(
        sql`CASE WHEN ${stockGroups.id} IS NULL THEN 1 ELSE 0 END`,
        stockGroups.name,
        stockItems.name,
        stockItems.id
      );

    const groups = new Map<number, CompactGroup>();
    const itemsByGroup = new Map<number, Map<number, CompactItem>>();
    const grandTotals: Record<number, LocationCell> = {};

    for (const row of rows) {
      const groupId = Number(row.groupId);
      const itemId = Number(row.itemId);
      const locationId = Number(row.locationId);
      const quantity = numeric(row.quantity);
      const rate = numeric(row.averageRate);
      // The stored value (wave 11), not quantity × the rounded rate.
      const value = numeric(row.totalValue);

      let group = groups.get(groupId);
      if (!group) {
        group = {
          id: groupId,
          code: row.groupCode || (groupId === 0 ? "UNGROUPED" : ""),
          name: row.groupName || (groupId === 0 ? "Ungrouped Items" : ""),
          locationData: {},
          items: [],
        };
        groups.set(groupId, group);
        itemsByGroup.set(groupId, new Map());
      }

      const groupCell = group.locationData[locationId] ?? emptyCell();
      addCell(groupCell, quantity, value);
      group.locationData[locationId] = groupCell;

      const groupItems = itemsByGroup.get(groupId)!;
      let item = groupItems.get(itemId);
      if (!item) {
        item = {
          id: itemId,
          code: row.itemCode,
          name: row.itemName,
          uom: row.uom,
          locationData: {},
        };
        groupItems.set(itemId, item);
        group.items.push(item);
      }
      item.locationData[locationId] = { quantity, rate, value };

      const grand = grandTotals[locationId] ?? emptyCell();
      addCell(grand, quantity, value);
      grandTotals[locationId] = grand;
    }

    for (const group of groups.values()) {
      for (const locationId of Object.keys(group.locationData)) {
        const id = Number(locationId);
        group.locationData[id] = finalizeCell(group.locationData[id]);
      }
    }
    for (const locationId of Object.keys(grandTotals)) {
      const id = Number(locationId);
      grandTotals[id] = finalizeCell(grandTotals[id]);
    }

    res.setHeader("X-ERP-Payload-Profile", "location-summary-full-sparse");
    res.json({
      stockGroups: Array.from(groups.values()),
      grandTotals,
      asOfDate: responseAsOfDate(req),
    });
    return true;
  } catch (error: unknown) {
    logger.error("Location summary bandwidth profile error:", { error });
    res.status(500).json({ message: getErrorMessage(error) });
    return true;
  }
}

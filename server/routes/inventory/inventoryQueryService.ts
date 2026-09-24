import { and, asc, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { punctuationInsensitiveSearch } from "../../lib/searchNormalization";
import { inventory, locations, stockGroups, stockItems } from "@shared/schema";

import { db } from "../../db";
import type { InventoryListFilters } from "./inventoryRequestContext";

function buildInventoryConditions(companyId: number, filters: InventoryListFilters) {
  const conditions: (SQL | undefined)[] = [
    eq(inventory.companyId, companyId),
    isNull(locations.deletedAt),
    isNull(stockItems.deletedAt),
  ];
  if (filters.locationId) conditions.push(eq(inventory.locationId, filters.locationId));
  if (filters.stockGroupId) conditions.push(eq(stockItems.stockGroupId, filters.stockGroupId));
  if (filters.search) {
    conditions.push(
      or(
        punctuationInsensitiveSearch(stockItems.name, filters.search),
        punctuationInsensitiveSearch(stockItems.code, filters.search)
      )
    );
  }
  return and(...conditions);
}

export async function getInventoryPage(companyId: number, filters: InventoryListFilters) {
  const where = buildInventoryConditions(companyId, filters);

  if (filters.profile === "combined") {
    const data = await db
      .select({
        stockItemId: inventory.stockItemId,
        stockItemName: sql<string>`COALESCE(${stockItems.name}, '')`,
        stockItemCode: sql<string>`COALESCE(${stockItems.code}, '')`,
        quantity: sql<string>`COALESCE(SUM(${inventory.quantity}::numeric), 0)::text`,
        averageRate: sql<string>`CASE
          WHEN COALESCE(SUM(${inventory.quantity}::numeric), 0) = 0 THEN '0'
          ELSE (COALESCE(SUM(${inventory.totalValue}::numeric), 0) / NULLIF(SUM(${inventory.quantity}::numeric), 0))::text
        END`,
        totalValue: sql<string>`COALESCE(SUM(${inventory.totalValue}::numeric), 0)::text`,
        stockGroupId: stockItems.stockGroupId,
        stockGroupName: sql<string>`COALESCE(${stockGroups.name}, '')`,
      })
      .from(inventory)
      .leftJoin(stockItems, eq(inventory.stockItemId, stockItems.id))
      .leftJoin(stockGroups, eq(stockItems.stockGroupId, stockGroups.id))
      .innerJoin(locations, eq(inventory.locationId, locations.id))
      .where(where)
      .groupBy(inventory.stockItemId, stockItems.name, stockItems.code, stockItems.stockGroupId, stockGroups.name)
      .orderBy(asc(stockItems.code));

    return {
      data,
      page: 1,
      pageSize: data.length,
      total: data.length,
      totalPages: data.length === 0 ? 0 : 1,
    };
  }

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(inventory)
    .leftJoin(stockItems, eq(inventory.stockItemId, stockItems.id))
    .leftJoin(stockGroups, eq(stockItems.stockGroupId, stockGroups.id))
    .innerJoin(locations, eq(inventory.locationId, locations.id))
    .where(where);

  const offset = (filters.page - 1) * filters.pageSize;
  const data = await db
    .select({
      inventoryId: inventory.id,
      locationId: inventory.locationId,
      locationName: locations.name,
      locationCode: locations.code,
      stockItemId: inventory.stockItemId,
      quantity: inventory.quantity,
      averageRate: inventory.averageRate,
      totalValue: inventory.totalValue,
      lastUpdated: inventory.lastUpdated,
      stockItemCode: stockItems.code,
      stockItemName: stockItems.name,
      stockItemUom: stockItems.uom,
      stockGroupId: stockItems.stockGroupId,
      stockGroupName: sql<string>`COALESCE(${stockGroups.name}, '')`,
      stockGroupCode: sql<string>`COALESCE(${stockGroups.code}, '')`,
    })
    .from(inventory)
    .leftJoin(stockItems, eq(inventory.stockItemId, stockItems.id))
    .leftJoin(stockGroups, eq(stockItems.stockGroupId, stockGroups.id))
    .innerJoin(locations, eq(inventory.locationId, locations.id))
    .where(where)
    .orderBy(asc(stockItems.code), asc(locations.name))
    .limit(filters.pageSize)
    .offset(offset);

  return {
    data,
    page: filters.page,
    pageSize: filters.pageSize,
    total,
    totalPages: Math.ceil(total / filters.pageSize),
  };
}

// Extracted from ./stockMovementStorage.ts
import { eq, and, or, isNull, sql } from "drizzle-orm";
import { db } from "../../db";
import * as schema from "@shared/schema";
import { getLocationById } from "./locationInventoryStorage";

export async function archiveStockGroupAtLocationPart1(
  companyId: number,
  locationId: number,
  stockGroupId: number | null
) {
  const location = await getLocationById(locationId);

  let stockGroupName = "Uncategorized";
  let uncategorizedGroupId: number | null = null;

  if (stockGroupId !== null) {
    const stockGroup = await db
      .select()
      .from(schema.stockGroups)
      .where(eq(schema.stockGroups.id, stockGroupId))
      .limit(1);
    if (!stockGroup.length) throw new Error("Stock group not found");
    stockGroupName = stockGroup[0].name;
  } else {
    const uncategorizedGroup = await db
      .select()
      .from(schema.stockGroups)
      .where(and(eq(schema.stockGroups.companyId, companyId), sql`UPPER(${schema.stockGroups.code}) = 'UNCATEGORIZED'`))
      .limit(1);
    if (uncategorizedGroup.length > 0) uncategorizedGroupId = uncategorizedGroup[0].id;
  }

  if (!location) throw new Error("Location not found");

  let stockItems;
  if (stockGroupId !== null) {
    stockItems = await db
      .select()
      .from(schema.stockItems)
      .where(
        and(
          eq(schema.stockItems.companyId, companyId),
          eq(schema.stockItems.stockGroupId, stockGroupId),
          isNull(schema.stockItems.deletedAt)
        )
      );
  } else {
    if (uncategorizedGroupId !== null) {
      stockItems = await db
        .select()
        .from(schema.stockItems)
        .where(
          and(
            eq(schema.stockItems.companyId, companyId),
            or(isNull(schema.stockItems.stockGroupId), eq(schema.stockItems.stockGroupId, uncategorizedGroupId)),
            isNull(schema.stockItems.deletedAt)
          )
        );
    } else {
      stockItems = await db
        .select()
        .from(schema.stockItems)
        .where(
          and(
            eq(schema.stockItems.companyId, companyId),
            isNull(schema.stockItems.stockGroupId),
            isNull(schema.stockItems.deletedAt)
          )
        );
    }
  }

  if (stockItems.length === 0) throw new Error("No stock items found in this stock group");

  const stockItemIds = stockItems.map((item) => item.id);
  const occurredAt = new Date().toISOString();
  return { location, stockGroupName, stockItems, stockItemIds, occurredAt };
}

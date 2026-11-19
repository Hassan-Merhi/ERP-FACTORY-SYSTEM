// Extracted from ./locationInventoryStorage.ts
import { eq, and, isNull, asc, sql } from "drizzle-orm";
import { db, pool, type DatabaseOrTransaction } from "../../db";
import * as schema from "@shared/schema";

export async function getLocationById(id: number): Promise<schema.Location | undefined> {
  const [location] = await db.select().from(schema.locations).where(eq(schema.locations.id, id));
  return location;
}

export async function createLocation(
  location: schema.InsertLocation & { code: string },
  // Phase 21 (B): the caller's transaction, so its create audit commits with the row.
  executor: DatabaseOrTransaction = db
): Promise<schema.Location> {
  const [created] = await executor.insert(schema.locations).values(location).returning();
  return created;
}

export const LOCATION_HOLDS_STOCK_MESSAGE =
  "This location still has stock. Move or remove all stock before deleting the location.";

export async function locationHoldsStock(locationId: number): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM inventory
        WHERE location_id = $1
          AND company_id = (SELECT company_id FROM locations WHERE id = $1)
          AND (ABS(COALESCE(quantity, 0)) > 0 OR ABS(COALESCE(total_value, 0)) > 0)
     ) AS holds`,
    [locationId]
  );
  return rows[0]?.holds === true;
}

export async function getLocationByCode(code: string, companyId: number): Promise<schema.Location | undefined> {
  const [location] = await db
    .select()
    .from(schema.locations)
    .where(
      and(
        eq(schema.locations.code, code),
        eq(schema.locations.companyId, companyId),
        isNull(schema.locations.deletedAt)
      )
    );
  return location;
}

export async function getCompanyInventory(companyId: number) {
  return await db
    .select({
      inventoryId: schema.inventory.id,
      locationId: schema.inventory.locationId,
      locationName: schema.locations.name,
      locationCode: schema.locations.code,
      stockItemId: schema.inventory.stockItemId,
      quantity: schema.inventory.quantity,
      averageRate: schema.inventory.averageRate,
      totalValue: schema.inventory.totalValue,
      lastUpdated: schema.inventory.lastUpdated,
      stockItemCode: schema.stockItems.code,
      stockItemName: schema.stockItems.name,
      stockItemUom: schema.stockItems.uom,
      stockGroupId: schema.stockItems.stockGroupId,
      stockGroupName: sql<string>`COALESCE(${schema.stockGroups.name}, '')`,
      stockGroupCode: sql<string>`COALESCE(${schema.stockGroups.code}, '')`,
      categoryId: schema.stockItems.categoryId,
      categoryName: schema.stockCategories.name,
    })
    .from(schema.inventory)
    .leftJoin(schema.stockItems, eq(schema.inventory.stockItemId, schema.stockItems.id))
    .leftJoin(schema.stockGroups, eq(schema.stockItems.stockGroupId, schema.stockGroups.id))
    .leftJoin(schema.stockCategories, eq(schema.stockItems.categoryId, schema.stockCategories.id))
    .innerJoin(schema.locations, eq(schema.inventory.locationId, schema.locations.id))
    .where(
      and(
        eq(schema.inventory.companyId, companyId),
        isNull(schema.locations.deletedAt),
        isNull(schema.stockItems.deletedAt)
      )
    )
    .orderBy(asc(schema.stockItems.code), asc(schema.locations.name));
}

export async function getLowStockItems(companyId: number, threshold: number = 10) {
  return await db
    .select({
      stockItemId: schema.inventory.stockItemId,
      quantity: schema.inventory.quantity,
      stockItemName: schema.stockItems.name,
      stockItemCode: schema.stockItems.code,
      locationId: schema.inventory.locationId,
      locationName: schema.locations.name,
    })
    .from(schema.inventory)
    .leftJoin(schema.stockItems, eq(schema.inventory.stockItemId, schema.stockItems.id))
    .leftJoin(schema.locations, eq(schema.inventory.locationId, schema.locations.id))
    .where(
      and(eq(schema.inventory.companyId, companyId), sql`CAST(${schema.inventory.quantity} AS numeric) < ${threshold}`)
    );
}

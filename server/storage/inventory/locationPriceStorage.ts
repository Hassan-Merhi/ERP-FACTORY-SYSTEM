import { eq, sql } from "drizzle-orm";
import { db } from "../../db";
import * as schema from "@shared/schema";

// ---------------------------------------------------------------------------
// Location Prices
// ---------------------------------------------------------------------------

export async function getAllLocationPrices(companyId: number): Promise<schema.StockItemLocationPrice[]> {
  return await db
    .select({
      id: schema.stockItemLocationPrices.id,
      stockItemId: schema.stockItemLocationPrices.stockItemId,
      locationId: schema.stockItemLocationPrices.locationId,
      sellingPrice: schema.stockItemLocationPrices.sellingPrice,
      createdAt: schema.stockItemLocationPrices.createdAt,
      updatedAt: schema.stockItemLocationPrices.updatedAt,
    })
    .from(schema.stockItemLocationPrices)
    .innerJoin(schema.locations, eq(schema.stockItemLocationPrices.locationId, schema.locations.id))
    .where(eq(schema.locations.companyId, companyId));
}

export async function getLocationPricesByStockItem(
  stockItemId: number,
  _companyId: number
): Promise<schema.StockItemLocationPrice[]> {
  return await db
    .select()
    .from(schema.stockItemLocationPrices)
    .where(eq(schema.stockItemLocationPrices.stockItemId, stockItemId));
}

export async function getStockItemLocationPrices(
  stockItemId: number,
  companyId: number
): Promise<schema.StockItemLocationPrice[]> {
  return getLocationPricesByStockItem(stockItemId, companyId);
}

export async function upsertLocationPrice(
  stockItemId: number,
  locationId: number,
  sellingPrice: string
): Promise<schema.StockItemLocationPrice> {
  const [result] = await db
    .insert(schema.stockItemLocationPrices)
    .values({ stockItemId, locationId, sellingPrice })
    .onConflictDoUpdate({
      target: [schema.stockItemLocationPrices.locationId, schema.stockItemLocationPrices.stockItemId],
      set: { sellingPrice, updatedAt: sql`now()` },
    })
    .returning();
  return result;
}

export async function deleteLocationPrice(priceId: number): Promise<void> {
  await db.delete(schema.stockItemLocationPrices).where(eq(schema.stockItemLocationPrices.id, priceId));
}

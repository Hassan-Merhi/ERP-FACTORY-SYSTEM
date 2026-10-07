/**
 * Ownership checks for ids that arrive in a request body.
 *
 * The company resource scope (server/middleware/companyResourceScope.ts)
 * classifies ids in the URL path only, so a route that reads a location or a
 * stock item id from the body must check it here. Row-level security covers
 * stock_items and inventory but not locations, and the database layer is a
 * backstop rather than the application's check.
 */
import { and, eq, inArray } from "drizzle-orm";
import { locations, stockItems } from "@shared/schema";
import { db } from "../../db";

/** Positive integer ids from untrusted input, de-duplicated; anything else is dropped. */
export function positiveIds(values: readonly unknown[]): number[] {
  const ids = new Set<number>();
  for (const value of values) {
    const id = Number(value);
    if (Number.isInteger(id) && id > 0) ids.add(id);
  }
  return [...ids];
}

/** The ids among `locationIds` that are locations of `companyId`. */
export async function ownLocationIds(companyId: number, locationIds: readonly unknown[]): Promise<Set<number>> {
  const ids = positiveIds(locationIds);
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.companyId, companyId), inArray(locations.id, ids)));
  return new Set(rows.map((row) => row.id));
}

/** The ids among `stockItemIds` that are stock items of `companyId`. */
export async function ownStockItemIds(companyId: number, stockItemIds: readonly unknown[]): Promise<Set<number>> {
  const ids = positiveIds(stockItemIds);
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: stockItems.id })
    .from(stockItems)
    .where(and(eq(stockItems.companyId, companyId), inArray(stockItems.id, ids)));
  return new Set(rows.map((row) => row.id));
}

/** True when every positive id in `stockItemIds` is a stock item of `companyId`. */
export async function allStockItemsOwned(companyId: number, stockItemIds: readonly unknown[]): Promise<boolean> {
  const ids = positiveIds(stockItemIds);
  const owned = await ownStockItemIds(companyId, ids);
  return ids.every((id) => owned.has(id));
}

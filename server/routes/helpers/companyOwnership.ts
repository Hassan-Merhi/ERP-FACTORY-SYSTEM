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
import { ledgerAccounts, locations, stockItems } from "@shared/schema";
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
  return locationIdsOfCompanies([companyId], locationIds);
}

/**
 * The ids among `locationIds` that are locations of any of `companyIds`.
 * Factory routes write under the factory company while the location picker
 * lists the session company's locations; both are the user's own.
 */
export async function locationIdsOfCompanies(
  companyIds: readonly (number | null | undefined)[],
  locationIds: readonly unknown[]
): Promise<Set<number>> {
  const ids = positiveIds(locationIds);
  const companies = positiveIds(companyIds);
  if (ids.length === 0 || companies.length === 0) return new Set();
  const rows = await db
    .select({ id: locations.id })
    .from(locations)
    .where(and(inArray(locations.companyId, companies), inArray(locations.id, ids)));
  return new Set(rows.map((row) => row.id));
}

/** True when `locationId` is a location of the factory company or the session company. */
export async function isFactorySessionLocation(
  session: { factoryCompanyId?: number | null; currentCompanyId?: number | null },
  locationId: unknown
): Promise<boolean> {
  const owned = await locationIdsOfCompanies([session.factoryCompanyId, session.currentCompanyId], [locationId]);
  return owned.has(Number(locationId));
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

/** True when every positive id in `ledgerAccountIds` is a ledger account of `companyId`. */
export async function allLedgerAccountsOwned(
  companyId: number,
  ledgerAccountIds: readonly unknown[]
): Promise<boolean> {
  const ids = positiveIds(ledgerAccountIds);
  if (ids.length === 0) return true;
  const rows = await db
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.companyId, companyId), inArray(ledgerAccounts.id, ids)));
  const owned = new Set(rows.map((row) => row.id));
  return ids.every((id) => owned.has(id));
}

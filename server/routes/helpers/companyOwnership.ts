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
import { customers, ledgerAccounts, locations, stockItems } from "@shared/schema";
import { db } from "../../db";

/**
 * A positive integer id written canonically (42 or "42"), else null. Routes
 * later read ids with parseInt or Number, which disagree on input such as
 * "42junk" or "1e2", so only the form both read the same way is accepted.
 */
function canonicalId(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    const id = Number(value);
    return Number.isSafeInteger(id) ? id : null;
  }
  return null;
}

/** An optional id the request left out: null, undefined, empty, or zero. */
function isAbsentId(value: unknown): boolean {
  return value == null || value === "" || value === 0 || value === "0";
}

/** Canonical positive integer ids from untrusted input, de-duplicated; anything else is dropped. */
export function positiveIds(values: readonly unknown[]): number[] {
  const ids = new Set<number>();
  for (const value of values) {
    const id = canonicalId(value);
    if (id !== null) ids.add(id);
  }
  return [...ids];
}

/**
 * The supplied ids, de-duplicated, or null when any supplied value is not a
 * canonical positive integer. Absent values (see isAbsentId) are skipped.
 */
export function strictIds(values: readonly unknown[]): number[] | null {
  const ids = new Set<number>();
  for (const value of values) {
    if (isAbsentId(value)) continue;
    const id = canonicalId(value);
    if (id === null) return null;
    ids.add(id);
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

/** True when every supplied id in `stockItemIds` is a canonical id of a stock item of `companyId`. */
export async function allStockItemsOwned(companyId: number, stockItemIds: readonly unknown[]): Promise<boolean> {
  const ids = strictIds(stockItemIds);
  if (ids === null) return false;
  const owned = await ownStockItemIds(companyId, ids);
  return ids.every((id) => owned.has(id));
}

/** True when every supplied id in `ledgerAccountIds` is a canonical id of a ledger account of `companyId`. */
export async function allLedgerAccountsOwned(
  companyId: number,
  ledgerAccountIds: readonly unknown[]
): Promise<boolean> {
  const ids = strictIds(ledgerAccountIds);
  if (ids === null) return false;
  if (ids.length === 0) return true;
  const rows = await db
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.companyId, companyId), inArray(ledgerAccounts.id, ids)));
  const owned = new Set(rows.map((row) => row.id));
  return ids.every((id) => owned.has(id));
}

/** True when `customerId` is absent or a canonical id of a customer of `companyId`. */
export async function isCompanyCustomerOrAbsent(companyId: number, customerId: unknown): Promise<boolean> {
  const ids = strictIds([customerId]);
  if (ids === null) return false;
  if (ids.length === 0) return true;
  const rows = await db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.companyId, companyId), inArray(customers.id, ids)));
  return rows.length === ids.length;
}

import { randomUUID } from "node:crypto";
import { eq, and, isNull, asc, sql } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { db, pool, type DbTransaction } from "../../db";
import { MoneyDecimal } from "../../lib/money";
import * as schema from "@shared/schema";
import { createDatabaseStockMovementAdapter } from "../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../services/inventory/stockMovementIntegrityService";
import { recordInventoryValuationOverride } from "../../services/inventory/recordInventoryValuationOverride";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export async function getAllLocations(companyId: number): Promise<schema.Location[]> {
  return await db
    .select()
    .from(schema.locations)
    .where(and(eq(schema.locations.companyId, companyId), isNull(schema.locations.deletedAt)))
    .orderBy(asc(schema.locations.name));
}

export async function getLocationById(id: number): Promise<schema.Location | undefined> {
  const [location] = await db.select().from(schema.locations).where(eq(schema.locations.id, id));
  return location;
}

export async function createLocation(location: schema.InsertLocation & { code: string }): Promise<schema.Location> {
  const [created] = await db.insert(schema.locations).values(location).returning();
  return created;
}

export const LOCATION_HOLDS_STOCK_MESSAGE =
  "This location still has stock. Move or remove all stock before deleting the location.";

/**
 * Wave 11: a location that holds stock (any quantity or value) cannot be
 * deactivated or deleted, before or after the perpetual-inventory cut-over:
 * its stock would drop out of the valuation readers while the sub-ledger (and,
 * after the cut-over, the ledger) still carries it.
 */
export class LocationHoldsStockError extends Error {
  readonly status = 409;
  constructor() {
    super(LOCATION_HOLDS_STOCK_MESSAGE);
    this.name = "LocationHoldsStockError";
  }
}

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

export async function updateLocation(id: number, updates: Partial<schema.InsertLocation>): Promise<schema.Location> {
  if (updates.active === false && (await locationHoldsStock(id))) throw new LocationHoldsStockError();
  const [updated] = await db.update(schema.locations).set(updates).where(eq(schema.locations.id, id)).returning();
  return updated;
}

export async function deleteLocation(id: number): Promise<void> {
  if (await locationHoldsStock(id)) throw new LocationHoldsStockError();
  await db.update(schema.locations).set({ deletedAt: new Date() }).where(eq(schema.locations.id, id));
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

// ---------------------------------------------------------------------------
// Location Inventory
// ---------------------------------------------------------------------------

export async function getLocationInventory(companyId: number, locationId: number, includeZero = false) {
  if (!includeZero) {
    // Use pool.query() directly — bypasses Drizzle result-processing layer.
    const qr = await pool.query(
      `SELECT
        inv.id                AS "inventoryId",
        inv.location_id       AS "locationId",
        inv.stock_item_id     AS "stockItemId",
        inv.quantity,
        inv.average_rate      AS "averageRate",
        inv.total_value       AS "totalValue",
        inv.last_updated      AS "lastUpdated",
        si.name               AS "stockItemName",
        si.code               AS "stockItemCode",
        si.uom                AS "stockItemUom",
        si.stock_group_id     AS "stockGroupId",
        COALESCE(sg.name, '') AS "stockGroupName",
        COALESCE(sg.code, '') AS "stockGroupCode",
        CASE WHEN si.deleted_at IS NOT NULL THEN false ELSE si.active END AS "stockItemActive",
        NULL::text            AS barcode,
        si.category_id        AS "categoryId",
        sc.name               AS "categoryName",
        COALESCE(lp.selling_price, si.selling_price) AS "lastSellingPrice"
      FROM inventory inv
      INNER JOIN locations loc
        ON loc.id = inv.location_id
      LEFT JOIN stock_items si
        ON si.id = inv.stock_item_id
      LEFT JOIN stock_groups sg
        ON sg.id = si.stock_group_id
      LEFT JOIN stock_categories sc
        ON sc.id = si.category_id
      LEFT JOIN stock_item_location_prices lp
        ON lp.stock_item_id = inv.stock_item_id
        AND lp.location_id  = $1
      WHERE inv.location_id  = $1
        AND loc.company_id   = $2
        AND si.id IS NOT NULL
        AND (
          si.deleted_at IS NULL
          OR COALESCE(inv.quantity::numeric, 0) <> 0
        )
      ORDER BY si.code ASC`,
      [locationId, companyId]
    );

    const result = qr.rows;
    logger.info(
      `[getLocationInventory] companyId=${companyId} locationId=${locationId} includeZero=false → ${result.length} rows`
    );
    return result;
  }

  // includeZero=true: start from stock_items so zero-stock items appear.
  const qr2 = await pool.query(
    `SELECT
      inv.id                AS "inventoryId",
      $1::int               AS "locationId",
      si.id                 AS "stockItemId",
      COALESCE(inv.quantity,     '0') AS quantity,
      COALESCE(inv.average_rate, '0') AS "averageRate",
      COALESCE(inv.total_value,  '0') AS "totalValue",
      inv.last_updated      AS "lastUpdated",
      si.name               AS "stockItemName",
      si.code               AS "stockItemCode",
      si.uom                AS "stockItemUom",
      si.stock_group_id     AS "stockGroupId",
      COALESCE(sg.name, '') AS "stockGroupName",
      COALESCE(sg.code, '') AS "stockGroupCode",
      CASE WHEN si.deleted_at IS NOT NULL THEN false ELSE si.active END AS "stockItemActive",
      NULL::text            AS barcode,
      si.category_id        AS "categoryId",
      sc.name               AS "categoryName",
      COALESCE(lp.selling_price, si.selling_price) AS "lastSellingPrice"
    FROM stock_items si
    LEFT JOIN inventory inv
      ON inv.stock_item_id = si.id
      AND inv.location_id  = $1
    LEFT JOIN stock_groups sg
      ON sg.id = si.stock_group_id
    LEFT JOIN stock_categories sc
      ON sc.id = si.category_id
    LEFT JOIN stock_item_location_prices lp
      ON lp.stock_item_id = si.id
      AND lp.location_id  = $1
    WHERE (
        (si.deleted_at IS NULL AND COALESCE(si.active, true) = true)
        OR
        (si.deleted_at IS NOT NULL AND COALESCE(NULLIF(CAST(inv.quantity AS TEXT), '')::numeric, 0) <> 0)
      )
      AND (
        si.company_id = $2
        OR EXISTS (
          SELECT 1 FROM inventory inv2
          WHERE inv2.stock_item_id = si.id
            AND inv2.location_id   = $1
        )
      )
    ORDER BY si.code ASC`,
    [locationId, companyId]
  );

  const result = qr2.rows;
  logger.info(
    `[getLocationInventory] companyId=${companyId} locationId=${locationId} includeZero=true → ${result.length} rows`
  );
  return result;
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

// ---------------------------------------------------------------------------
// Stock Queries
// ---------------------------------------------------------------------------

export async function getInventoryByStockItem(stockItemId: number, companyId: number) {
  return await db
    .select({
      locationId: schema.inventory.locationId,
      quantity: schema.inventory.quantity,
      averageRate: schema.inventory.averageRate,
      totalValue: schema.inventory.totalValue,
      lastUpdated: schema.inventory.lastUpdated,
      locationName: schema.locations.name,
    })
    .from(schema.inventory)
    .leftJoin(schema.locations, eq(schema.inventory.locationId, schema.locations.id))
    .where(and(eq(schema.inventory.stockItemId, stockItemId), eq(schema.inventory.companyId, companyId)));
}

export async function updateInventory(
  locationId: number,
  stockItemId: number,
  quantity: string,
  averageRate: string,
  totalValue: string,
  companyId?: number
): Promise<void> {
  let resolvedCompanyId = companyId;
  if (!resolvedCompanyId) {
    const [loc] = await db
      .select({ companyId: schema.locations.companyId })
      .from(schema.locations)
      .where(eq(schema.locations.id, locationId));
    resolvedCompanyId = loc?.companyId ?? 0;
  }

  await db.transaction((tx) =>
    updateInventoryTx(tx, locationId, stockItemId, quantity, averageRate, totalValue, resolvedCompanyId)
  );
}

/**
 * Sets a location's stock row, in the caller's transaction, and returns the
 * signed change of its stored total_value (wave 11: what a linked inventory
 * movement journal posts).
 */
export async function updateInventoryTx(
  tx: DbTransaction,
  locationId: number,
  stockItemId: number,
  quantity: string,
  averageRate: string,
  totalValue: string,
  resolvedCompanyId: number
): Promise<{ valueDelta: string; previousQuantity: string; previousTotalValue: string }> {
  const operationId = randomUUID();
  {
    const [existing] = await tx
      .select({
        id: schema.inventory.id,
        quantity: schema.inventory.quantity,
        averageRate: schema.inventory.averageRate,
        totalValue: schema.inventory.totalValue,
      })
      .from(schema.inventory)
      .where(and(eq(schema.inventory.locationId, locationId), eq(schema.inventory.stockItemId, stockItemId)))
      .limit(1)
      .for("update");
    const previousQuantity = existing ? Number.parseFloat(existing.quantity || "0") : 0;
    const nextQuantity = Number.parseFloat(quantity || "0");
    const delta = nextQuantity - previousQuantity;

    await tx
      .insert(schema.inventory)
      .values({ locationId, stockItemId, quantity, averageRate, totalValue, companyId: resolvedCompanyId })
      .onConflictDoUpdate({
        target: [schema.inventory.locationId, schema.inventory.stockItemId],
        set: { quantity, averageRate, totalValue, lastUpdated: sql`now()` },
      });

    // The journal below can only record the quantity change; a direct set also
    // overwrites the valuation, so record the exact before and after state.
    await recordInventoryValuationOverride(tx, {
      companyId: resolvedCompanyId,
      locationId,
      stockItemId,
      inventoryId: existing?.id ?? null,
      sourceType: "location-inventory-update",
      before: {
        quantity: existing?.quantity ?? "0",
        averageRate: existing?.averageRate ?? "0",
        totalValue: existing?.totalValue ?? "0",
      },
      after: { quantity, averageRate, totalValue },
    });

    if (Number.isFinite(delta) && delta !== 0) {
      await postStockMovementTx(
        tx,
        {
          companyId: resolvedCompanyId,
          stockItemId,
          kind: "adjustment",
          quantity: String(Math.abs(delta)),
          unitCost: averageRate,
          fromLocationId: delta < 0 ? locationId : undefined,
          toLocationId: delta > 0 ? locationId : undefined,
          occurredAt: new Date().toISOString(),
          source: {
            sourceType: "location_inventory_update",
            sourceId: operationId,
            idempotencyKey: `location-inventory-update:${resolvedCompanyId}:${operationId}`,
          },
          allowNegativeStock: true,
        },
        canonicalStockMovementAdapter
      );
    }
    const previousTotalValue = existing?.totalValue ?? "0";
    return {
      valueDelta: new MoneyDecimal(totalValue || "0").toDecimalPlaces(2).minus(previousTotalValue).toFixed(2),
      previousQuantity: existing?.quantity ?? "0",
      previousTotalValue,
    };
  }
}

export async function getTotalInventoryValue(companyId: number): Promise<number> {
  const [result] = await db
    .select({ total: sql<string>`COALESCE(SUM(CAST(${schema.inventory.totalValue} AS numeric)), 0)` })
    .from(schema.inventory)
    .where(eq(schema.inventory.companyId, companyId));
  return result ? parseFloat(result.total) : 0;
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

export async function getInventorySummary(companyId: number) {
  return await db
    .select({
      stockItemId: schema.inventory.stockItemId,
      stockItemName: schema.stockItems.name,
      stockItemCode: schema.stockItems.code,
      totalQuantity: sql<string>`SUM(CAST(${schema.inventory.quantity} AS numeric))`,
      totalValue: sql<string>`SUM(CAST(${schema.inventory.totalValue} AS numeric))`,
      averageRate: sql<string>`CASE WHEN SUM(CAST(${schema.inventory.quantity} AS numeric)) > 0 THEN SUM(CAST(${schema.inventory.totalValue} AS numeric)) / SUM(CAST(${schema.inventory.quantity} AS numeric)) ELSE 0 END`,
    })
    .from(schema.inventory)
    .leftJoin(schema.stockItems, eq(schema.inventory.stockItemId, schema.stockItems.id))
    .where(eq(schema.inventory.companyId, companyId))
    .groupBy(schema.inventory.stockItemId, schema.stockItems.name, schema.stockItems.code);
}

export async function getStockItemsWithInventory(companyId: number, locationId?: number) {
  const conditions = [eq(schema.inventory.companyId, companyId)];
  if (locationId) conditions.push(eq(schema.inventory.locationId, locationId));
  return await db
    .select({
      stockItemId: schema.inventory.stockItemId,
      stockItemName: schema.stockItems.name,
      stockItemCode: schema.stockItems.code,
      stockItemUnit: schema.stockItems.uom,
      barcode: sql<string | null>`NULL::text`,
      quantity: schema.inventory.quantity,
      averageRate: schema.inventory.averageRate,
      totalValue: schema.inventory.totalValue,
      locationId: schema.inventory.locationId,
      locationName: schema.locations.name,
      sellingPrice: schema.stockItemLocationPrices.sellingPrice,
    })
    .from(schema.inventory)
    .leftJoin(schema.stockItems, eq(schema.inventory.stockItemId, schema.stockItems.id))
    .leftJoin(schema.locations, eq(schema.inventory.locationId, schema.locations.id))
    .leftJoin(
      schema.stockItemLocationPrices,
      and(
        eq(schema.stockItemLocationPrices.stockItemId, schema.inventory.stockItemId),
        eq(schema.stockItemLocationPrices.locationId, schema.inventory.locationId)
      )
    )
    .where(and(...conditions, isNull(schema.stockItems.deletedAt)));
}

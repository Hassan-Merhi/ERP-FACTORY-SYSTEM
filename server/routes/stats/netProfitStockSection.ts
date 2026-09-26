import { and, eq, inArray, isNull } from "drizzle-orm";

import { inventory, locations } from "@shared/schema";
import { db } from "../../db";
import { inventoryMoney, multiplyInventoryValues, toInventoryDecimal } from "../../lib/inventoryMath";
import { calculateHistoricalLocationInventory } from "../_helpers";

/**
 * ERP Stock In Hand — the value of location inventory at weighted-average cost.
 *
 * With no `toDate` this reads the live inventory table. With one it replays each
 * active location's history through calculateHistoricalLocationInventory, which
 * is why the two branches look different: only the historical path can produce
 * quantities that no longer exist today.
 */
export async function computeStockInHand(companyId: number, toDate: string | null | undefined): Promise<number> {
  const activeLocationsData = await db
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.companyId, companyId), eq(locations.active, true), isNull(locations.deletedAt)))
    .execute();
  const activeLocationIds = activeLocationsData.map((location) => location.id);

  let stockOnFloor = toInventoryDecimal(0);
  if (activeLocationIds.length > 0) {
    if (toDate) {
      const allHistorical = await Promise.all(
        activeLocationIds.map((locationId) => calculateHistoricalLocationInventory(locationId, companyId, toDate))
      );
      for (const items of allHistorical) {
        for (const item of items) {
          const quantity = toInventoryDecimal(item.quantity);
          stockOnFloor = stockOnFloor.plus(multiplyInventoryValues(quantity, item.averageRate));
        }
      }
    } else {
      const inventoryData = await db
        .select({ quantity: inventory.quantity, averageRate: inventory.averageRate })
        .from(inventory)
        .where(inArray(inventory.locationId, activeLocationIds))
        .execute();
      for (const item of inventoryData) {
        stockOnFloor = stockOnFloor.plus(multiplyInventoryValues(item.quantity, item.averageRate));
      }
    }
  }

  return Number(inventoryMoney(stockOnFloor));
}

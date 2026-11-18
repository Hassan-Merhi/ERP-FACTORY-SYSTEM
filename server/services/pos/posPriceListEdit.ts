/** A POS cashier may change only selling prices at an assigned company location. */
import type { Request } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { locationPriceGroups, stockItems, userLocations } from "@shared/schema";
import { db } from "../../db";
import { ownLocationIds } from "../../routes/helpers/companyOwnership";
import { logAudit } from "../../routes/_helpers";
import {
  finishStockItemEditCaptureTx,
  stockItemEditRecorder,
  upsertLocationPriceTx,
} from "../inventory/stockItemEditCapture";
import { getActiveCompanyPermissionContext } from "../security/activeCompanyPermissionContext";

export class PosPriceWriteError extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function positiveId(input: unknown): number | null {
  if (typeof input === "string" && !/^[1-9]\d*$/.test(input)) return null;
  if (typeof input !== "number" && typeof input !== "string") return null;
  const id = Number(input);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function validPrice(input: unknown): string | null {
  if (typeof input !== "number" && typeof input !== "string") return null;
  const price = String(input).trim();
  // stock_item_location_prices has numeric(15, 2); reject rounded/invalid inputs.
  return /^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/.test(price) ? price : null;
}

/**
 * Re-read the live company role, validate both company-owned resources, and
 * save a linked master price with all its followers atomically. A POS user's
 * input location must be assigned; the server (not the browser) resolves any
 * price-group master, so this cannot be turned into arbitrary-location writes.
 */
export async function saveLocationPrice(
  req: Request,
  rawItemId: unknown,
  rawLocationId: unknown,
  rawPrice: unknown
): Promise<{ cascaded: boolean }> {
  const context = await getActiveCompanyPermissionContext(req);
  const stockItemId = positiveId(rawItemId);
  const locationId = positiveId(rawLocationId);
  const sellingPrice = validPrice(rawPrice);
  if (!stockItemId || !locationId || sellingPrice === null) {
    throw new PosPriceWriteError(
      400,
      "POS_PRICE_INPUT_INVALID",
      "Valid item, location and non-negative price (up to two decimals) are required."
    );
  }
  if (
    context.role === "View Only" ||
    context.role === "Create Only" ||
    (context.role === "POS" && context.posViewOnly)
  ) {
    throw new PosPriceWriteError(403, "POS_PRICE_WRITE_DENIED", "This account cannot change prices.");
  }

  const [item] = await db
    .select({ id: stockItems.id, code: stockItems.code })
    .from(stockItems)
    .where(and(eq(stockItems.id, stockItemId), eq(stockItems.companyId, context.companyId), isNull(stockItems.deletedAt)))
    .limit(1);
  if (!item) throw new PosPriceWriteError(404, "POS_PRICE_ITEM_NOT_FOUND", "Stock item not found.");

  const ownedLocation = await ownLocationIds(context.companyId, [locationId]);
  if (!ownedLocation.has(locationId)) {
    throw new PosPriceWriteError(403, "POS_PRICE_LOCATION_DENIED", "Location does not belong to the active company.");
  }
  if (context.role === "POS") {
    const [assigned] = await db
      .select({ id: userLocations.id })
      .from(userLocations)
      .where(
        and(
          eq(userLocations.userId, context.userId),
          eq(userLocations.companyId, context.companyId),
          eq(userLocations.locationId, locationId)
        )
      )
      .limit(1);
    if (!assigned) {
      throw new PosPriceWriteError(403, "POS_PRICE_LOCATION_DENIED", "Price editing is restricted to assigned locations.");
    }
  }

  // Followers display the master's price: editing the follower must update
  // that source price, otherwise the new value would never be visible.
  const [group] = await db
    .select({ masterLocationId: locationPriceGroups.masterLocationId })
    .from(locationPriceGroups)
    .where(
      and(
        eq(locationPriceGroups.companyId, context.companyId),
        eq(locationPriceGroups.followerLocationId, locationId)
      )
    )
    .limit(1);
  const masterId = group?.masterLocationId ?? locationId;
  const followers = await db
    .select({ locationId: locationPriceGroups.followerLocationId })
    .from(locationPriceGroups)
    .where(
      and(
        eq(locationPriceGroups.companyId, context.companyId),
        eq(locationPriceGroups.masterLocationId, masterId)
      )
    );
  const targetIds = [...new Set([masterId, ...followers.map((f) => f.locationId)])];
  const ownedTargets = await ownLocationIds(context.companyId, targetIds);
  if (targetIds.some((id) => !ownedTargets.has(id))) {
    throw new PosPriceWriteError(403, "POS_PRICE_GROUP_DENIED", "A linked price location is outside this company.");
  }

  const recorder = stockItemEditRecorder("POST /api/stock-items/:id/location-prices");
  await db.transaction(async (tx) => {
    for (const targetLocationId of targetIds) {
      await upsertLocationPriceTx(tx, recorder, { stockItemId, locationId: targetLocationId, sellingPrice });
    }
    await finishStockItemEditCaptureTx(tx, req, recorder);
    if (context.role === "POS") {
      await logAudit(
        {
          userId: context.userId,
          username: req.session.username || "unknown",
          companyId: context.companyId,
          action: "update",
          tableName: "stock_item_location_prices",
          recordId: stockItemId,
          recordIdentifier: item.code,
          changes: { sellingPrice: { new: sellingPrice }, locationId: { new: locationId } },
        },
        tx
      );
    }
  });
  return { cascaded: targetIds.length > 1 || masterId !== locationId };
}

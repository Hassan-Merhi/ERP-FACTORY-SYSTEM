import { eq, and, or, isNull, desc, sql, inArray } from "drizzle-orm";
import { db } from "../../db";
import * as schema from "@shared/schema";
import { MoneyDecimal, sumMoney, toMoney } from "../../lib/money";
import { createDatabaseStockMovementAdapter } from "../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../services/inventory/stockMovementIntegrityService";
import { getLocationById } from "./locationInventoryStorage";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

// ---------------------------------------------------------------------------
// Stock Group Location Archives
// ---------------------------------------------------------------------------

export async function archiveStockGroupAtLocation(
  companyId: number,
  locationId: number,
  stockGroupId: number | null,
  archivedBy: string,
  notes?: string
): Promise<schema.StockGroupLocationArchive> {
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
  const inventoryRecords = await db
    .select({
      stockItemId: schema.inventory.stockItemId,
      quantity: schema.inventory.quantity,
      averageRate: schema.inventory.averageRate,
      totalValue: schema.inventory.totalValue,
    })
    .from(schema.inventory)
    .where(
      and(
        eq(schema.inventory.locationId, locationId),
        eq(schema.inventory.companyId, companyId),
        inArray(schema.inventory.stockItemId, stockItemIds),
        sql`${schema.inventory.quantity}::numeric > 0`
      )
    );

  if (inventoryRecords.length === 0) throw new Error("No inventory found for this stock group at this location");

  const totalQuantity = sumMoney(inventoryRecords.map((inv) => inv.quantity));
  const totalValue = sumMoney(inventoryRecords.map((inv) => inv.totalValue));

  const [archive] = await db
    .insert(schema.stockGroupLocationArchives)
    .values({
      companyId,
      locationId,
      stockGroupId,
      locationName: location.name,
      stockGroupName,
      totalQuantity: totalQuantity.toFixed(),
      totalValue: totalValue.toFixed(),
      itemCount: inventoryRecords.length,
      archivedBy,
      notes,
    })
    .returning();

  const archiveItems = inventoryRecords.map((inv) => {
    const item = stockItems.find((s) => s.id === inv.stockItemId);
    return {
      archiveId: archive.id,
      stockItemId: inv.stockItemId,
      stockItemCode: item?.code || "",
      stockItemName: item?.name || "",
      quantity: inv.quantity,
      averageRate: inv.averageRate,
      totalValue: inv.totalValue,
    };
  });
  await db.insert(schema.stockGroupLocationArchiveItems).values(archiveItems);

  const occurredAt = new Date().toISOString();
  await db.transaction(async (tx) => {
    for (const inv of inventoryRecords) {
      await tx
        .update(schema.inventory)
        .set({ quantity: "0", totalValue: "0", lastUpdated: sql`now()` })
        .where(
          and(
            eq(schema.inventory.locationId, locationId),
            eq(schema.inventory.companyId, companyId),
            eq(schema.inventory.stockItemId, inv.stockItemId)
          )
        );

      await postStockMovementTx(
        tx,
        {
          companyId,
          stockItemId: inv.stockItemId,
          kind: "adjustment",
          quantity: inv.quantity,
          unitCost: inv.averageRate,
          fromLocationId: locationId,
          occurredAt,
          source: {
            sourceType: "stock_group_location_archive",
            sourceId: String(archive.id),
            idempotencyKey: `stock-group-archive:${companyId}:${archive.id}:${inv.stockItemId}`,
          },
          actor: { username: archivedBy, reason: notes || "Stock group location archive" },
          allowNegativeStock: true,
        },
        canonicalStockMovementAdapter
      );
    }
  });

  return archive;
}

export async function getStockGroupLocationArchives(companyId: number): Promise<schema.StockGroupLocationArchive[]> {
  return await db
    .select()
    .from(schema.stockGroupLocationArchives)
    .where(
      and(
        eq(schema.stockGroupLocationArchives.companyId, companyId),
        isNull(schema.stockGroupLocationArchives.deletedAt),
        isNull(schema.stockGroupLocationArchives.restoredAt)
      )
    )
    .orderBy(desc(schema.stockGroupLocationArchives.archivedAt));
}

export async function getStockGroupLocationArchiveById(
  id: number,
  companyId: number
): Promise<schema.StockGroupLocationArchive | undefined> {
  const [archive] = await db
    .select()
    .from(schema.stockGroupLocationArchives)
    .where(
      and(eq(schema.stockGroupLocationArchives.id, id), eq(schema.stockGroupLocationArchives.companyId, companyId))
    );
  return archive;
}

export async function getStockGroupLocationArchiveItems(
  archiveId: number
): Promise<schema.StockGroupLocationArchiveItem[]> {
  return await db
    .select()
    .from(schema.stockGroupLocationArchiveItems)
    .where(eq(schema.stockGroupLocationArchiveItems.archiveId, archiveId));
}

export async function restoreStockGroupLocationArchive(
  archiveId: number,
  companyId: number
): Promise<schema.StockGroupLocationArchive> {
  const archive = await getStockGroupLocationArchiveById(archiveId, companyId);
  if (!archive) throw new Error("Archive not found");
  if (archive.restoredAt) throw new Error("Archive has already been restored");
  if (archive.deletedAt) throw new Error("Archive has been deleted");

  const archiveItems = await getStockGroupLocationArchiveItems(archiveId);
  const occurredAt = new Date().toISOString();

  return db.transaction(async (tx) => {
    for (const item of archiveItems) {
      const [existing] = await tx
        .select()
        .from(schema.inventory)
        .where(
          and(
            eq(schema.inventory.stockItemId, item.stockItemId),
            eq(schema.inventory.locationId, archive.locationId),
            eq(schema.inventory.companyId, companyId)
          )
        );

      if (existing) {
        // Exact sums: restoring an archive adds its quantity and value back to
        // the row without float residue in the stored columns.
        const newQty = toMoney(existing.quantity).plus(toMoney(item.quantity));
        const newValue = toMoney(existing.totalValue).plus(toMoney(item.totalValue));
        const newRate = newQty.gt(0) ? newValue.div(newQty) : new MoneyDecimal(0);

        await tx
          .update(schema.inventory)
          .set({
            quantity: newQty.toFixed(),
            averageRate: newRate.toFixed(2),
            totalValue: newValue.toFixed(2),
            lastUpdated: sql`now()`,
          })
          .where(eq(schema.inventory.id, existing.id));
      } else {
        await tx.insert(schema.inventory).values({
          companyId,
          locationId: archive.locationId,
          stockItemId: item.stockItemId,
          quantity: item.quantity,
          averageRate: item.averageRate,
          totalValue: item.totalValue,
        });
      }

      await postStockMovementTx(
        tx,
        {
          companyId,
          stockItemId: item.stockItemId,
          kind: "adjustment",
          quantity: item.quantity,
          unitCost: item.averageRate,
          toLocationId: archive.locationId,
          occurredAt,
          source: {
            sourceType: "stock_group_location_archive_restore",
            sourceId: String(archiveId),
            idempotencyKey: `stock-group-archive-restore:${companyId}:${archiveId}:${item.stockItemId}`,
          },
        },
        canonicalStockMovementAdapter
      );
    }

    const [updated] = await tx
      .update(schema.stockGroupLocationArchives)
      .set({ restoredAt: sql`now()` })
      .where(eq(schema.stockGroupLocationArchives.id, archiveId))
      .returning();
    return updated;
  });
}

export async function deleteStockGroupLocationArchive(archiveId: number, companyId: number): Promise<void> {
  const archive = await getStockGroupLocationArchiveById(archiveId, companyId);
  if (!archive) throw new Error("Archive not found");
  await db
    .update(schema.stockGroupLocationArchives)
    .set({ deletedAt: sql`now()` })
    .where(eq(schema.stockGroupLocationArchives.id, archiveId));
}

export async function permanentlyDeleteStockGroupLocationArchive(archiveId: number, companyId: number): Promise<void> {
  const archive = await getStockGroupLocationArchiveById(archiveId, companyId);
  if (!archive) throw new Error("Archive not found");
  await db
    .delete(schema.stockGroupLocationArchiveItems)
    .where(eq(schema.stockGroupLocationArchiveItems.archiveId, archiveId));
  await db.delete(schema.stockGroupLocationArchives).where(eq(schema.stockGroupLocationArchives.id, archiveId));
}

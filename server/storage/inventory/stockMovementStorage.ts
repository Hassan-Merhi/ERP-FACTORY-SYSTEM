import { eq, and, or, isNull, desc, sql, inArray } from "drizzle-orm";
import { db } from "../../db";
import * as schema from "@shared/schema";
import { createDatabaseStockMovementAdapter } from "../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../services/inventory/stockMovementIntegrityService";
import { getLocationById } from "./locationInventoryStorage";
import { MoneyDecimal, toMoney } from "../../lib/money";
import {
  postInventoryMovementJournalTx,
  type InventoryMovementLine,
} from "../../services/accounting/perpetualInventory/inventoryMovementJournal";

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
  const occurredAt = new Date().toISOString();
  // Wave 11: header, items, the stock change and its journal are one
  // transaction, so an archive can never exist without its stock having moved
  // (or the other way round).
  return db.transaction(async (tx) => {
    const inventoryRecords = await tx
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
      )
      .orderBy(schema.inventory.stockItemId)
      .for("update");

    if (inventoryRecords.length === 0) throw new Error("No inventory found for this stock group at this location");

    let totalQuantity = new MoneyDecimal(0);
    let totalValue = new MoneyDecimal(0);
    for (const inv of inventoryRecords) {
      totalQuantity = totalQuantity.plus(toMoney(inv.quantity));
      totalValue = totalValue.plus(toMoney(inv.totalValue));
    }

    const [archive] = await tx
      .insert(schema.stockGroupLocationArchives)
      .values({
        companyId,
        locationId,
        stockGroupId,
        locationName: location.name,
        stockGroupName,
        totalQuantity: totalQuantity.toString(),
        totalValue: totalValue.toFixed(2),
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
    await tx.insert(schema.stockGroupLocationArchiveItems).values(archiveItems);

    const lines: InventoryMovementLine[] = [];
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
      lines.push({
        stockItemId: inv.stockItemId,
        locationId,
        valueDelta: toMoney(inv.totalValue).negated().toFixed(2),
        quantityDelta: toMoney(inv.quantity).negated().toFixed(3),
      });

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

    // Wave 11: under perpetual inventory the archived value leaves the ledger too.
    await postInventoryMovementJournalTx(tx, {
      companyId,
      sourceType: "stock-archive",
      sourceId: archive.id,
      date: occurredAt.slice(0, 10),
      reference: `${stockGroupName} @ ${location.name}`,
      lines,
      offsetAccountCode: "INVENTORY_ADJUSTMENT",
      narration: "Stock group archived",
      actor: { userId: archivedBy, username: archivedBy },
      locationId,
    });

    return archive;
  });
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

  const occurredAt = new Date().toISOString();

  return db.transaction(async (tx) => {
    // The archive row is locked, so two restores cannot both add the stock back.
    const [locked] = await tx
      .select()
      .from(schema.stockGroupLocationArchives)
      .where(
        and(
          eq(schema.stockGroupLocationArchives.id, archiveId),
          eq(schema.stockGroupLocationArchives.companyId, companyId)
        )
      )
      .for("update");
    if (!locked || locked.restoredAt) throw new Error("Archive has already been restored");
    const archiveItems = await tx
      .select()
      .from(schema.stockGroupLocationArchiveItems)
      .where(eq(schema.stockGroupLocationArchiveItems.archiveId, archiveId));
    const lines: InventoryMovementLine[] = [];
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
        )
        .for("update");

      if (existing) {
        const existingValue = MoneyDecimal.max(toMoney(existing.totalValue), 0);
        const newQty = toMoney(existing.quantity).plus(toMoney(item.quantity));
        // A short row holds no value (owner decision 1).
        const newValue = newQty.gt(0) ? existingValue.plus(toMoney(item.totalValue)) : new MoneyDecimal(0);
        const newRate = newQty.gt(0) ? newValue.dividedBy(newQty) : toMoney(existing.averageRate);

        await tx
          .update(schema.inventory)
          .set({
            quantity: newQty.toFixed(3),
            averageRate: newRate.toFixed(7),
            totalValue: newValue.toFixed(2),
            lastUpdated: sql`now()`,
          })
          .where(eq(schema.inventory.id, existing.id));
        lines.push({
          stockItemId: item.stockItemId,
          locationId: archive.locationId,
          valueDelta: newValue.minus(toMoney(existing.totalValue)).toFixed(2),
          quantityDelta: toMoney(item.quantity).toFixed(3),
        });
      } else {
        await tx.insert(schema.inventory).values({
          companyId,
          locationId: archive.locationId,
          stockItemId: item.stockItemId,
          quantity: item.quantity,
          averageRate: item.averageRate,
          totalValue: item.totalValue,
        });
        lines.push({
          stockItemId: item.stockItemId,
          locationId: archive.locationId,
          valueDelta: item.totalValue,
          quantityDelta: item.quantity,
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

    // Wave 11: under perpetual inventory the restored value comes back into the ledger.
    await postInventoryMovementJournalTx(tx, {
      companyId,
      sourceType: "stock-archive-restore",
      sourceId: archiveId,
      date: occurredAt.slice(0, 10),
      reference: `${archive.stockGroupName} @ ${archive.locationName}`,
      lines,
      offsetAccountCode: "INVENTORY_ADJUSTMENT",
      narration: "Stock group archive restored",
      locationId: archive.locationId,
    });

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

// Extracted from ./stockMovementStorage.ts
import { eq, and, isNull, desc, sql } from "drizzle-orm";
import { db } from "../../db";
import * as schema from "@shared/schema";

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

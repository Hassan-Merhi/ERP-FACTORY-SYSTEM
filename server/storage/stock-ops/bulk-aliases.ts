import { eq, and, isNull, inArray } from "drizzle-orm";
import { db, type DatabaseOrTransaction } from "../../db";
import * as schema from "@shared/schema";

export async function bulkGetStockItemsByIds(ids: number[], companyId: number): Promise<schema.StockItem[]> {
  if (ids.length === 0) return [];
  return await db
    .select()
    .from(schema.stockItems)
    .where(
      and(
        inArray(schema.stockItems.id, ids),
        eq(schema.stockItems.companyId, companyId),
        isNull(schema.stockItems.deletedAt)
      )
    );
}

export async function bulkDeleteStockItems(ids: number[], executor: DatabaseOrTransaction = db): Promise<void> {
  if (ids.length === 0) return;
  await executor.update(schema.stockItems).set({ deletedAt: new Date() }).where(inArray(schema.stockItems.id, ids));
}

// ---------------------------------------------------------------------------
// Stock Item Code Aliases
// ---------------------------------------------------------------------------

export async function getAllCompanyCodeAliases(companyId: number): Promise<schema.StockItemCodeAlias[]> {
  return await db
    .select()
    .from(schema.stockItemCodeAliases)
    .where(eq(schema.stockItemCodeAliases.companyId, companyId));
}

export async function createStockItemCodeAlias(
  data: schema.InsertStockItemCodeAlias
): Promise<schema.StockItemCodeAlias> {
  const [alias] = await db.insert(schema.stockItemCodeAliases).values(data).returning();
  return alias;
}

export async function deleteStockItemCodeAlias(aliasId: number): Promise<void> {
  await db.delete(schema.stockItemCodeAliases).where(eq(schema.stockItemCodeAliases.id, aliasId));
}

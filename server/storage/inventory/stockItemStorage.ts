import { eq, and, or, isNull, asc } from "drizzle-orm";
import { db } from "../../db";
import * as schema from "@shared/schema";
import { punctuationInsensitiveSearch } from "../../lib/searchNormalization";

// ---------------------------------------------------------------------------
// Stock Items
// ---------------------------------------------------------------------------

export async function getAllStockItems(
  companyId: number,
  includeDeleted: boolean = false
): Promise<schema.StockItem[]> {
  const conditions = [eq(schema.stockItems.companyId, companyId)];
  if (!includeDeleted) conditions.push(isNull(schema.stockItems.deletedAt));
  return await db
    .select()
    .from(schema.stockItems)
    .where(and(...conditions))
    .orderBy(asc(schema.stockItems.name));
}

export async function getStockItemById(id: number): Promise<schema.StockItem | undefined> {
  const [item] = await db.select().from(schema.stockItems).where(eq(schema.stockItems.id, id));
  return item;
}

export async function getStockItemByCode(code: string, companyId: number): Promise<schema.StockItem | undefined> {
  const [item] = await db
    .select()
    .from(schema.stockItems)
    .where(
      and(
        eq(schema.stockItems.code, code),
        eq(schema.stockItems.companyId, companyId),
        isNull(schema.stockItems.deletedAt)
      )
    );
  return item;
}

export async function getStockItemByCodeOrAlias(
  codeOrAlias: string,
  companyId: number
): Promise<schema.StockItem | undefined> {
  const [directMatch] = await db
    .select()
    .from(schema.stockItems)
    .where(
      and(
        eq(schema.stockItems.code, codeOrAlias),
        eq(schema.stockItems.companyId, companyId),
        isNull(schema.stockItems.deletedAt)
      )
    )
    .limit(1);
  if (directMatch) return directMatch;

  const [aliasMatch] = await db
    .select({ stockItem: schema.stockItems })
    .from(schema.stockItemCodeAliases)
    .innerJoin(schema.stockItems, eq(schema.stockItemCodeAliases.stockItemId, schema.stockItems.id))
    .where(
      and(
        eq(schema.stockItemCodeAliases.aliasCode, codeOrAlias),
        eq(schema.stockItems.companyId, companyId),
        isNull(schema.stockItems.deletedAt)
      )
    )
    .limit(1);
  return aliasMatch?.stockItem;
}

export async function getStockItemByBarcode(barcode: string, companyId: number): Promise<schema.StockItem | undefined> {
  // Barcodes are persisted in stock_item_code_aliases by the barcode import flow.
  return getStockItemByCodeOrAlias(barcode, companyId);
}

export async function createStockItem(item: schema.InsertStockItem): Promise<schema.StockItem> {
  const [created] = await db.insert(schema.stockItems).values(item).returning();
  return created;
}

export async function updateStockItem(id: number, updates: Partial<schema.InsertStockItem>): Promise<schema.StockItem> {
  const [updated] = await db.update(schema.stockItems).set(updates).where(eq(schema.stockItems.id, id)).returning();
  return updated;
}

export async function deleteStockItem(id: number): Promise<void> {
  await db.update(schema.stockItems).set({ deletedAt: new Date() }).where(eq(schema.stockItems.id, id));
}

export async function searchStockItems(
  companyId: number,
  query: string,
  limit: number = 20
): Promise<schema.StockItem[]> {
  return await db
    .select()
    .from(schema.stockItems)
    .where(
      and(
        eq(schema.stockItems.companyId, companyId),
        isNull(schema.stockItems.deletedAt),
        or(
          punctuationInsensitiveSearch(schema.stockItems.name, query),
          punctuationInsensitiveSearch(schema.stockItems.code, query)
        )
      )
    )
    .orderBy(asc(schema.stockItems.name))
    .limit(limit);
}

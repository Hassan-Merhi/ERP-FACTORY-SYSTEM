import { eq, and, asc } from "drizzle-orm";
import { db } from "../../db";
import * as schema from "@shared/schema";

// ---------------------------------------------------------------------------
// Stock Groups
// ---------------------------------------------------------------------------

export async function getAllStockGroups(companyId: number): Promise<schema.StockGroup[]> {
  return await db
    .select()
    .from(schema.stockGroups)
    .where(eq(schema.stockGroups.companyId, companyId))
    .orderBy(asc(schema.stockGroups.name));
}

export async function getStockGroupById(id: number): Promise<schema.StockGroup | undefined> {
  const [group] = await db.select().from(schema.stockGroups).where(eq(schema.stockGroups.id, id));
  return group;
}

export async function createStockGroup(group: schema.InsertStockGroup): Promise<schema.StockGroup> {
  const [created] = await db.insert(schema.stockGroups).values(group).returning();
  return created;
}

export async function updateStockGroup(
  id: number,
  updates: Partial<schema.InsertStockGroup>
): Promise<schema.StockGroup> {
  const [updated] = await db.update(schema.stockGroups).set(updates).where(eq(schema.stockGroups.id, id)).returning();
  return updated;
}

export async function getStockGroupByCode(code: string, companyId: number): Promise<schema.StockGroup | undefined> {
  const [group] = await db
    .select()
    .from(schema.stockGroups)
    .where(and(eq(schema.stockGroups.code, code), eq(schema.stockGroups.companyId, companyId)));
  return group;
}

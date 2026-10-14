import { eq, sql } from "drizzle-orm";
import { db } from "../../db";
import * as schema from "@shared/schema";

export async function updateBaleTransfer(
  id: number,
  updates: Partial<schema.InsertBaleTransfer>
): Promise<schema.BaleTransfer> {
  const [updated] = await db
    .update(schema.baleTransfers)
    .set({ ...updates, updatedAt: sql`now()` })
    .where(eq(schema.baleTransfers.id, id))
    .returning();
  return updated;
}

export async function createBaleTransferItem(item: schema.InsertBaleTransferItem): Promise<schema.BaleTransferItem> {
  const [created] = await db.insert(schema.baleTransferItems).values(item).returning();
  return created;
}

export async function updateBaleTransferItem(
  id: number,
  updates: Partial<schema.InsertBaleTransferItem>
): Promise<schema.BaleTransferItem> {
  const [updated] = await db
    .update(schema.baleTransferItems)
    .set(updates)
    .where(eq(schema.baleTransferItems.id, id))
    .returning();
  return updated;
}

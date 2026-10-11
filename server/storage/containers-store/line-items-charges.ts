import { eq, sql } from "drizzle-orm";
import { db } from "../../db";
import * as schema from "@shared/schema";
import type {
  POLineItem,
  InsertPOLineItem,
  ContainerCharge,
  InsertContainerCharge,
  ImportLog,
  InsertImportLog,
} from "@shared/schema";

export async function getLineItemsByPO(poId: number): Promise<POLineItem[]> {
  const items = await db
    .select({
      id: schema.poLineItems.id,
      poId: schema.poLineItems.poId,
      stockItemId: schema.poLineItems.stockItemId,
      stockItemCode: schema.stockItems.code,
      stockItemName: sql<string>`COALESCE(
        CASE WHEN ${schema.stockItems.deletedAt} IS NULL THEN ${schema.stockItems.name} ELSE NULL END,
        (SELECT si2.name FROM stock_items si2
           JOIN stock_item_merge_logs sml ON sml.kept_item_id = si2.id
           WHERE sml.merged_item_id = ${schema.poLineItems.stockItemId}
           AND si2.deleted_at IS NULL
           LIMIT 1),
        ${schema.poLineItems.itemName}
      )`,
      itemName: schema.poLineItems.itemName,
      quantity: schema.poLineItems.quantity,
      rate: schema.poLineItems.rate,
      lineTotal: schema.poLineItems.lineTotal,
      nativeRate: schema.poLineItems.nativeRate,
      nativeLineTotal: schema.poLineItems.nativeLineTotal,
      createdAt: schema.poLineItems.createdAt,
      totalCost: schema.poLineItems.lineTotal,
      stockGroupId: schema.stockItems.stockGroupId,
      stockGroupName: sql<string>`COALESCE(${schema.stockGroups.name}, '')`,
      gradeId: schema.stockItems.gradeId,
      gradeName: sql<string | null>`${schema.stockGrades.name}`,
      categoryId: schema.stockItems.categoryId,
      categoryName: sql<string | null>`${schema.stockCategories.name}`,
    })
    .from(schema.poLineItems)
    .leftJoin(schema.stockItems, eq(schema.poLineItems.stockItemId, schema.stockItems.id))
    .leftJoin(schema.stockGroups, eq(schema.stockItems.stockGroupId, schema.stockGroups.id))
    .leftJoin(schema.stockGrades, eq(schema.stockItems.gradeId, schema.stockGrades.id))
    .leftJoin(schema.stockCategories, eq(schema.stockItems.categoryId, schema.stockCategories.id))
    .where(eq(schema.poLineItems.poId, poId));

  return items;
}

export async function createPOLineItem(lineItem: InsertPOLineItem): Promise<POLineItem> {
  const [created] = await db.insert(schema.poLineItems).values(lineItem).returning();
  return created;
}

// ---------------------------------------------------------------------------
// Container Charges
// ---------------------------------------------------------------------------

export async function getChargesByContainer(containerId: number): Promise<ContainerCharge[]> {
  return await db.select().from(schema.containerCharges).where(eq(schema.containerCharges.containerId, containerId));
}

export async function createContainerCharge(charge: InsertContainerCharge): Promise<ContainerCharge> {
  const [created] = await db.insert(schema.containerCharges).values(charge).returning();
  return created;
}

// ---------------------------------------------------------------------------
// Import Logs
// ---------------------------------------------------------------------------

export async function getImportLogByHash(hash: string): Promise<ImportLog | undefined> {
  const [log] = await db.select().from(schema.importLogs).where(eq(schema.importLogs.fileHash, hash));
  return log;
}

export async function createImportLog(log: InsertImportLog): Promise<ImportLog> {
  const [created] = await db.insert(schema.importLogs).values(log).returning();
  return created;
}

// ---------------------------------------------------------------------------
// Container Offload
// ---------------------------------------------------------------------------

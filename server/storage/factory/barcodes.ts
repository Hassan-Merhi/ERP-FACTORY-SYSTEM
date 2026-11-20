import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import * as schema from "@shared/schema";

export async function getAllPendingBarcodes(companyId: number): Promise<schema.PendingBarcode[]> {
  return await db
    .select()
    .from(schema.pendingBarcodes)
    .where(eq(schema.pendingBarcodes.companyId, companyId))
    .orderBy(desc(schema.pendingBarcodes.createdAt));
}

export async function getPendingBarcodeByCode(
  barcode: string,
  companyId: number
): Promise<schema.PendingBarcode | undefined> {
  const results = await db
    .select()
    .from(schema.pendingBarcodes)
    .where(and(eq(schema.pendingBarcodes.barcode, barcode), eq(schema.pendingBarcodes.companyId, companyId)));
  return results[0];
}

export async function createPendingBarcode(data: schema.InsertPendingBarcode): Promise<schema.PendingBarcode> {
  const [result] = await db.insert(schema.pendingBarcodes).values(data).returning();
  return result;
}

/** Company-scoped update: returns undefined when the id is not a row of `companyId`. */
export async function updatePendingBarcode(
  id: number,
  companyId: number,
  updates: Partial<Omit<schema.InsertPendingBarcode, "companyId">>
): Promise<schema.PendingBarcode | undefined> {
  const [result] = await db
    .update(schema.pendingBarcodes)
    .set(updates)
    .where(and(eq(schema.pendingBarcodes.id, id), eq(schema.pendingBarcodes.companyId, companyId)))
    .returning();
  return result;
}

/** Company-scoped delete: returns false when the id is not a row of `companyId`. */
export async function deletePendingBarcode(id: number, companyId: number): Promise<boolean> {
  const deleted = await db
    .delete(schema.pendingBarcodes)
    .where(and(eq(schema.pendingBarcodes.id, id), eq(schema.pendingBarcodes.companyId, companyId)))
    .returning({ id: schema.pendingBarcodes.id });
  return deleted.length > 0;
}

export async function bulkCreatePendingBarcodes(
  barcodes: schema.InsertPendingBarcode[]
): Promise<schema.PendingBarcode[]> {
  if (barcodes.length === 0) return [];
  return await db.insert(schema.pendingBarcodes).values(barcodes).returning();
}

/** Marks only `companyId`'s rows among `ids` as printed; returns how many were marked. */
export async function markBarcodesAsPrinted(ids: number[], companyId: number): Promise<number> {
  if (ids.length === 0) return 0;
  const marked = await db
    .update(schema.pendingBarcodes)
    .set({ printed: true })
    .where(and(inArray(schema.pendingBarcodes.id, ids), eq(schema.pendingBarcodes.companyId, companyId)))
    .returning({ id: schema.pendingBarcodes.id });
  return marked.length;
}

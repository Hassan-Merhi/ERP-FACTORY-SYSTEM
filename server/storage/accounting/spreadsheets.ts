import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../../db";
import * as schema from "@shared/schema";

export async function listSpreadsheets(
  companyId: number
): Promise<Pick<schema.Spreadsheet, "id" | "name" | "createdBy" | "updatedAt">[]> {
  return db
    .select({
      id: schema.spreadsheets.id,
      name: schema.spreadsheets.name,
      createdBy: schema.spreadsheets.createdBy,
      updatedAt: schema.spreadsheets.updatedAt,
    })
    .from(schema.spreadsheets)
    .where(eq(schema.spreadsheets.companyId, companyId))
    .orderBy(desc(schema.spreadsheets.updatedAt));
}

export async function getSpreadsheet(id: number, companyId: number): Promise<schema.Spreadsheet | undefined> {
  const [row] = await db
    .select()
    .from(schema.spreadsheets)
    .where(and(eq(schema.spreadsheets.id, id), eq(schema.spreadsheets.companyId, companyId)));
  return row;
}

export async function createSpreadsheet(
  companyId: number,
  name: string,
  // A jsonb column: the sheet payload is opaque to storage, and `updateSpreadsheet`
  // already declares it this way.
  data: unknown,
  createdBy?: string
): Promise<schema.Spreadsheet> {
  const [row] = await db
    .insert(schema.spreadsheets)
    .values({ companyId, name, data, createdBy: createdBy ?? null })
    .returning();
  return row;
}

export async function updateSpreadsheet(
  id: number,
  companyId: number,
  fields: { name?: string; data?: unknown }
): Promise<schema.Spreadsheet | undefined> {
  const [row] = await db
    .update(schema.spreadsheets)
    .set({ ...fields, updatedAt: sql`now()` })
    .where(and(eq(schema.spreadsheets.id, id), eq(schema.spreadsheets.companyId, companyId)))
    .returning();
  return row;
}

export async function deleteSpreadsheet(id: number, companyId: number): Promise<void> {
  await db
    .delete(schema.spreadsheets)
    .where(and(eq(schema.spreadsheets.id, id), eq(schema.spreadsheets.companyId, companyId)));
}

// ---------------------------------------------------------------------------
// Live Spreadsheets
// ---------------------------------------------------------------------------

export async function getLiveSpreadsheets(companyId: number, activeOnly = true): Promise<schema.LiveSpreadsheet[]> {
  const conditions = [eq(schema.liveSpreadsheets.companyId, companyId)];
  if (activeOnly) conditions.push(eq(schema.liveSpreadsheets.isActive, true));
  return db
    .select()
    .from(schema.liveSpreadsheets)
    .where(and(...conditions))
    .orderBy(schema.liveSpreadsheets.name);
}

export async function getLiveSpreadsheetById(
  id: number,
  companyId: number
): Promise<schema.LiveSpreadsheet | undefined> {
  const [row] = await db
    .select()
    .from(schema.liveSpreadsheets)
    .where(and(eq(schema.liveSpreadsheets.id, id), eq(schema.liveSpreadsheets.companyId, companyId)));
  return row;
}

export async function createLiveSpreadsheet(data: schema.InsertLiveSpreadsheet): Promise<schema.LiveSpreadsheet> {
  const [row] = await db.insert(schema.liveSpreadsheets).values(data).returning();
  return row;
}

export async function updateLiveSpreadsheet(
  id: number,
  companyId: number,
  fields: Partial<schema.InsertLiveSpreadsheet>
): Promise<schema.LiveSpreadsheet | undefined> {
  const [row] = await db
    .update(schema.liveSpreadsheets)
    .set({ ...fields, updatedAt: sql`now()` })
    .where(and(eq(schema.liveSpreadsheets.id, id), eq(schema.liveSpreadsheets.companyId, companyId)))
    .returning();
  return row;
}

export async function deleteLiveSpreadsheet(id: number, companyId: number): Promise<void> {
  await db
    .delete(schema.liveSpreadsheets)
    .where(and(eq(schema.liveSpreadsheets.id, id), eq(schema.liveSpreadsheets.companyId, companyId)));
}

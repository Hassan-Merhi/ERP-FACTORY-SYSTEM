import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import * as schema from "@shared/schema";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";

export async function getProductionBalesByLocation(
  companyId: number,
  locationId: number
): Promise<schema.ProductionBale[]> {
  return await db
    .select()
    .from(schema.productionBales)
    .where(
      and(
        eq(schema.productionBales.companyId, companyId),
        eq(schema.productionBales.locationId, locationId),
        eq(schema.productionBales.status, "IN_STOCK")
      )
    );
}

export async function getAllMixBatches(companyId: number): Promise<schema.MixBatch[]> {
  return await db
    .select()
    .from(schema.mixBatches)
    .where(eq(schema.mixBatches.companyId, companyId))
    .orderBy(desc(schema.mixBatches.createdAt));
}

export async function getMixBatchById(id: number, companyId: number): Promise<schema.MixBatch | undefined> {
  const [batch] = await db
    .select()
    .from(schema.mixBatches)
    .where(and(eq(schema.mixBatches.id, id), eq(schema.mixBatches.companyId, companyId)));
  return batch;
}

export async function createMixBatch(batch: schema.InsertMixBatch): Promise<schema.MixBatch> {
  const [created] = await db
    .insert(schema.mixBatches)
    .values({
      ...batch,
      batchCode: batch.batchCode || `MB-${Date.now()}`,
    })
    .returning();
  return created;
}

export async function updateMixBatch(id: number, updates: Partial<schema.InsertMixBatch>): Promise<schema.MixBatch> {
  const [updated] = await db
    .update(schema.mixBatches)
    .set({ ...updates, updatedAt: sql`now()` })
    .where(eq(schema.mixBatches.id, id))
    .returning();
  return updated;
}

export async function getMixBatchSources(mixBatchId: number, companyId: number): Promise<schema.MixBatchSource[]> {
  const batch = await getMixBatchById(mixBatchId, companyId);
  if (!batch) {
    return [];
  }
  return await db.select().from(schema.mixBatchSources).where(eq(schema.mixBatchSources.mixBatchId, mixBatchId));
}

export async function addMixBatchSource(source: schema.InsertMixBatchSource): Promise<schema.MixBatchSource> {
  const [created] = await db.insert(schema.mixBatchSources).values(source).returning();
  return created;
}

export async function getAllProductionBales(
  companyId: number,
  filters?: {
    mixBatchId?: number;
    status?: string;
    category?: string;
    grade?: string;
  }
) {
  const conditions = [eq(schema.productionBales.companyId, companyId)];

  if (filters?.mixBatchId) {
    conditions.push(eq(schema.productionBales.mixBatchId, filters.mixBatchId));
  }
  if (filters?.status) {
    conditions.push(eq(schema.productionBales.status, filters.status));
  }
  if (filters?.category) {
    conditions.push(eq(schema.productionBales.category, filters.category));
  }
  if (filters?.grade) {
    conditions.push(eq(schema.productionBales.grade, filters.grade));
  }

  return await db
    .select({
      bale: schema.productionBales,
      product: schema.baleProducts,
      location: schema.locations,
      mixBatch: schema.mixBatches,
    })
    .from(schema.productionBales)
    .leftJoin(schema.baleProducts, eq(schema.productionBales.productId, schema.baleProducts.id))
    .leftJoin(schema.locations, eq(schema.productionBales.locationId, schema.locations.id))
    .leftJoin(schema.mixBatches, eq(schema.productionBales.mixBatchId, schema.mixBatches.id))
    .where(and(...conditions))
    .orderBy(desc(schema.productionBales.createdAt));
}

export async function getProductionBaleById(id: number): Promise<schema.ProductionBale | undefined> {
  const [bale] = await db.select().from(schema.productionBales).where(eq(schema.productionBales.id, id));
  return bale;
}

export async function getProductionBaleByBarcode(
  barcodeValue: string,
  companyId: number
): Promise<schema.ProductionBale | undefined> {
  const [bale] = await db
    .select()
    .from(schema.productionBales)
    .where(and(eq(schema.productionBales.barcodeValue, barcodeValue), eq(schema.productionBales.companyId, companyId)));
  return bale;
}

/**
 * The insert schema takes `pressedAt` as an ISO string (that is what the client
 * sends) while the column is a timestamp, so the value is converted here rather
 * than in three separate places behind an `any`.
 */
type ProductionBaleInsert = typeof schema.productionBales.$inferInsert;

function toProductionBaleInsert(bale: schema.InsertProductionBale): ProductionBaleInsert {
  const { pressedAt, ...rest } = bale;
  return pressedAt ? { ...rest, pressedAt: new Date(pressedAt) } : rest;
}

export async function createProductionBale(bale: schema.InsertProductionBale): Promise<schema.ProductionBale> {
  const [created] = await db.insert(schema.productionBales).values(toProductionBaleInsert(bale)).returning();
  return created;
}

export async function updateProductionBale(
  id: number,
  updates: Partial<schema.InsertProductionBale>
): Promise<schema.ProductionBale> {
  const { pressedAt, ...rest } = updates;
  const updateData: PgUpdateSetSource<typeof schema.productionBales> = {
    ...rest,
    ...(pressedAt ? { pressedAt: new Date(pressedAt) } : {}),
    updatedAt: sql`now()`,
  };
  const [updated] = await db
    .update(schema.productionBales)
    .set(updateData)
    .where(eq(schema.productionBales.id, id))
    .returning();
  return updated;
}

export async function deleteProductionBale(id: number, companyId: number): Promise<void> {
  await db
    .delete(schema.productionBales)
    .where(and(eq(schema.productionBales.id, id), eq(schema.productionBales.companyId, companyId)));
}

export async function bulkCreateProductionBales(
  bales: schema.InsertProductionBale[]
): Promise<schema.ProductionBale[]> {
  if (bales.length === 0) return [];
  return await db.insert(schema.productionBales).values(bales.map(toProductionBaleInsert)).returning();
}

export async function updateProductionBaleFromScan(
  barcodeValue: string,
  companyId: number,
  updates: {
    weightKg: string;
    category: string;
    grade: string;
    warehouseLocation?: string;
  }
): Promise<schema.ProductionBale> {
  const bale = await getProductionBaleByBarcode(barcodeValue, companyId);
  if (!bale) {
    throw new Error(`Bale with barcode ${barcodeValue} not found`);
  }

  let costPerKg = "0";
  let totalCost = "0";

  if (bale.mixBatchId) {
    const batch = await getMixBatchById(bale.mixBatchId, companyId);
    if (batch) {
      costPerKg = batch.costPerKg;
      const weight = parseFloat(updates.weightKg);
      const cost = parseFloat(costPerKg);
      totalCost = (weight * cost).toFixed(2);
    }
  }

  const [updated] = await db
    .update(schema.productionBales)
    .set({
      weightKg: updates.weightKg,
      category: updates.category,
      grade: updates.grade,
      warehouseLocation: updates.warehouseLocation,
      costPerKg,
      totalCost,
      status: "PRESSED",
      pressedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(eq(schema.productionBales.id, bale.id))
    .returning();

  return updated;
}

export async function getNextBaleBarcode(companyId: number): Promise<string> {
  const [sequence] = await db.select().from(schema.baleSequences).where(eq(schema.baleSequences.companyId, companyId));

  if (!sequence) {
    const [newSeq] = await db.insert(schema.baleSequences).values({ companyId, nextNumber: 2 }).returning();
    return `HD${String(newSeq.nextNumber - 1).padStart(5, "0")}`;
  }

  const nextNum = sequence.nextNumber;
  await db
    .update(schema.baleSequences)
    .set({ nextNumber: nextNum + 1 })
    .where(eq(schema.baleSequences.id, sequence.id));

  return `HD${String(nextNum).padStart(5, "0")}`;
}

/**
 * Retail Wave 2 physical stock-count sessions (Track D).
 *
 * Workflow: draft → counting → review → (recount → counting) → finalized, or canceled.
 * Finalization is a single transaction that locks the session, re-reads the live quantity
 * of every counted variant under the same inventory row lock every other stock writer
 * uses, and writes `stock_count` movements that reference the session. Nothing writes
 * inventory without a movement.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  locations,
  retailBrands,
  retailProductVariants,
  retailProducts,
  retailStockCountLines,
  retailStockCountSessions,
  users,
} from "@shared/schema";
import { db } from "../../db";

/** Read-only retail stock-count queries: session detail, session list and variance report. */

function toNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function loadRetailStockCountSession(companyId: number, sessionId: number) {
  const [session] = await db
    .select({
      id: retailStockCountSessions.id,
      companyId: retailStockCountSessions.companyId,
      locationId: retailStockCountSessions.locationId,
      locationName: locations.name,
      code: retailStockCountSessions.code,
      status: retailStockCountSessions.status,
      notes: retailStockCountSessions.notes,
      snapshotAt: retailStockCountSessions.snapshotAt,
      countingStartedAt: retailStockCountSessions.countingStartedAt,
      reviewStartedAt: retailStockCountSessions.reviewStartedAt,
      finalizedAt: retailStockCountSessions.finalizedAt,
      canceledAt: retailStockCountSessions.canceledAt,
      createdBy: users.username,
      lineCount: retailStockCountSessions.lineCount,
      countedLineCount: retailStockCountSessions.countedLineCount,
      uncountedLineCount: retailStockCountSessions.uncountedLineCount,
      varianceLineCount: retailStockCountSessions.varianceLineCount,
      unexpectedLineCount: retailStockCountSessions.unexpectedLineCount,
      recountLineCount: retailStockCountSessions.recountLineCount,
      expectedQuantityTotal: retailStockCountSessions.expectedQuantityTotal,
      countedQuantityTotal: retailStockCountSessions.countedQuantityTotal,
      varianceQuantityTotal: retailStockCountSessions.varianceQuantityTotal,
      varianceValueTotal: retailStockCountSessions.varianceValueTotal,
      finalizedResult: retailStockCountSessions.finalizedResult,
      createdAt: retailStockCountSessions.createdAt,
      updatedAt: retailStockCountSessions.updatedAt,
    })
    .from(retailStockCountSessions)
    .leftJoin(locations, eq(locations.id, retailStockCountSessions.locationId))
    .leftJoin(users, eq(users.id, retailStockCountSessions.createdBy))
    .where(and(eq(retailStockCountSessions.companyId, companyId), eq(retailStockCountSessions.id, sessionId)))
    .limit(1);
  if (!session) return null;

  const lines = await db
    .select({
      id: retailStockCountLines.id,
      variantId: retailStockCountLines.variantId,
      expectedQuantity: retailStockCountLines.expectedQuantity,
      countedQuantity: retailStockCountLines.countedQuantity,
      status: retailStockCountLines.status,
      recountRequired: retailStockCountLines.recountRequired,
      notes: retailStockCountLines.notes,
      expectedLiveQuantity: retailStockCountLines.expectedLiveQuantity,
      varianceQuantity: retailStockCountLines.varianceQuantity,
      movementDelta: retailStockCountLines.movementDelta,
      countedAt: retailStockCountLines.countedAt,
      lastScannedAt: retailStockCountLines.lastScannedAt,
      productId: retailProducts.id,
      productName: retailProducts.name,
      productCode: retailProducts.code,
      brand: retailBrands.name,
      color: retailProductVariants.color,
      size: retailProductVariants.size,
      barcode: retailProductVariants.barcode,
      sku: retailProductVariants.sku,
      cost: retailProductVariants.cost,
      sellingPrice: retailProductVariants.sellingPrice,
    })
    .from(retailStockCountLines)
    .innerJoin(retailProductVariants, eq(retailProductVariants.id, retailStockCountLines.variantId))
    .innerJoin(retailProducts, eq(retailProducts.id, retailProductVariants.productId))
    .leftJoin(retailBrands, eq(retailBrands.id, retailProducts.brandId))
    .where(and(eq(retailStockCountLines.companyId, companyId), eq(retailStockCountLines.sessionId, sessionId)))
    .orderBy(asc(retailProducts.name), asc(retailProductVariants.color), asc(retailProductVariants.size));

  return {
    ...session,
    notes: session.notes ?? null,
    expectedQuantityTotal: toNumber(session.expectedQuantityTotal),
    countedQuantityTotal: toNumber(session.countedQuantityTotal),
    varianceQuantityTotal: toNumber(session.varianceQuantityTotal),
    varianceValueTotal: toNumber(session.varianceValueTotal),
    lines: lines.map((line) => ({
      ...line,
      brand: line.brand ?? "Other / No Brand",
      expectedQuantity: toNumber(line.expectedQuantity),
      countedQuantity: line.countedQuantity === null ? null : toNumber(line.countedQuantity),
      expectedLiveQuantity: line.expectedLiveQuantity === null ? null : toNumber(line.expectedLiveQuantity),
      varianceQuantity: line.varianceQuantity === null ? null : toNumber(line.varianceQuantity),
      movementDelta: line.movementDelta === null ? null : toNumber(line.movementDelta),
      cost: toNumber(line.cost),
      sellingPrice: toNumber(line.sellingPrice),
      difference:
        line.countedQuantity === null ? null : toNumber(line.countedQuantity) - toNumber(line.expectedQuantity),
    })),
  };
}

export interface RetailStockCountFilters {
  locationId?: number;
  status?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

export async function listRetailStockCountSessions(companyId: number, filters: RetailStockCountFilters = {}) {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const rows = await db
    .select({
      id: retailStockCountSessions.id,
      code: retailStockCountSessions.code,
      status: retailStockCountSessions.status,
      locationId: retailStockCountSessions.locationId,
      locationName: locations.name,
      lineCount: retailStockCountSessions.lineCount,
      countedLineCount: retailStockCountSessions.countedLineCount,
      uncountedLineCount: retailStockCountSessions.uncountedLineCount,
      varianceLineCount: retailStockCountSessions.varianceLineCount,
      unexpectedLineCount: retailStockCountSessions.unexpectedLineCount,
      recountLineCount: retailStockCountSessions.recountLineCount,
      expectedQuantityTotal: retailStockCountSessions.expectedQuantityTotal,
      countedQuantityTotal: retailStockCountSessions.countedQuantityTotal,
      varianceQuantityTotal: retailStockCountSessions.varianceQuantityTotal,
      varianceValueTotal: retailStockCountSessions.varianceValueTotal,
      createdAt: retailStockCountSessions.createdAt,
      snapshotAt: retailStockCountSessions.snapshotAt,
      finalizedAt: retailStockCountSessions.finalizedAt,
      canceledAt: retailStockCountSessions.canceledAt,
      notes: retailStockCountSessions.notes,
    })
    .from(retailStockCountSessions)
    .leftJoin(locations, eq(locations.id, retailStockCountSessions.locationId))
    .where(
      and(
        eq(retailStockCountSessions.companyId, companyId),
        filters.locationId ? eq(retailStockCountSessions.locationId, filters.locationId) : undefined,
        filters.status ? eq(retailStockCountSessions.status, filters.status) : undefined,
        filters.from ? sql`${retailStockCountSessions.createdAt} >= ${filters.from}` : undefined,
        filters.to ? sql`${retailStockCountSessions.createdAt} < ${filters.to}` : undefined
      )
    )
    .orderBy(desc(retailStockCountSessions.createdAt))
    .limit(limit);
  return rows.map((row) => ({
    ...row,
    expectedQuantityTotal: toNumber(row.expectedQuantityTotal),
    countedQuantityTotal: toNumber(row.countedQuantityTotal),
    varianceQuantityTotal: toNumber(row.varianceQuantityTotal),
    varianceValueTotal: toNumber(row.varianceValueTotal),
  }));
}

/**
 * Variance report for one session: per line snapshot vs counted vs live at finalize,
 * with the movement that was written. Explains "count variance" and "movement during
 * the count" separately.
 */
export async function loadRetailStockCountVarianceReport(companyId: number, sessionId: number) {
  const session = await loadRetailStockCountSession(companyId, sessionId);
  if (!session) return null;
  const movementRows = await db.execute(sql`
    SELECT
      reference_id,
      NULLIF(metadata->>'stockCountLineId', '')::integer AS line_id,
      SUM(quantity_delta) AS movement_delta,
      COUNT(*)::int AS movement_count
    FROM retail_stock_movements
    WHERE company_id = ${companyId}
      AND reference_type = 'retail_stock_count'
      AND reference_id = ${String(sessionId)}
    GROUP BY reference_id, NULLIF(metadata->>'stockCountLineId', '')::integer
  `);
  const movementByLine = new Map<number, { delta: number; count: number }>();
  for (const row of movementRows.rows as Array<Record<string, unknown>>) {
    const lineId = Number(row.line_id);
    if (!Number.isFinite(lineId)) continue;
    movementByLine.set(lineId, { delta: toNumber(row.movement_delta), count: Number(row.movement_count ?? 0) });
  }
  const varianceLines = session.lines.filter((line) => line.difference !== null && Math.abs(line.difference) > 1e-6);
  return {
    session: {
      id: session.id,
      code: session.code,
      status: session.status,
      locationId: session.locationId,
      locationName: session.locationName,
      snapshotAt: session.snapshotAt,
      finalizedAt: session.finalizedAt,
      lineCount: session.lineCount,
      countedLineCount: session.countedLineCount,
      uncountedLineCount: session.uncountedLineCount,
      varianceLineCount: session.varianceLineCount,
      unexpectedLineCount: session.unexpectedLineCount,
      recountLineCount: session.recountLineCount,
      expectedQuantityTotal: session.expectedQuantityTotal,
      countedQuantityTotal: session.countedQuantityTotal,
      varianceQuantityTotal: session.varianceQuantityTotal,
      varianceValueTotal: session.varianceValueTotal,
    },
    varianceLines: varianceLines.map((line) => ({
      ...line,
      movement: movementByLine.get(line.id) ?? { delta: 0, count: 0 },
      movementDuringCount:
        line.expectedLiveQuantity === null ? null : line.expectedLiveQuantity - line.expectedQuantity,
    })),
    lines: session.lines.map((line) => ({
      ...line,
      movement: movementByLine.get(line.id) ?? { delta: 0, count: 0 },
      movementDuringCount:
        line.expectedLiveQuantity === null ? null : line.expectedLiveQuantity - line.expectedQuantity,
    })),
  };
}

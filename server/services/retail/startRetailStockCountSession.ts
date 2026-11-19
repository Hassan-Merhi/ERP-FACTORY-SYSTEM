// Extracted from ./retailStockCount.ts to keep that module under the source-size cap.
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  locations,
  retailProducts,
  retailProductVariants,
  retailStockCountEvents,
  retailStockCountLines,
  retailStockCountSessions,
  retailVariantInventory,
} from "@shared/schema";
import { db } from "../../db";
import { formatRetailStockCountCode, summarizeRetailStockCountLines } from "./retailStockCountMath";
import { loadRetailStockCountSession } from "./retailStockCountQueries";

export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type Executor = Transaction | typeof db;

export class RetailStockCountValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "RetailStockCountValidationError";
  }
}

export class RetailStockCountConflictError extends Error {
  readonly statusCode = 409;
  readonly code: string;
  readonly details: Record<string, unknown> | null;
  constructor(message: string, code = "STOCK_COUNT_CONFLICT", details: Record<string, unknown> | null = null) {
    super(message);
    this.name = "RetailStockCountConflictError";
    this.code = code;
    this.details = details;
  }
}

export function toNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function withTransaction<T>(executor: Executor, work: (tx: Transaction) => Promise<T>): Promise<T> {
  if (executor === db) return db.transaction(work);
  return work(executor as Transaction);
}

export async function lockSessionRow(tx: Transaction, companyId: number, sessionId: number) {
  await tx.execute(
    sql`select id from retail_stock_count_sessions where id = ${sessionId} and company_id = ${companyId} for update`
  );
  const [session] = await tx
    .select()
    .from(retailStockCountSessions)
    .where(and(eq(retailStockCountSessions.id, sessionId), eq(retailStockCountSessions.companyId, companyId)))
    .limit(1);
  if (!session) throw new RetailStockCountValidationError("Stock count session not found");
  return session;
}

export async function insertEvent(
  tx: Transaction,
  input: {
    companyId: number;
    sessionId: number;
    userId: string;
    eventType: string;
    lineId?: number | null;
    variantId?: number | null;
    previousQuantity?: number | null;
    quantity?: number | null;
    delta?: number | null;
    note?: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await tx.insert(retailStockCountEvents).values({
    companyId: input.companyId,
    sessionId: input.sessionId,
    lineId: input.lineId ?? null,
    variantId: input.variantId ?? null,
    eventType: input.eventType,
    previousQuantity:
      input.previousQuantity === null || input.previousQuantity === undefined ? null : String(input.previousQuantity),
    quantity: input.quantity === null || input.quantity === undefined ? null : String(input.quantity),
    delta: input.delta === null || input.delta === undefined ? null : String(input.delta),
    note: input.note?.trim() ? input.note.trim() : null,
    metadata: input.metadata ?? {},
    createdBy: input.userId,
  });
}

export async function refreshSessionTotals(tx: Transaction, companyId: number, sessionId: number): Promise<void> {
  const lines = await tx
    .select({
      expectedQuantity: retailStockCountLines.expectedQuantity,
      countedQuantity: retailStockCountLines.countedQuantity,
      recountRequired: retailStockCountLines.recountRequired,
    })
    .from(retailStockCountLines)
    .where(and(eq(retailStockCountLines.companyId, companyId), eq(retailStockCountLines.sessionId, sessionId)));
  const summary = summarizeRetailStockCountLines(
    lines.map((line) => ({
      expectedQuantity: toNumber(line.expectedQuantity),
      countedQuantity: line.countedQuantity === null ? null : toNumber(line.countedQuantity),
    }))
  );
  const recountLineCount = lines.filter((line) => line.recountRequired).length;
  const varianceValueTotal = await tx
    .select({
      value: sql<string>`COALESCE(SUM(ABS(COALESCE(${retailStockCountLines.varianceQuantity}, 0)) * COALESCE(${retailProductVariants.cost}, 0)), 0)`,
    })
    .from(retailStockCountLines)
    .innerJoin(retailProductVariants, eq(retailProductVariants.id, retailStockCountLines.variantId))
    .where(and(eq(retailStockCountLines.companyId, companyId), eq(retailStockCountLines.sessionId, sessionId)));

  await tx
    .update(retailStockCountSessions)
    .set({
      lineCount: summary.lineCount,
      countedLineCount: summary.countedLineCount,
      uncountedLineCount: summary.uncountedLineCount,
      varianceLineCount: summary.varianceLineCount,
      unexpectedLineCount: summary.unexpectedLineCount,
      recountLineCount,
      expectedQuantityTotal: String(summary.expectedQuantityTotal),
      countedQuantityTotal: String(summary.countedQuantityTotal),
      varianceQuantityTotal: String(summary.varianceQuantityTotal),
      varianceValueTotal: toNumber(varianceValueTotal[0]?.value).toFixed(6),
      updatedAt: new Date(),
    })
    .where(and(eq(retailStockCountSessions.companyId, companyId), eq(retailStockCountSessions.id, sessionId)));
}

/** Creates a draft session (and optionally starts counting immediately). */
export async function createRetailStockCountSession(input: {
  companyId: number;
  locationId: number;
  userId: string;
  notes?: string | null;
  includeAllVariants?: boolean;
  startNow?: boolean;
}) {
  const session = await db.transaction(async (tx) => {
    const [location] = await tx
      .select({ id: locations.id })
      .from(locations)
      .where(
        and(eq(locations.id, input.locationId), eq(locations.companyId, input.companyId), eq(locations.active, true))
      )
      .limit(1);
    if (!location)
      throw new RetailStockCountValidationError("Location is not active or does not belong to the company");

    // Serialize count creation for this location. Both the conflict check and
    // insert must run under the same lock or two registers can start a stale count.
    await tx.execute(
      sql`select id from locations where id = ${input.locationId} and company_id = ${input.companyId} for update`
    );
    const [openCount] = await tx
      .select({ id: retailStockCountSessions.id })
      .from(retailStockCountSessions)
      .where(
        and(
          eq(retailStockCountSessions.companyId, input.companyId),
          eq(retailStockCountSessions.locationId, input.locationId),
          inArray(retailStockCountSessions.status, ["draft", "counting", "review"])
        )
      )
      .limit(1);
    if (openCount) {
      throw new RetailStockCountConflictError(
        "Another stock count is already open for this location. Finish or cancel it first.",
        "STOCK_COUNT_LOCATION_ALREADY_OPEN",
        { sessionId: openCount.id }
      );
    }

    const [inserted] = await tx
      .insert(retailStockCountSessions)
      .values({
        companyId: input.companyId,
        locationId: input.locationId,
        code: `pending-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`,
        status: "draft",
        notes: input.notes?.trim() ? input.notes.trim() : null,
        createdBy: input.userId,
      })
      .returning({ id: retailStockCountSessions.id });
    const code = formatRetailStockCountCode(inserted.id);
    await tx
      .update(retailStockCountSessions)
      .set({ code, updatedAt: new Date() })
      .where(eq(retailStockCountSessions.id, inserted.id));
    await insertEvent(tx, {
      companyId: input.companyId,
      sessionId: inserted.id,
      userId: input.userId,
      eventType: "created",
      note: input.notes ?? null,
      metadata: { locationId: input.locationId, code },
    });
    return inserted.id;
  });

  if (input.startNow !== false) {
    await startRetailStockCountSession({
      companyId: input.companyId,
      sessionId: session,
      userId: input.userId,
      includeAllVariants: input.includeAllVariants,
    });
  }
  return loadRetailStockCountSession(input.companyId, session);
}

/**
 * Draft → Counting: snapshots one line per tracked variant at the location.
 * `includeAllVariants` snapshots the whole active catalogue instead of only variants
 * that already have a stock row (including zero-quantity rows) at the location.
 */
export async function startRetailStockCountSession(input: {
  companyId: number;
  sessionId: number;
  userId: string;
  includeAllVariants?: boolean;
}) {
  return db.transaction(async (tx) => {
    const session = await lockSessionRow(tx, input.companyId, input.sessionId);
    if (session.status === "finalized") {
      throw new RetailStockCountConflictError("Finalized stock counts cannot be restarted", "STOCK_COUNT_FINALIZED");
    }
    if (session.status === "canceled") {
      throw new RetailStockCountConflictError("Canceled stock counts cannot be restarted", "STOCK_COUNT_CANCELED");
    }
    if (session.status !== "draft") {
      throw new RetailStockCountConflictError("This stock count has already started", "STOCK_COUNT_ALREADY_STARTED");
    }

    const variantRows = await tx
      .select({
        variantId: retailProductVariants.id,
        quantity: retailVariantInventory.quantity,
      })
      .from(retailProductVariants)
      .innerJoin(retailProducts, eq(retailProducts.id, retailProductVariants.productId))
      .leftJoin(
        retailVariantInventory,
        and(
          eq(retailVariantInventory.variantId, retailProductVariants.id),
          eq(retailVariantInventory.locationId, session.locationId),
          eq(retailVariantInventory.companyId, input.companyId)
        )
      )
      .where(
        and(
          eq(retailProductVariants.companyId, input.companyId),
          eq(retailProducts.companyId, input.companyId),
          eq(retailProductVariants.active, true),
          eq(retailProducts.active, true),
          input.includeAllVariants ? undefined : sql`${retailVariantInventory.id} IS NOT NULL`
        )
      )
      .orderBy(asc(retailProductVariants.id));

    for (const variant of variantRows) {
      await tx
        .insert(retailStockCountLines)
        .values({
          companyId: input.companyId,
          sessionId: session.id,
          variantId: variant.variantId,
          expectedQuantity: String(toNumber(variant.quantity)),
        })
        .onConflictDoNothing({ target: [retailStockCountLines.sessionId, retailStockCountLines.variantId] });
    }

    const now = new Date();
    await tx
      .update(retailStockCountSessions)
      .set({
        status: "counting",
        snapshotAt: now,
        countingStartedAt: session.countingStartedAt ?? now,
        updatedAt: now,
      })
      .where(eq(retailStockCountSessions.id, session.id));
    await insertEvent(tx, {
      companyId: input.companyId,
      sessionId: session.id,
      userId: input.userId,
      eventType: "started",
      metadata: { lineCount: variantRows.length, includeAllVariants: Boolean(input.includeAllVariants) },
    });
    await refreshSessionTotals(tx, input.companyId, session.id);
    return { sessionId: session.id, status: "counting" as const, lineCount: variantRows.length };
  });
}

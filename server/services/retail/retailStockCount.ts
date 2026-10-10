/**
 * Retail Wave 2 physical stock-count sessions (Track D).
 *
 * Workflow: draft → counting → review → (recount → counting) → finalized, or canceled.
 * Finalization is a single transaction that locks the session, re-reads the live quantity
 * of every counted variant under the same inventory row lock every other stock writer
 * uses, and writes `stock_count` movements that reference the session. Nothing writes
 * inventory without a movement.
 */
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  locations,
  retailProductVariants,
  retailProducts,
  retailStockCountEvents,
  retailStockCountLines,
  retailStockCountSessions,
  retailStockMovements,
  retailVariantInventory,
} from "@shared/schema";
import { db } from "../../db";
import { addMovement, lockInventoryRow, setInventoryQuantity } from "./retailStockLedger";
import { trackRetailStockValueTx } from "./retailInventoryJournal";
import {
  computeRetailStockCountLineStatus,
  finalizeRetailStockCountLine,
  formatRetailStockCountCode,
  nextRetailStockCountQuantity,
  summarizeRetailStockCountLines,
  type RetailStockCountEntryModeValue,
} from "./retailStockCountMath";
import {
  listRetailStockCountSessions,
  loadRetailStockCountSession,
  loadRetailStockCountVarianceReport,
  type RetailStockCountFilters,
} from "./retailStockCountQueries";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
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

function toNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function withTransaction<T>(executor: Executor, work: (tx: Transaction) => Promise<T>): Promise<T> {
  if (executor === db) return db.transaction(work);
  return work(executor as Transaction);
}

async function lockSessionRow(tx: Transaction, companyId: number, sessionId: number) {
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

async function insertEvent(
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

async function refreshSessionTotals(tx: Transaction, companyId: number, sessionId: number): Promise<void> {
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

async function findOrCreateLine(
  tx: Transaction,
  companyId: number,
  sessionId: number,
  locationId: number,
  variantId: number
) {
  const [existing] = await tx
    .select()
    .from(retailStockCountLines)
    .where(
      and(
        eq(retailStockCountLines.companyId, companyId),
        eq(retailStockCountLines.sessionId, sessionId),
        eq(retailStockCountLines.variantId, variantId)
      )
    )
    .limit(1);
  if (existing) return { line: existing, unexpected: false };

  // The variant must belong to the company; it does not have to be in the snapshot —
  // finding stock that the system did not expect is exactly what a count is for.
  const [variant] = await tx
    .select({ id: retailProductVariants.id })
    .from(retailProductVariants)
    .innerJoin(retailProducts, eq(retailProducts.id, retailProductVariants.productId))
    .where(
      and(
        eq(retailProductVariants.id, variantId),
        eq(retailProductVariants.companyId, companyId),
        eq(retailProducts.companyId, companyId)
      )
    )
    .limit(1);
  if (!variant) throw new RetailStockCountValidationError("Variant does not belong to this company");
  void locationId;

  const [inserted] = await tx
    .insert(retailStockCountLines)
    .values({
      companyId,
      sessionId,
      variantId,
      expectedQuantity: "0",
      status: "uncounted",
      notes: "Unexpected item found during count",
    })
    .onConflictDoNothing({ target: [retailStockCountLines.sessionId, retailStockCountLines.variantId] })
    .returning();
  if (inserted) return { line: inserted, unexpected: true };
  const [raced] = await tx
    .select()
    .from(retailStockCountLines)
    .where(and(eq(retailStockCountLines.sessionId, sessionId), eq(retailStockCountLines.variantId, variantId)))
    .limit(1);
  if (!raced) throw new RetailStockCountConflictError("Stock count line could not be created");
  return { line: raced, unexpected: false };
}

/**
 * Records one counting action: repeated barcode scans (`increment`) or a manual entry
 * (`set`). Unknown variants become `unexpected` lines with expected 0.
 */
export async function recordRetailStockCountEntry(input: {
  companyId: number;
  sessionId: number;
  userId: string;
  variantId: number;
  quantity: number;
  mode: RetailStockCountEntryModeValue;
  note?: string | null;
}) {
  return withTransaction(db, async (tx) => {
    const session = await lockSessionRow(tx, input.companyId, input.sessionId);
    if (session.status !== "counting") {
      throw new RetailStockCountConflictError(
        session.status === "review"
          ? "This stock count is in review — reopen it before counting more"
          : `Cannot count on a ${session.status} stock count`,
        "STOCK_COUNT_NOT_COUNTING"
      );
    }
    const { line, unexpected } = await findOrCreateLine(
      tx,
      input.companyId,
      session.id,
      session.locationId,
      input.variantId
    );
    const previous = line.countedQuantity === null ? null : toNumber(line.countedQuantity);
    const nextQuantity = nextRetailStockCountQuantity(previous, input.quantity, input.mode);
    const expected = toNumber(line.expectedQuantity);
    const status = computeRetailStockCountLineStatus(expected, nextQuantity);
    const now = new Date();
    await tx
      .update(retailStockCountLines)
      .set({
        countedQuantity: String(nextQuantity),
        expectedQuantity: unexpected ? "0" : line.expectedQuantity,
        status,
        countedBy: input.userId,
        countedAt: now,
        lastScannedAt: now,
        updatedAt: now,
        ...(input.note?.trim() ? { notes: input.note.trim() } : {}),
      })
      .where(eq(retailStockCountLines.id, line.id));
    await insertEvent(tx, {
      companyId: input.companyId,
      sessionId: session.id,
      userId: input.userId,
      eventType: input.mode === "increment" ? "scan" : "manual_entry",
      lineId: line.id,
      variantId: input.variantId,
      previousQuantity: previous,
      quantity: nextQuantity,
      delta: nextQuantity - (previous ?? 0),
      note: input.note ?? null,
      metadata: { unexpected, expectedQuantity: expected, status },
    });
    await refreshSessionTotals(tx, input.companyId, session.id);
    return { lineId: line.id, countedQuantity: nextQuantity, status, unexpected };
  });
}

export async function updateRetailStockCountLine(input: {
  companyId: number;
  sessionId: number;
  lineId: number;
  userId: string;
  recountRequired?: boolean;
  notes?: string | null;
}) {
  return withTransaction(db, async (tx) => {
    const session = await lockSessionRow(tx, input.companyId, input.sessionId);
    if (session.status === "finalized" || session.status === "canceled") {
      throw new RetailStockCountConflictError(`Cannot edit a ${session.status} stock count`, "STOCK_COUNT_LOCKED");
    }
    const [line] = await tx
      .select()
      .from(retailStockCountLines)
      .where(
        and(
          eq(retailStockCountLines.id, input.lineId),
          eq(retailStockCountLines.companyId, input.companyId),
          eq(retailStockCountLines.sessionId, session.id)
        )
      )
      .limit(1);
    if (!line) throw new RetailStockCountValidationError("Stock count line not found");
    const now = new Date();
    await tx
      .update(retailStockCountLines)
      .set({
        ...(input.recountRequired === undefined ? {} : { recountRequired: input.recountRequired }),
        ...(input.notes === undefined ? {} : { notes: input.notes?.trim() ?? null }),
        updatedAt: now,
      })
      .where(eq(retailStockCountLines.id, line.id));
    if (input.recountRequired !== undefined) {
      await insertEvent(tx, {
        companyId: input.companyId,
        sessionId: session.id,
        userId: input.userId,
        eventType: "recount_requested",
        lineId: line.id,
        variantId: line.variantId,
        note: input.notes ?? null,
        metadata: { recountRequired: input.recountRequired },
      });
    } else if (input.notes !== undefined) {
      await insertEvent(tx, {
        companyId: input.companyId,
        sessionId: session.id,
        userId: input.userId,
        eventType: "note",
        lineId: line.id,
        variantId: line.variantId,
        note: input.notes ?? null,
      });
    }
    await refreshSessionTotals(tx, input.companyId, session.id);
    return { lineId: line.id, recountRequired: input.recountRequired ?? line.recountRequired };
  });
}

async function setSessionStatus(
  input: { companyId: number; sessionId: number; userId: string },
  from: string[],
  to: string,
  eventType: string,
  extra: Record<string, unknown> = {}
) {
  return db.transaction(async (tx) => {
    const session = await lockSessionRow(tx, input.companyId, input.sessionId);
    if (!from.includes(session.status)) {
      throw new RetailStockCountConflictError(
        `Cannot move a ${session.status} stock count to ${to}`,
        "STOCK_COUNT_INVALID_TRANSITION"
      );
    }
    const now = new Date();
    await tx
      .update(retailStockCountSessions)
      .set({
        status: to,
        ...(to === "review" ? { reviewStartedAt: now } : {}),
        ...(to === "counting" ? { countingStartedAt: session.countingStartedAt ?? now } : {}),
        updatedAt: now,
      })
      .where(eq(retailStockCountSessions.id, session.id));
    await insertEvent(tx, {
      companyId: input.companyId,
      sessionId: session.id,
      userId: input.userId,
      eventType,
      ...extra,
    });
    await refreshSessionTotals(tx, input.companyId, session.id);
    return { sessionId: session.id, status: to };
  });
}

/** Counting → Review. */
export async function moveRetailStockCountToReview(input: {
  companyId: number;
  sessionId: number;
  userId: string;
  notes?: string | null;
}) {
  return setSessionStatus(input, ["counting"], "review", "review_started", {
    note: input.notes ?? null,
  });
}

/**
 * Review → Counting. Lines flagged `recountRequired` get their counted quantity reset
 * (they are the ones a supervisor asked to recount); everything else keeps its count.
 */
export async function recountRetailStockCountLines(input: {
  companyId: number;
  sessionId: number;
  userId: string;
  lineIds?: number[];
  notes?: string | null;
}) {
  return db.transaction(async (tx) => {
    const session = await lockSessionRow(tx, input.companyId, input.sessionId);
    if (session.status === "finalized" || session.status === "canceled") {
      throw new RetailStockCountConflictError(`Cannot recount a ${session.status} stock count`, "STOCK_COUNT_LOCKED");
    }
    const flagged = await tx
      .select({ id: retailStockCountLines.id, variantId: retailStockCountLines.variantId })
      .from(retailStockCountLines)
      .where(
        and(
          eq(retailStockCountLines.companyId, input.companyId),
          eq(retailStockCountLines.sessionId, session.id),
          input.lineIds?.length
            ? inArray(retailStockCountLines.id, input.lineIds)
            : eq(retailStockCountLines.recountRequired, true)
        )
      );
    if (!flagged.length) {
      throw new RetailStockCountValidationError("No lines are flagged for recount");
    }
    const now = new Date();
    await tx
      .update(retailStockCountLines)
      .set({ countedQuantity: null, status: "uncounted", recountRequired: false, updatedAt: now })
      .where(
        inArray(
          retailStockCountLines.id,
          flagged.map((line) => line.id)
        )
      );
    await tx
      .update(retailStockCountSessions)
      .set({ status: "counting", updatedAt: now })
      .where(eq(retailStockCountSessions.id, session.id));
    await insertEvent(tx, {
      companyId: input.companyId,
      sessionId: session.id,
      userId: input.userId,
      eventType: "recount_started",
      note: input.notes ?? null,
      metadata: { lineIds: flagged.map((line) => line.id), resetLineCount: flagged.length },
    });
    await refreshSessionTotals(tx, input.companyId, session.id);
    return { sessionId: session.id, status: "counting" as const, resetLineCount: flagged.length };
  });
}

export async function cancelRetailStockCount(input: {
  companyId: number;
  sessionId: number;
  userId: string;
  reason?: string | null;
}) {
  return db.transaction(async (tx) => {
    const session = await lockSessionRow(tx, input.companyId, input.sessionId);
    if (session.status === "finalized") {
      throw new RetailStockCountConflictError("Finalized stock counts cannot be canceled", "STOCK_COUNT_FINALIZED");
    }
    if (session.status === "canceled") return { sessionId: session.id, status: "canceled" as const, replayed: true };
    const now = new Date();
    await tx
      .update(retailStockCountSessions)
      .set({ status: "canceled", canceledAt: now, canceledBy: input.userId, updatedAt: now })
      .where(eq(retailStockCountSessions.id, session.id));
    await insertEvent(tx, {
      companyId: input.companyId,
      sessionId: session.id,
      userId: input.userId,
      eventType: "canceled",
      note: input.reason ?? null,
    });
    return { sessionId: session.id, status: "canceled" as const, replayed: false };
  });
}

export interface RetailStockCountFinalizeResult {
  sessionId: number;
  status: "finalized";
  replayed: boolean;
  adjustedLineCount: number;
  movementCount: number;
  varianceLineCount: number;
  unexpectedLineCount: number;
  uncountedLineCount: number;
  varianceQuantityTotal: number;
  varianceValueTotal: number;
}

/**
 * Finalizes a count atomically and idempotently:
 * - source status must be `counting` or `review` (a finalized replay returns the stored result);
 * - uncounted lines block finalization unless `allowUncounted` is set (they are left untouched);
 * - variance lines require `confirmVariance`;
 * - each counted line writes `counted − live` under the inventory row lock and a
 *   `stock_count` movement referencing this session.
 */
export async function finalizeRetailStockCount(input: {
  companyId: number;
  sessionId: number;
  userId: string;
  allowUncounted?: boolean;
  confirmVariance?: boolean;
  notes?: string | null;
}): Promise<RetailStockCountFinalizeResult> {
  return db.transaction(async (tx) => {
    const session = await lockSessionRow(tx, input.companyId, input.sessionId);

    if (session.status === "finalized") {
      const stored = (session.finalizedResult ?? {}) as Partial<RetailStockCountFinalizeResult>;
      return {
        sessionId: session.id,
        status: "finalized",
        replayed: true,
        adjustedLineCount: Number(stored.adjustedLineCount ?? 0),
        movementCount: Number(stored.movementCount ?? 0),
        varianceLineCount: Number(stored.varianceLineCount ?? toNumber(session.varianceLineCount)),
        unexpectedLineCount: Number(stored.unexpectedLineCount ?? toNumber(session.unexpectedLineCount)),
        uncountedLineCount: Number(stored.uncountedLineCount ?? toNumber(session.uncountedLineCount)),
        varianceQuantityTotal: Number(stored.varianceQuantityTotal ?? toNumber(session.varianceQuantityTotal)),
        varianceValueTotal: Number(stored.varianceValueTotal ?? toNumber(session.varianceValueTotal)),
      } satisfies RetailStockCountFinalizeResult;
    }
    if (session.status === "canceled") {
      throw new RetailStockCountConflictError("Canceled stock counts cannot be finalized", "STOCK_COUNT_CANCELED");
    }
    if (session.status === "draft") {
      throw new RetailStockCountConflictError("Start the stock count before finalizing it", "STOCK_COUNT_NOT_STARTED");
    }

    const lines = await tx
      .select()
      .from(retailStockCountLines)
      .where(and(eq(retailStockCountLines.companyId, input.companyId), eq(retailStockCountLines.sessionId, session.id)))
      .orderBy(asc(retailStockCountLines.variantId));

    const uncounted = lines.filter((line) => line.countedQuantity === null);
    if (uncounted.length > 0 && !input.allowUncounted) {
      throw new RetailStockCountConflictError(
        `${uncounted.length} line(s) have not been counted. Count them, or finalize with allowUncounted to leave them unchanged.`,
        "STOCK_COUNT_UNCOUNTED_LINES",
        { uncountedLineCount: uncounted.length }
      );
    }

    const counted = lines.filter((line) => line.countedQuantity !== null);
    const varianceLines = counted.filter(
      (line) =>
        computeRetailStockCountLineStatus(toNumber(line.expectedQuantity), toNumber(line.countedQuantity)) !== "counted"
    );
    if (varianceLines.length > 0 && !input.confirmVariance) {
      throw new RetailStockCountConflictError(
        `${varianceLines.length} line(s) differ from the snapshot. Confirm the variance to finalize.`,
        "STOCK_COUNT_VARIANCE_UNCONFIRMED",
        { varianceLineCount: varianceLines.length }
      );
    }

    let movementCount = 0;
    let adjustedLineCount = 0;
    let varianceQuantityTotal = 0;
    let varianceValueTotal = 0;
    const now = new Date();
    // Wave 17 (D) Retail inventory ledger: from the Retail inventory opening on,
    // the value the count moves is journalled in this transaction (merge of main 365cf55).
    const stockValue = await trackRetailStockValueTx(tx, input.companyId, []);

    for (const line of counted) {
      const countedQuantity = toNumber(line.countedQuantity);
      const expectedQuantity = toNumber(line.expectedQuantity);
      const stock = await lockInventoryRow(tx, input.companyId, line.variantId, session.locationId);
      await stockValue.include([{ variantId: line.variantId, locationId: session.locationId }]);
      // A post-count sale, transfer or return must never be undone by writing the
      // stale physical quantity. Stock writers take this same inventory row lock.
      if (!line.countedAt) {
        throw new RetailStockCountConflictError(
          "Count timestamp is missing. Recount this line before finalizing.",
          "STOCK_COUNT_RECOUNT_REQUIRED",
          { lineId: line.id }
        );
      }
      const [laterMovement] = await tx
        .select({ id: retailStockMovements.id })
        .from(retailStockMovements)
        .where(
          and(
            eq(retailStockMovements.companyId, input.companyId),
            eq(retailStockMovements.locationId, session.locationId),
            eq(retailStockMovements.variantId, line.variantId),
            gte(retailStockMovements.createdAt, line.countedAt)
          )
        )
        .limit(1);
      if (laterMovement) {
        throw new RetailStockCountConflictError(
          "Stock moved after this line was counted. Recount the line before finalizing.",
          "STOCK_COUNT_RECOUNT_REQUIRED",
          { lineId: line.id, variantId: line.variantId }
        );
      }
      const outcome = finalizeRetailStockCountLine({
        expectedQuantity,
        countedQuantity,
        liveQuantity: stock.quantity,
      });
      if (outcome.needsMovement) {
        await setInventoryQuantity(tx, input.companyId, line.variantId, session.locationId, outcome.finalQuantity);
        await addMovement(tx, {
          companyId: input.companyId,
          variantId: line.variantId,
          locationId: session.locationId,
          movementType: "stock_count",
          quantityDelta: outcome.movementDelta,
          before: stock.quantity,
          after: outcome.finalQuantity,
          eventKey: `stock_count:${session.id}:${line.id}`,
          referenceType: "retail_stock_count",
          referenceId: session.id,
          createdBy: input.userId,
          metadata: {
            stockCountSessionId: session.id,
            stockCountLineId: line.id,
            sessionCode: session.code,
            expectedQuantity,
            countedQuantity,
            liveQuantity: stock.quantity,
            varianceQuantity: outcome.varianceQuantity,
          },
        });
        movementCount += 1;
        adjustedLineCount += 1;
      }
      const varianceQuantity = outcome.varianceQuantity;
      varianceQuantityTotal += varianceQuantity;
      varianceValueTotal += Math.abs(varianceQuantity) * Number(stock.averageCost ?? 0);
      await tx
        .update(retailStockCountLines)
        .set({
          status: computeRetailStockCountLineStatus(expectedQuantity, countedQuantity),
          expectedLiveQuantity: String(stock.quantity),
          varianceQuantity: String(varianceQuantity),
          movementDelta: String(outcome.movementDelta),
          countedAt: line.countedAt ?? now,
          updatedAt: now,
        })
        .where(eq(retailStockCountLines.id, line.id));
    }

    await stockValue.post({
      kind: "count",
      sourceId: session.id,
      description: `Retail stock count ${session.code}`,
      actor: { userId: input.userId },
    });

    if (uncounted.length > 0) {
      await tx
        .update(retailStockCountLines)
        .set({ expectedLiveQuantity: null, varianceQuantity: null, movementDelta: null, updatedAt: now })
        .where(
          inArray(
            retailStockCountLines.id,
            uncounted.map((line) => line.id)
          )
        );
    }

    const summary = summarizeRetailStockCountLines(
      counted.map((line) => ({
        expectedQuantity: toNumber(line.expectedQuantity),
        countedQuantity: toNumber(line.countedQuantity),
      }))
    );
    const unexpectedLineCount = summary.unexpectedLineCount;
    const varianceLineCount = summary.varianceLineCount;
    const result: RetailStockCountFinalizeResult = {
      sessionId: session.id,
      status: "finalized",
      replayed: false,
      adjustedLineCount,
      movementCount,
      varianceLineCount,
      unexpectedLineCount,
      uncountedLineCount: uncounted.length,
      varianceQuantityTotal,
      varianceValueTotal,
    };

    await tx
      .update(retailStockCountSessions)
      .set({
        status: "finalized",
        finalizedAt: now,
        finalizedBy: input.userId,
        notes: input.notes ? `${session.notes ? `${session.notes}\n` : ""}${input.notes}` : session.notes,
        varianceQuantityTotal: String(varianceQuantityTotal),
        varianceValueTotal: String(varianceValueTotal),
        finalizedResult: result as unknown as Record<string, unknown>,
        updatedAt: now,
      })
      .where(eq(retailStockCountSessions.id, session.id));
    await insertEvent(tx, {
      companyId: input.companyId,
      sessionId: session.id,
      userId: input.userId,
      eventType: "finalized",
      note: input.notes ?? null,
      metadata: { ...result, allowUncounted: Boolean(input.allowUncounted) },
    });
    await refreshSessionTotals(tx, input.companyId, session.id);
    return result;
  });
}

export { listRetailStockCountSessions, loadRetailStockCountVarianceReport, type RetailStockCountFilters };
export { loadRetailStockCountSession };

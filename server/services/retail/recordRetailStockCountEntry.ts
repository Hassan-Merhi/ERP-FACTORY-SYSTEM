// Extracted from ./retailStockCount.ts to keep that module under the source-size cap.
import { and, eq, inArray } from "drizzle-orm";
import { retailProducts, retailProductVariants, retailStockCountLines, retailStockCountSessions } from "@shared/schema";
import { db } from "../../db";
import {
  computeRetailStockCountLineStatus,
  nextRetailStockCountQuantity,
  type RetailStockCountEntryModeValue,
} from "./retailStockCountMath";
import {
  RetailStockCountConflictError,
  RetailStockCountValidationError,
  insertEvent,
  lockSessionRow,
  refreshSessionTotals,
  toNumber,
  withTransaction,
  type Transaction,
} from "./startRetailStockCountSession";
import { setSessionStatus } from "./recordRetailStockCountEntrySetSessionStatus";

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

/**
 * Retail Wave 2 physical stock-count sessions (Track D).
 *
 * Workflow: draft → counting → review → (recount → counting) → finalized, or canceled.
 * Finalization is a single transaction that locks the session, re-reads the live quantity
 * of every counted variant under the same inventory row lock every other stock writer
 * uses, and writes `stock_count` movements that reference the session. Nothing writes
 * inventory without a movement.
 */
import { and, asc, eq, gte, inArray } from "drizzle-orm";
import { retailStockCountLines, retailStockCountSessions, retailStockMovements } from "@shared/schema";
import { db } from "../../db";
import { addMovement, lockInventoryRow, setInventoryQuantity } from "./retailStockLedger";
import { trackRetailStockValueTx } from "./retailInventoryJournal";
import {
  computeRetailStockCountLineStatus,
  finalizeRetailStockCountLine,
  summarizeRetailStockCountLines,
} from "./retailStockCountMath";
import {
  listRetailStockCountSessions,
  loadRetailStockCountSession,
  loadRetailStockCountVarianceReport,
  type RetailStockCountFilters,
} from "./retailStockCountQueries";
import {
  RetailStockCountConflictError,
  insertEvent,
  lockSessionRow,
  refreshSessionTotals,
  toNumber,
} from "./startRetailStockCountSession";
import type { RetailStockCountFinalizeResult } from "./retailStockCountCancelRetailStockCount";
export { cancelRetailStockCount, type RetailStockCountFinalizeResult } from "./retailStockCountCancelRetailStockCount";
export {
  RetailStockCountConflictError,
  RetailStockCountValidationError,
  createRetailStockCountSession,
  startRetailStockCountSession,
} from "./startRetailStockCountSession";
export {
  moveRetailStockCountToReview,
  recordRetailStockCountEntry,
  recountRetailStockCountLines,
  updateRetailStockCountLine,
} from "./recordRetailStockCountEntry";

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

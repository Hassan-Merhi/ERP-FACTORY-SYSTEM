// Extracted from ./recordRetailStockCountEntry.ts
import { eq } from "drizzle-orm";
import { retailStockCountSessions } from "@shared/schema";
import { db } from "../../db";
import {
  RetailStockCountConflictError,
  insertEvent,
  lockSessionRow,
  refreshSessionTotals,
} from "./startRetailStockCountSession";

export async function setSessionStatus(
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

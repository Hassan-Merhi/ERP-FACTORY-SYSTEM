// Extracted from ./retailStockCount.ts
import { eq } from "drizzle-orm";
import { retailStockCountSessions } from "@shared/schema";
import { db } from "../../db";
import { RetailStockCountConflictError, insertEvent, lockSessionRow } from "./startRetailStockCountSession";

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

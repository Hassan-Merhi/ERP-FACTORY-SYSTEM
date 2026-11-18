// Extracted from ./rawStockReverseOffloadRoute.ts to keep that module under the source-size cap.
import type { Request, Response } from "express";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { factoryContainers, factoryMixBatches, factoryMixBatchSources } from "@shared/schema";
import { type DatabaseOrTransaction, db } from "../../../db";
import { parseId } from "../../../lib/parseId";
import { resolveOptionalFinancialOperationKey } from "../../../services/accounting/financialOperationRequest";

export const REVERSAL_STATUS_MESSAGE = "Only OFFLOADED or PARTIALLY_RECEIVED containers can be reversed";

export const REVERSAL_SUCCESS_MESSAGE = "Offload reversed successfully. Container is back to its previous status.";

export function isReversibleStatus(status: string | null | undefined): boolean {
  return status === "OFFLOADED" || status === "PARTIALLY_RECEIVED";
}

/** Carries the caller's status through the reversal so the error can be typed. */
export class ReverseOffloadError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ReverseOffloadError";
  }
}

export type ReverseOffloadOutcome = { message: string; containerStatus: string | null };

export function consumingMixBatchMessage(codes: string[]): string {
  return `Cannot reverse offload: stock from this container has already been consumed in mix batch(es) ${codes.join(", ")}. Remove it from those batches first before reversing.`;
}

/**
 * Batch codes that have already consumed this container's raw stock in
 * production. Run against the same executor as the reversal so the check inside
 * the transaction sees what the reversal is about to undo.
 */
export async function findConsumingMixBatchCodes(
  executor: DatabaseOrTransaction,
  companyId: number,
  containerId: number
): Promise<string[]> {
  const mixSourceLinks = await executor
    .select({ mixBatchId: factoryMixBatchSources.mixBatchId })
    .from(factoryMixBatchSources)
    .where(eq(factoryMixBatchSources.containerId, containerId));

  if (mixSourceLinks.length === 0) return [];

  const linkedBatchIds = [...new Set(mixSourceLinks.map((link) => link.mixBatchId))];
  const usedBatches = await executor
    .select({ batchCode: factoryMixBatches.batchCode })
    .from(factoryMixBatches)
    .where(
      and(
        eq(factoryMixBatches.companyId, companyId),
        inArray(factoryMixBatches.id, linkedBatchIds),
        sql`${factoryMixBatches.usedKg}::numeric > 0`,
        // A soft-deleted batch no longer holds live production usage — its
        // consumption of this container's stock was already reversed by the
        // delete route (factoryMixBatchRoutes.ts). Without this filter, a
        // deleted batch's stale, never-reset usedKg field permanently blocks
        // reversing the offload even though nothing is actually consuming the
        // stock anymore.
        isNull(factoryMixBatches.deletedAt)
      )
    );

  return usedBatches.map((batch) => batch.batchCode);
}

export async function handlePostFactoryContainersIdReverseOffloadStep1(req: Request, res: Response) {
  // factoryCompanyId is not declared on SessionData; the cast stays until it is.
  const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
  if (!companyId) return { done: true as const, value: res.status(400).json({ message: "No company selected" }) };

  const containerId = parseId(req.params.id);

  if (containerId === null) return { done: true as const, value: res.status(400).json({ message: "Invalid id" }) };

  const [container] = await db
    .select()
    .from(factoryContainers)
    .where(and(eq(factoryContainers.id, containerId), eq(factoryContainers.companyId, companyId)));

  if (!container) return { done: true as const, value: res.status(404).json({ message: "Container not found" }) };
  if (!isReversibleStatus(container.status)) {
    return { done: true as const, value: res.status(400).json({ message: REVERSAL_STATUS_MESSAGE }) };
  }

  // Early, unlocked copy of the consumption guard so the common rejection does
  // not open a transaction. It is repeated on the locked row below, which is
  // the check that actually decides anything.
  const earlyBlockedBy = await findConsumingMixBatchCodes(db, companyId, containerId);
  if (earlyBlockedBy.length > 0) {
    return { done: true as const, value: res.status(400).json({ message: consumingMixBatchMessage(earlyBlockedBy) }) };
  }

  const requestId = resolveOptionalFinancialOperationKey(req);
  return { done: false as const, companyId, containerId, requestId };
}

/**
 * Pure, deterministic batch-decision planning. No DB, stock movement,
 * WhatsApp or session dependencies: straightforward to unit-test.
 */
export type StockTransferOrderWaFrozenRevision = {
  transfer_id: number;
  revision_id: number;
  revision_number_snapshot: number;
};

export class StockTransferOrderWaDecisionPlanError extends Error {
  readonly code = "STO_WA_REVISION_SCOPE";
  constructor(message: string) {
    super(message);
    this.name = "StockTransferOrderWaDecisionPlanError";
  }
}

/**
 * Pick exactly one representative per selected transfer, since the existing
 * approval lifecycle merges ALL of that transfer's pending location revisions.
 * A revision from an unselected transfer is always an error.
 */
export function chooseStockTransferOrderWaApprovalLeaders(
  transferIds: readonly number[],
  revisions: readonly StockTransferOrderWaFrozenRevision[],
): Map<number, number> {
  const expected = new Set(transferIds);
  if (!transferIds.length || expected.size !== transferIds.length ||
      transferIds.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new StockTransferOrderWaDecisionPlanError("A batch must include distinct valid order IDs.");
  }
  const leaders = new Map<number, StockTransferOrderWaFrozenRevision>();
  for (const revision of revisions) {
    if (!expected.has(revision.transfer_id) ||
        !Number.isSafeInteger(revision.revision_id) || revision.revision_id <= 0 ||
        !Number.isSafeInteger(revision.revision_number_snapshot) || revision.revision_number_snapshot < 1) {
      throw new StockTransferOrderWaDecisionPlanError("Frozen revision does not belong to the selected orders.");
    }
    const current = leaders.get(revision.transfer_id);
    if (!current ||
        revision.revision_number_snapshot > current.revision_number_snapshot ||
        (revision.revision_number_snapshot === current.revision_number_snapshot &&
          revision.revision_id > current.revision_id)) {
      leaders.set(revision.transfer_id, revision);
    }
  }
  if ([...expected].some(id => !leaders.has(id))) {
    throw new StockTransferOrderWaDecisionPlanError("Every selected order needs a pending revision.");
  }
  return new Map([...leaders].map(([transferId, revision]) => [transferId, revision.revision_id]));
}

/** Distinguish safe domain refusals from infrastructure errors that must retry. */
export function stockTransferOrderWaBusinessConflictCode(error: unknown): string | null {
  const code = String((error as { code?: string })?.code ?? "");
  return [
    "STO_WA_BATCH_STALE", "STO_WA_AUTH_CHANGED", "STO_WA_DESTINATION_CHANGED",
    "STO_WA_BATCH_INACTIVE", "STO_WA_REVISION_SCOPE",
    "STOCK_TRANSFER_REVISION_STALE", "STOCK_TRANSFER_REVISION_STATUS",
    "STOCK_TRANSFER_REVISION_SCOPE", "STOCK_TRANSFER_INSUFFICIENT_STOCK",
    "STOCK_TRANSFER_DESTINATION_STOCK_CONFLICT",
  ].includes(code) ? code : null;
}

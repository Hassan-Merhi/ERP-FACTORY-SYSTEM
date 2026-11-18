import { db, type DbTransaction } from "../../../db";
import { ContainerOffloadLifecycleInput, ContainerOffloadLifecycleResult, positiveIds } from "./types";
import type { OffloadCostCorrectionApprover } from "./assertOffloadCurrencyValuedTx";
import { executeContainerOffloadLifecycleTxStep1 } from "./executeContainerOffloadLifecycleTxStep1";
import { executeContainerOffloadLifecycleTxStep2 } from "./executeContainerOffloadLifecycleTxStep2";
export {
  OFFLOAD_BEFORE_CUTOVER_CODE,
  OFFLOAD_BEFORE_CUTOVER_MESSAGE,
  OFFLOAD_COST_CORRECTION_FORBIDDEN_CODE,
  OFFLOAD_COST_CORRECTION_FORBIDDEN_MESSAGE,
  OFFLOAD_CURRENCY_UNCONFIRMED_CODE,
  OFFLOAD_CURRENCY_UNCONFIRMED_MESSAGE,
} from "./assertOffloadCurrencyValuedTx";
export type { OffloadCostCorrectionApprover } from "./assertOffloadCurrencyValuedTx";

export async function executeContainerOffloadLifecycle(
  input: ContainerOffloadLifecycleInput & OffloadCostCorrectionApprover,
  /**
   * Runs inside the offload transaction after it succeeded; a throw rolls the
   * whole offload back (used by the factory LAN capture of offline receipts).
   */
  afterOffloadTx?: (tx: DbTransaction, result: ContainerOffloadLifecycleResult) => Promise<void>
): Promise<ContainerOffloadLifecycleResult> {
  return db.transaction(async (tx) => {
    const result = await executeContainerOffloadLifecycleTx(tx, input);
    if (afterOffloadTx) await afterOffloadTx(tx, result);
    return result;
  });
}

/**
 * The offload lifecycle on the caller's transaction (the Phase 9 cloud replay
 * of a factory LAN receipt runs it on the same transaction as its receipt).
 */
export async function executeContainerOffloadLifecycleTx(
  tx: DbTransaction,
  input: ContainerOffloadLifecycleInput & OffloadCostCorrectionApprover
): Promise<ContainerOffloadLifecycleResult> {
  const {
    additionalCostPerBale,
    container,
    correctionLines,
    entries,
    existingOffload,
    lineItems,
    previousBeforeCutover,
    previousOffloadDate,
    purchaseOrders,
    replacing,
    requestsCorrection,
    roundingDifference,
    storedItems,
    totalBales,
    totalCharges,
    validCorrectionIds,
  } = await executeContainerOffloadLifecycleTxStep1(tx, input);
  const { offload } = await executeContainerOffloadLifecycleTxStep2(
    {
      additionalCostPerBale,
      container,
      correctionLines,
      entries,
      existingOffload,
      lineItems,
      previousBeforeCutover,
      previousOffloadDate,
      purchaseOrders,
      requestsCorrection,
      roundingDifference,
      storedItems,
      totalBales,
      totalCharges,
      validCorrectionIds,
    },
    tx,
    input
  );

  return {
    offload,
    companyId: input.companyId,
    locationId: input.locationId,
    stockItemIds: positiveIds(storedItems.map((item) => item.stockItemId)),
    replacedExistingOffload: replacing,
  };
}

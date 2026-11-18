// Extracted from ./historicalSalesCostPartialApply.ts to keep that module under the source-size cap.

export type PartialRollbackResult = {
  runId: number;
  partialApplyId: number;
  restoredRows: number;
  alreadyRolledBack: boolean;
};

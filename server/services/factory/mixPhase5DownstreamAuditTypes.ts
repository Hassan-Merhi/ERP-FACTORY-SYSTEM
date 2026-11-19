// Extracted from ./mixPhase5DownstreamAudit.ts

export interface DbBatchLine {
  id: number;
  batch_code: string;
  batch_date: string | null;
  status: string;
  deleted_at: string | null;
  total_weight_kg: string;
  used_kg: string;
  total_cost: string;
  cost_per_kg: string;
  linked_bales: string;
  linked_bale_cost_usd: string;
  linked_pressing_batches: string;
  linked_daily_usages: string;
  mismatch_bales: string;
}

export interface DbBaleTotals {
  total: string;
  active_rows: string;
  linked_to_mix: string;
  linked_via_pressing: string;
  missing_mix_link: string;
  sold: string;
  dispatched: string;
  in_stock: string;
  finished_stock_value_usd: string;
  linked_cost_mismatch: string;
  linked_total_abs_difference_usd: string;
}

export interface DbLedgerState {
  effective_from: string | null;
  status: string | null;
  opening_voucher_id: number | null;
  replay_undo_runs: string;
  prior_recost_runs: string;
  prior_recost_linked_vouchers: string;
  factory_stock_value_events: string;
}

export interface DbSaleLinks {
  ordered_bales: string;
  invoiced_loading_bales: string;
  pos_sale_bales: string;
}

export type DownstreamLineageClassification =
  | "DELETED_HISTORY"
  | "NO_RECORDED_PRODUCTION_LINEAGE"
  | "LINKED_BALE_COST_MISMATCH"
  | "LINKED_PRODUCTION_EVIDENCE"
  | "NOT_YET_CONSUMED";

export interface Phase5MixBatchLine {
  batchId: number;
  batchCode: string;
  batchDate: string | null;
  status: string;
  deleted: boolean;
  totalKg: string;
  usedKg: string;
  remainingKg: string;
  recordedUsd: string;
  recordedRateUsdPerKg: string;
  baleCount: number;
  pressingRecordCount: number;
  dailyUsageCount: number;
  recordedLinkedBaleCostUsd: string;
  mismatchedLinkedBales: number;
  classification: DownstreamLineageClassification;
  correctionDecision: "BLOCK_HISTORICAL_REPRICE" | "REVIEW_ONLY";
}

export interface Phase5DownstreamReconciliation {
  companyId: number;
  generatedAt: string;
  readOnly: true;
  summary: {
    activeMixBatches: number;
    deletedMixBatches: number;
    consumedMixesWithoutLineage: number;
    totalUsedMixKgWithoutLineage: string;
    batchesWithDownstreamLineage: number;
    activeBaleRows: number;
    unlinkedBaleRows: number;
    balesLinkedDirectlyToMix: number;
    balesLinkedViaPressing: number;
    soldBales: number;
    dispatchedBales: number;
    inStockBales: number;
    finishedGoodsSavedValueUsd: string;
    baleCostMismatchRows: number;
    linkedBaleAbsoluteValueDifferenceUsd: string;
    orderLinkedBales: number;
    invoiceLoadingLinkedBales: number;
    posSaleLinkedBales: number;
    inventoryCutoverActive: boolean;
    inventoryCutoverEffectiveFrom: string | null;
    historicalBaleRecostRuns: number;
    historicalBaleRecostVouchers: number;
    historicalReplayUndoRuns: number;
    factoryValueEvents: number;
  };
  batches: Phase5MixBatchLine[];
  recommendations: string[];
}

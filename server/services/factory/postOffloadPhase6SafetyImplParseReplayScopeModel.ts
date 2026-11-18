// Extracted from ./postOffloadPhase6SafetyImplParseReplayScope.ts
import {
  type ExactReplaySnapshot,
  type HistoricalReplayPreviewResult,
  type ReplayWriteScope,
} from "./historicalCostReplay";
import {
  evaluateHistoricalReplaySafetyReadiness,
  inspectHistoricalReplayProductionSchema,
} from "./historical-replay/productionReadinessV8";

export const PHASE6_TOKEN_KIND = "POST_OFFLOAD_PHASE6_REPAIR_V1" as const;

export const PHASE6_TOKEN_VERSION = 1 as const;

export const EXACT_UNDO_KIND = "HISTORICAL_REPLAY_EXACT_V1" as const;

export type PostOffloadPhase6Status = "ready" | "repair_required" | "blocked";

export interface PostOffloadPhase6Integrity {
  activeCharges: number;
  deletedCharges: number;
  unresolvedFxCharges: number;
  missingDaybookLinks: number;
  missingVoucherLinks: number;
  incompleteVoucherCurrencyRows: number;
  missingReversalLinks: number;
  rawStockCostDriftRows: number;
  maxRawStockCostDriftUsdPerKg: string;
  issueCount: number;
}

export interface PostOffloadPhase6ScopeCounts {
  suppliers: number;
  containers: number;
  rawStockRows: number;
  supplierSources: number;
  batches: number;
  availableBales: number;
  finalizedBalesExcluded: number;
  blockedBatches: number;
  supplierRateChanges: number;
  actualChangeRows: number;
  totalWritableRows: number;
}

export interface PostOffloadPhase6Readiness {
  phase: 6;
  generatedAt: string;
  companyId: number;
  status: PostOffloadPhase6Status;
  algorithmVersion: string;
  readinessVersion: string;
  productionControl: {
    enabled: boolean;
    releaseId: string | null;
    configurationErrors: string[];
  };
  schema: Awaited<ReturnType<typeof inspectHistoricalReplayProductionSchema>>;
  safety: ReturnType<typeof evaluateHistoricalReplaySafetyReadiness>;
  integrity: PostOffloadPhase6Integrity;
  postOffloadSupplierIds: number[];
  selectedSupplierIds: number[];
  scope: PostOffloadPhase6ScopeCounts;
  fingerprint: string | null;
  stateFingerprint: string;
  latestUndo: {
    id: number;
    algorithmVersion: string | null;
    scopeFingerprint: string | null;
    appliedAt: string;
    undoneAt: string | null;
  } | null;
  automaticRepairEligible: boolean;
  blockers: string[];
  reportQueryKeys: readonly string[];
}

export interface PreparedPostOffloadPhase6Repair {
  dryRun: true;
  status: PostOffloadPhase6Status;
  confirmationToken: string | null;
  expiresInMs: number | null;
  readiness: PostOffloadPhase6Readiness;
  frozenScope: ReplayWriteScope;
  frozenOptions: {
    includeCompletedBatches: true;
    includeFinalizedBales: false;
  };
  instructions: string;
}

export interface PostOffloadPhase6TokenPayload {
  kind: typeof PHASE6_TOKEN_KIND;
  version: typeof PHASE6_TOKEN_VERSION;
  purpose: "POST_OFFLOAD_HISTORICAL_COST_REPAIR";
  companyId: number;
  userId: string;
  releaseId: string;
  algorithmVersion: string;
  readinessVersion: string;
  supplierIds: number[];
  scope: ReplayWriteScope;
  scopeRowCount: number;
  fingerprint: string;
  stateFingerprint: string;
  includeCompletedBatches: true;
  includeFinalizedBales: false;
  issuedAt: number;
  expiresAt: number;
}

export interface ExactReplayUndoEnvelope {
  kind: typeof EXACT_UNDO_KIND;
  algorithmVersion: string;
  fingerprint: string;
  includeCompletedBatches: boolean;
  includeFinalizedBales: boolean;
  scope: ReplayWriteScope;
  baleIds: number[];
  before: ExactReplaySnapshot;
  after: ExactReplaySnapshot;
}

export interface IntegrityRow {
  active_charges: string;
  deleted_charges: string;
  unresolved_fx_charges: string;
  missing_daybook_links: string;
  missing_voucher_links: string;
  incomplete_voucher_currency_rows: string;
  missing_reversal_links: string;
  raw_stock_cost_drift_rows: string;
  max_raw_stock_cost_drift: string | null;
}

export interface LatestUndoRow {
  id: number;
  algorithm_version: string | null;
  scope_fingerprint: string | null;
  applied_at: Date | string;
  undone_at: Date | string | null;
}

export interface Phase6Snapshot {
  readiness: PostOffloadPhase6Readiness;
  preview: HistoricalReplayPreviewResult | null;
  scope: ReplayWriteScope;
}

// Extracted from ./postOffloadPhase6SafetyImpl.ts to keep that module under the source-size cap.
import crypto from "node:crypto";
import Decimal from "decimal.js";
import {
  type ExactReplaySnapshot,
  type HistoricalReplayPreviewResult,
  normalizeReplayWriteScope,
  type ReplayWriteScope,
} from "./historicalCostReplay";
import {
  evaluateHistoricalReplaySafetyReadiness,
  inspectHistoricalReplayProductionSchema,
} from "./historical-replay/productionReadinessV8";

export const PHASE6_TOKEN_KIND = "POST_OFFLOAD_PHASE6_REPAIR_V1" as const;

export const PHASE6_TOKEN_VERSION = 1 as const;

export const EXACT_UNDO_KIND = "HISTORICAL_REPLAY_EXACT_V1" as const;

export const INCLUDE_COMPLETED_BATCHES = true;

export const INCLUDE_FINALIZED_BALES = false;

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

export class InvalidPostOffloadPhase6TokenError extends Error {
  readonly code = "POST_OFFLOAD_PHASE6_TOKEN_INVALID";
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "InvalidPostOffloadPhase6TokenError";
  }
}

export class StalePostOffloadPhase6TokenError extends Error {
  readonly code = "POST_OFFLOAD_PHASE6_TOKEN_STALE";
  readonly statusCode = 409;
  constructor(message = "Post-offload repair state changed after preview. Re-run the dry-run plan.") {
    super(message);
    this.name = "StalePostOffloadPhase6TokenError";
  }
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function stableHash(value: unknown): string {
  return sha256(JSON.stringify(value));
}

export function uniqueSortedNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

export function requestedSupplierIds(value: unknown): number[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new InvalidPostOffloadPhase6TokenError("supplierIds must be an array of positive integers.");
  }
  const parsed = value.map((item) => Number(item));
  if (parsed.some((item) => !Number.isInteger(item) || item <= 0)) {
    throw new InvalidPostOffloadPhase6TokenError("supplierIds must contain only positive integers.");
  }
  return uniqueSortedNumbers(parsed);
}

export function emptyScope(): ReplayWriteScope {
  return {
    supplierIds: [],
    containerIdsToUpdate: [],
    rawStockIdsToUpdate: [],
    sourceIdsToUpdate: [],
    batchIdsToUpdate: [],
    availableBaleIdsToUpdate: [],
    finalizedBaleIdsToUpdate: [],
    blockedBatches: [],
  };
}

export function count(value: string | number | null | undefined): number {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function decimal(value: string | number | null | undefined): Decimal {
  try {
    const parsed = new Decimal(value ?? 0);
    return parsed.isFinite() ? parsed : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
}

export function scopeCounts(scope: ReplayWriteScope, supplierRateChanges = 0): PostOffloadPhase6ScopeCounts {
  const nonSupplierChangeRows =
    scope.containerIdsToUpdate.length +
    scope.rawStockIdsToUpdate.length +
    scope.sourceIdsToUpdate.length +
    scope.batchIdsToUpdate.length +
    scope.availableBaleIdsToUpdate.length;
  const totalWritableRows =
    scope.containerIdsToUpdate.length +
    scope.rawStockIdsToUpdate.length +
    scope.sourceIdsToUpdate.length +
    scope.batchIdsToUpdate.length +
    scope.availableBaleIdsToUpdate.length +
    scope.supplierIds.length;
  return {
    suppliers: scope.supplierIds.length,
    containers: scope.containerIdsToUpdate.length,
    rawStockRows: scope.rawStockIdsToUpdate.length,
    supplierSources: scope.sourceIdsToUpdate.length,
    batches: scope.batchIdsToUpdate.length,
    availableBales: scope.availableBaleIdsToUpdate.length,
    finalizedBalesExcluded: scope.finalizedBaleIdsToUpdate.length,
    blockedBatches: scope.blockedBatches.length,
    supplierRateChanges,
    actualChangeRows: nonSupplierChangeRows + supplierRateChanges,
    totalWritableRows,
  };
}

function parseNumberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const values = value.map((item) => Number(item));
  if (values.some((item) => !Number.isInteger(item) || item <= 0)) return null;
  return uniqueSortedNumbers(values);
}

export function parseReplayScope(value: unknown): ReplayWriteScope | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const supplierIds = parseNumberArray(input.supplierIds);
  const containerIdsToUpdate = parseNumberArray(input.containerIdsToUpdate);
  const rawStockIdsToUpdate = parseNumberArray(input.rawStockIdsToUpdate);
  const sourceIdsToUpdate = parseNumberArray(input.sourceIdsToUpdate);
  const batchIdsToUpdate = parseNumberArray(input.batchIdsToUpdate);
  const availableBaleIdsToUpdate = parseNumberArray(input.availableBaleIdsToUpdate);
  const finalizedBaleIdsToUpdate = parseNumberArray(input.finalizedBaleIdsToUpdate);
  if (
    !supplierIds ||
    !containerIdsToUpdate ||
    !rawStockIdsToUpdate ||
    !sourceIdsToUpdate ||
    !batchIdsToUpdate ||
    !availableBaleIdsToUpdate ||
    !finalizedBaleIdsToUpdate ||
    !Array.isArray(input.blockedBatches)
  ) {
    return null;
  }
  const blockedBatches: ReplayWriteScope["blockedBatches"] = [];
  for (const raw of input.blockedBatches) {
    if (!raw || typeof raw !== "object") return null;
    const row = raw as Record<string, unknown>;
    if (
      typeof row.batchId !== "number" ||
      !Number.isInteger(row.batchId) ||
      typeof row.batchCode !== "string" ||
      !Array.isArray(row.reasons) ||
      row.reasons.some((reason) => typeof reason !== "string")
    ) {
      return null;
    }
    blockedBatches.push({
      batchId: Number(row.batchId),
      batchCode: row.batchCode,
      reasons: [...new Set(row.reasons as string[])].sort(),
    });
  }
  return normalizeReplayWriteScope({
    supplierIds,
    containerIdsToUpdate,
    rawStockIdsToUpdate,
    sourceIdsToUpdate,
    batchIdsToUpdate,
    availableBaleIdsToUpdate,
    finalizedBaleIdsToUpdate,
    blockedBatches,
  });
}

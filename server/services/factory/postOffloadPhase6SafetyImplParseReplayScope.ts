// Extracted from ./postOffloadPhase6SafetyImpl.ts to keep that module under the source-size cap.
import crypto from "node:crypto";
import Decimal from "decimal.js";
import { normalizeReplayWriteScope, type ReplayWriteScope } from "./historicalCostReplay";
import type { PostOffloadPhase6ScopeCounts } from "./postOffloadPhase6SafetyImplParseReplayScopeModel";
export {
  PHASE6_TOKEN_KIND,
  PHASE6_TOKEN_VERSION,
  EXACT_UNDO_KIND,
  type PostOffloadPhase6Status,
  type PostOffloadPhase6Integrity,
  type PostOffloadPhase6ScopeCounts,
  type PostOffloadPhase6Readiness,
  type PreparedPostOffloadPhase6Repair,
  type PostOffloadPhase6TokenPayload,
  type ExactReplayUndoEnvelope,
  type IntegrityRow,
  type LatestUndoRow,
  type Phase6Snapshot,
} from "./postOffloadPhase6SafetyImplParseReplayScopeModel";

export const INCLUDE_COMPLETED_BATCHES = true;

export const INCLUDE_FINALIZED_BALES = false;

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

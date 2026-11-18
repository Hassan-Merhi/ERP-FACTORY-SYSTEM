import { db } from "./db";
import { _inProgress, _lastPreparedAt, buildPacks } from "./offlinePrepBuildPacks";
export type { DatasetResult, DatasetSpec, PrepPack, PrepProgress } from "./offlinePrepBuildPacks";
export { runOfflinePrep } from "./runOfflinePrep";

export interface OfflineReadiness {
  ready: boolean;
  partial: boolean;
  preparedAt: number | null;
  completedDatasets: number;
  totalDatasets: number;
  errors: string[];
  packSummary: Record<string, { label: string; count: number; completedAt: number }>;
}

/**
 * Returns the Unix timestamp (ms) of the last completed offline preparation
 * for the given company, or null if never prepared.
 */
export function getLastOfflinePrepTime(companyId: number): number | null {
  return _lastPreparedAt.get(companyId) ?? null;
}

/**
 * Returns true if offline preparation is currently running for the given company.
 */
export function isOfflinePrepInProgress(companyId: number): boolean {
  return _inProgress.get(companyId) === true;
}

// ─── Query Readiness ──────────────────────────────────────────────────────────

export async function getOfflineReadiness(): Promise<OfflineReadiness> {
  try {
    const meta = await db.offlineMeta.where("key").equals("main").first();
    if (!meta) {
      return {
        ready: false,
        partial: false,
        preparedAt: null,
        completedDatasets: 0,
        totalDatasets: 0,
        errors: [],
        packSummary: {},
      };
    }
    const packSummary = JSON.parse(meta.packSummary || "{}");
    const errors = JSON.parse(meta.errors || "[]");
    return {
      ready: meta.status === "ready",
      partial: meta.status === "partial",
      preparedAt: meta.preparedAt,
      completedDatasets: meta.completedDatasets,
      totalDatasets: meta.totalDatasets,
      errors,
      packSummary,
    };
  } catch {
    return {
      ready: false,
      partial: false,
      preparedAt: null,
      completedDatasets: 0,
      totalDatasets: 0,
      errors: [],
      packSummary: {},
    };
  }
}

export { buildPacks };

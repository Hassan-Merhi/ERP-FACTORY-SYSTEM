// Extracted from ./offlinePrepBuildPacks.ts
import { asRecord, isRecord } from "@shared/typeGuards";
import { type CachedEntity, db } from "./db";

export interface DatasetSpec {
  id: string;
  label: string;
  endpoint: string;
  /** Dexie table key on `db` to bulk-save CachedEntities into, or null = offlinePackages */
  tableKey: keyof typeof db | null;
  /**
   * Extract the cacheable items from an API response.
   *
   * The payload comes straight off the network and the endpoints do not agree
   * on a wrapper shape, so it stays `unknown` and is narrowed by the helpers
   * below rather than being asserted into a row type this module never checked.
   */
  extractItems: (data: unknown, companyId: number) => CachedEntity[];
}

export interface PrepPack {
  id: string;
  label: string;
  datasets: DatasetSpec[];
}

export interface DatasetResult {
  datasetId: string;
  label: string;
  packId: string;
  success: boolean;
  count: number;
  error?: string;
}

export interface PrepProgress {
  phase: "idle" | "sw" | "preparing" | "verifying" | "done" | "error";
  currentLabel: string;
  totalDatasets: number;
  completedDatasets: number;
  failedDatasets: number;
  percent: number;
  results: DatasetResult[];
  errors: string[];
}

/** One item from a cached payload: an object whose individual fields are untrusted. */
export type CachedItem = Record<string, unknown>;

export function extractArray(data: unknown): CachedItem[] {
  if (Array.isArray(data)) return data.filter(isRecord);
  // Common wrapper shapes
  for (const key of [
    "items",
    "data",
    "results",
    "rows",
    "records",
    "containers",
    "suppliers",
    "customers",
    "stock",
    "rawStock",
    "bales",
    "products",
    "accounts",
    "suppliers",
    "categories",
  ]) {
    const wrapped = asRecord(data)?.[key];
    if (Array.isArray(wrapped)) return wrapped.filter(isRecord);
  }
  // Single object — wrap it
  if (isRecord(data)) return [data];
  return [];
}

export const _inProgress = new Map<number, boolean>();

export const _lastPreparedAt = new Map<number, number>();

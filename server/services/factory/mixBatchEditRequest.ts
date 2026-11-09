/**
 * Phase 2: strict source-edit inputs and the same-source check.
 *
 * This module never writes inventory. Source prices supplied by the browser
 * are intentionally ignored: the server resolves USD rates independently.
 */
import { createHash } from "node:crypto";
import { MoneyDecimal, toMoney } from "../../lib/money";

export interface MixEditSourceInput {
  supplierId?: number;
  sourceBatchId?: number;
  weightKg: string;
}

export interface MixEditSelection {
  supplierSources: MixEditSourceInput[];
  batchSources: MixEditSourceInput[];
  totalWeightKg: string;
}

export interface PersistedMixEditSource {
  supplierId: number | null;
  sourceBatchId: number | null;
  weightKg: string;
}

export class MixEditRequestError extends Error {
  constructor(
    message: string,
    readonly code = "MIX_EDIT_INVALID_SOURCES",
    readonly status = 400,
  ) {
    super(message);
    this.name = "MixEditRequestError";
  }
}

function parseRows(rows: unknown, idField: "supplierId" | "sourceBatchId"): MixEditSourceInput[] {
  if (!Array.isArray(rows) || rows.length > 100) {
    throw new MixEditRequestError("Source lists must be arrays of at most 100 rows.");
  }
  const seen = new Set<number>();
  return rows.map((raw) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new MixEditRequestError("Each source must be an object.");
    }
    const row = raw as Record<string, unknown>;
    const id = row[idField];
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      throw new MixEditRequestError(`Invalid ${idField}.`);
    }
    if (seen.has(Number(id))) {
      throw new MixEditRequestError(`Duplicate ${idField} is not allowed; combine the weights.`);
    }
    seen.add(Number(id));
    const rawWeight = row.weightKg;
    if (typeof rawWeight !== "string" && typeof rawWeight !== "number") {
      throw new MixEditRequestError("Source weight must be a positive kg amount.");
    }
    const weightText = String(rawWeight).trim();
    if (!/^\d{1,12}(?:\.\d{1,3})?$/.test(weightText)) {
      throw new MixEditRequestError("Source weights must be positive with at most 3 decimal places.");
    }
    const weight = toMoney(weightText);
    if (!weight.isFinite() || weight.lessThanOrEqualTo(0)) {
      throw new MixEditRequestError("Each source weight must be greater than zero.");
    }
    return { [idField]: Number(id), weightKg: weight.toFixed(3) };
  });
}

export function parseMixEditSelection(body: Record<string, unknown>): MixEditSelection {
  if (body.supplierSources === undefined || body.batchSources === undefined) {
    throw new MixEditRequestError("Both supplierSources and batchSources arrays are required for source edits.");
  }
  const supplierSources = parseRows(body.supplierSources, "supplierId");
  const batchSources = parseRows(body.batchSources, "sourceBatchId");
  if (supplierSources.length + batchSources.length === 0) {
    throw new MixEditRequestError("At least one material source is required.");
  }
  const weight = [...supplierSources, ...batchSources].reduce(
    (sum, source) => sum.plus(source.weightKg),
    new MoneyDecimal(0),
  );
  return { supplierSources, batchSources, totalWeightKg: weight.toFixed(3) };
}

export function sameMixEditSources(
  oldSources: readonly PersistedMixEditSource[],
  proposed: MixEditSelection,
): boolean {
  const old = new Map<string, ReturnType<typeof toMoney>>();
  for (const source of oldSources) {
    const key = source.sourceBatchId != null
      ? `batch:${source.sourceBatchId}`
      : source.supplierId != null ? `supplier:${source.supplierId}` : null;
    if (key === null) return false; // Don't silently erase unmapped or container-only sources.
    old.set(key, (old.get(key) ?? new MoneyDecimal(0)).plus(source.weightKg));
  }
  const next = new Map<string, ReturnType<typeof toMoney>>();
  for (const source of proposed.supplierSources) {
    const key = `supplier:${source.supplierId}`;
    next.set(key, (next.get(key) ?? new MoneyDecimal(0)).plus(source.weightKg));
  }
  for (const source of proposed.batchSources) {
    const key = `batch:${source.sourceBatchId}`;
    next.set(key, (next.get(key) ?? new MoneyDecimal(0)).plus(source.weightKg));
  }
  return old.size === next.size && [...old.entries()].every(([key, weight]) => weight.eq(next.get(key) ?? -1));
}

/** Optimistic concurrency proof bound to old sources, proposed inputs and live rates. */
export function mixEditReviewHash(snapshot: unknown): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

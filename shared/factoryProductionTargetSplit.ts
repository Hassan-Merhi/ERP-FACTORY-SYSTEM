/**
 * Distribute one fixed bale target across workers when a production link ends.
 * Whole targets split in whole bales; existing fractional targets split to
 * hundredths (the database column's scale). No duplicated targets.
 */
export interface WorkerBaleAllocation {
  workerId: number;
  targetBales: number;
}

export class ProductionTargetSplitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductionTargetSplitError";
  }
}

/** Existing linked targets can contain two decimal places. Reject invalid precision. */
export function isValidBaleTarget(value: number): boolean {
  return (
    Number.isFinite(value) &&
    value >= 0 &&
    Number.isSafeInteger(Math.round(value * 100)) &&
    Math.abs(value - Math.round(value * 100) / 100) < 1e-8
  );
}

/**
 * Linked fixed targets are stored and displayed per worker. The production
 * table sums member targets to show the team's combined bale target. Convert
 * that per-worker value to the same combined total before unlinking; splitting
 * the per-worker value again would incorrectly turn 7 + 7 into 4 + 3.
 */
export function linkedTotalBalesFromPerWorker(perWorker: number | null, workerCount: number): number | null {
  if (!Number.isSafeInteger(workerCount) || workerCount < 1) {
    throw new ProductionTargetSplitError("Linked worker count is invalid");
  }
  if (perWorker === null) return null;
  if (!isValidBaleTarget(perWorker)) {
    throw new ProductionTargetSplitError("Shared target must be a non-negative number with at most two decimals");
  }
  const cents = Math.round(perWorker * 100) * workerCount;
  if (!Number.isSafeInteger(cents)) {
    throw new ProductionTargetSplitError("Linked target exceeds the supported range");
  }
  return cents / 100;
}

export function evenSplitBales(total: number, workerIds: number[]): WorkerBaleAllocation[] {
  if (!isValidBaleTarget(total)) {
    throw new ProductionTargetSplitError("Shared target must be a non-negative number with at most two decimals");
  }
  if (
    workerIds.length === 0 ||
    new Set(workerIds).size !== workerIds.length ||
    workerIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
  ) {
    throw new ProductionTargetSplitError("Worker list is invalid");
  }

  const ordered = [...workerIds].sort((a, b) => a - b);
  // Keep integer targets as whole bales; for legacy decimal targets,
  // divide integer hundredths to avoid floating-point remainder errors.
  const scale = Number.isSafeInteger(total) ? 1 : 100;
  const units = Math.round(total * scale);
  const base = Math.floor(units / ordered.length);
  const remainder = units % ordered.length;
  return ordered.map((workerId, index) => ({
    workerId,
    targetBales: (base + (index < remainder ? 1 : 0)) / scale,
  }));
}

export function resolveUnlinkBaleAllocations(
  total: number | null,
  workerIds: number[],
  requested?: WorkerBaleAllocation[]
): Map<number, number | null> {
  if (
    workerIds.length === 0 ||
    new Set(workerIds).size !== workerIds.length ||
    workerIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
  ) {
    throw new ProductionTargetSplitError("Worker list is invalid");
  }

  if (total === null) {
    if (requested !== undefined && (!Array.isArray(requested) || requested.length > 0)) {
      throw new ProductionTargetSplitError("Cannot split a blank fixed target");
    }
    return new Map(workerIds.map((id) => [id, null]));
  }

  const automatic = evenSplitBales(total, workerIds);
  if (requested === undefined) {
    return new Map(automatic.map((entry) => [entry.workerId, entry.targetBales]));
  }

  if (!Array.isArray(requested) || requested.length !== workerIds.length) {
    throw new ProductionTargetSplitError("Enter one allocation for each linked worker");
  }
  const expectedIds = new Set(workerIds);
  const allocations = new Map<number, number>();
  let sum = 0;
  for (const entry of requested) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      !Number.isSafeInteger(entry.workerId) ||
      !expectedIds.has(entry.workerId) ||
      allocations.has(entry.workerId) ||
      !isValidBaleTarget(entry.targetBales) ||
      (Number.isSafeInteger(total) && !Number.isSafeInteger(entry.targetBales))
    ) {
      throw new ProductionTargetSplitError(
        "Allocations require unique workers and non-negative bale counts with valid precision"
      );
    }
    allocations.set(entry.workerId, entry.targetBales);
    sum += Math.round(entry.targetBales * 100);
  }
  if (!Number.isSafeInteger(sum) || sum !== Math.round(total * 100)) {
    throw new ProductionTargetSplitError(`Worker allocations must add up to ${total} bales`);
  }
  return allocations;
}

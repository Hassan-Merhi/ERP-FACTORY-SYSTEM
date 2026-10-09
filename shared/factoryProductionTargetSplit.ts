/**
 * Distribute one fixed bale target across workers when a production link ends.
 * No fractional bales and no duplicated target: allocated shares must sum
 * exactly to the shared target.
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

export function evenSplitBales(total: number, workerIds: number[]): WorkerBaleAllocation[] {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new ProductionTargetSplitError("Shared target must be a non-negative whole number of bales");
  }
  if (
    workerIds.length === 0 ||
    new Set(workerIds).size !== workerIds.length ||
    workerIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
  ) {
    throw new ProductionTargetSplitError("Worker list is invalid");
  }

  const ordered = [...workerIds].sort((a, b) => a - b);
  const base = Math.floor(total / ordered.length);
  const remainder = total % ordered.length;
  return ordered.map((workerId, index) => ({
    workerId,
    targetBales: base + (index < remainder ? 1 : 0),
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
      !Number.isSafeInteger(entry.targetBales) ||
      entry.targetBales < 0
    ) {
      throw new ProductionTargetSplitError("Allocations require unique workers and whole, non-negative bale counts");
    }
    allocations.set(entry.workerId, entry.targetBales);
    sum += entry.targetBales;
  }
  if (!Number.isSafeInteger(sum) || sum !== total) {
    throw new ProductionTargetSplitError(`Worker allocations must add up to ${total} bales`);
  }
  return allocations;
}

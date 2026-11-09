/**
 * Phase 6: explicit, decimal-exact mix quantity lifecycle policies.
 *
 * Historical completed/overused batches are not repaired by this module.
 * It only guards new status transitions, physical consumption and carry-forward.
 */
import { toMoney } from "../../lib/money";
import type Decimal from "decimal.js";

export class MixLifecycleRefusal extends Error {
  readonly code = "MIX_BATCH_LIFECYCLE_REFUSED";
  readonly statusCode: number;
  constructor(message: string, statusCode = 409) {
    super(message);
    this.name = "MixLifecycleRefusal";
    this.statusCode = statusCode;
  }
}

export type MixLifecycleBatch = {
  id: number;
  batchCode: string;
  status: string;
  totalWeightKg: string;
  usedKg: string;
  deletedAt?: Date | string | null;
};

function quantity(value: unknown, name: string): Decimal {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new MixLifecycleRefusal(`${name} must be a positive kilogram amount with at most 3 decimal places.`, 400);
  }
  const raw = String(value);
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(raw)) {
    throw new MixLifecycleRefusal(`${name} must be a positive kilogram amount with at most 3 decimal places.`, 400);
  }
  const amount = toMoney(raw);
  if (!amount.isFinite() || amount.lte(0) || amount.gt("999999999999.999")) {
    throw new MixLifecycleRefusal(`${name} is outside the allowed kilogram range.`, 400);
  }
  return amount;
}
export function mixKilograms(value: unknown, name = "Kilograms"): Decimal {
  return quantity(value, name);
}
export function requireMixLifecycleDate(raw: unknown): string {
  if (
    typeof raw !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(raw) ||
    !Number.isFinite(Date.parse(raw)) ||
    new Date(raw).toISOString().slice(0, 10) !== raw
  ) {
    throw new MixLifecycleRefusal("usedDate must be a real YYYY-MM-DD business date.", 400);
  }
  return raw;
}

export function requireMixLifecycleAvailable(batch: MixLifecycleBatch): Decimal {
  if (batch.deletedAt) {
    throw new MixLifecycleRefusal(`Mix ${batch.batchCode} is deleted and cannot be consumed or finalized.`);
  }
  if (!["ACTIVE", "OPEN", "CARRY_FORWARD"].includes(batch.status)) {
    throw new MixLifecycleRefusal(
      `Mix ${batch.batchCode} is ${batch.status}; completed/closed mixes cannot be consumed or topped up again.`
    );
  }
  const total = toMoney(batch.totalWeightKg);
  const used = toMoney(batch.usedKg);
  if (!total.isFinite() || !used.isFinite() || total.lte(0) || used.lt(0) || used.gt(total)) {
    throw new MixLifecycleRefusal(
      `Mix ${batch.batchCode} has invalid historical used/total kilograms. Review the lifecycle audit before continuing.`
    );
  }
  return total.minus(used);
}

export function requireMixLifecycleUsage(
  batch: MixLifecycleBatch,
  inputKg: unknown
): {
  usedKg: Decimal;
  remainingBeforeKg: Decimal;
  leftoverKg: Decimal;
} {
  const remaining = requireMixLifecycleAvailable(batch);
  const used = quantity(inputKg, "kgUsed");
  if (remaining.lte(0) || used.gt(remaining)) {
    throw new MixLifecycleRefusal(
      `Mix ${batch.batchCode} has only ${remaining.toFixed(3)} kg available; ${used.toFixed(3)} kg was requested.`
    );
  }
  return { usedKg: used, remainingBeforeKg: remaining, leftoverKg: remaining.minus(used) };
}

export function validateMixLifecycleUsageRequest(body: unknown): {
  usedDate: string;
  operatorUser: string | null;
  entries: Array<{ batchId: number; kgUsed: Decimal; notes: string | null }>;
} {
  if (!body || typeof body !== "object") throw new MixLifecycleRefusal("A usage request is required.", 400);
  const request = body as Record<string, unknown>;
  if (!Array.isArray(request.usages) || request.usages.length === 0 || request.usages.length > 200) {
    throw new MixLifecycleRefusal("usages must contain between 1 and 200 batch entries.", 400);
  }
  const usedDate = requireMixLifecycleDate(request.usedDate);
  if (request.operatorUser != null && typeof request.operatorUser !== "string") {
    throw new MixLifecycleRefusal("operatorUser must be text.", 400);
  }
  const seen = new Set<number>();
  const entries = request.usages.map((candidate: unknown) => {
    if (!candidate || typeof candidate !== "object") throw new MixLifecycleRefusal("Invalid usage entry.", 400);
    const item = candidate as Record<string, unknown>;
    const id = item.batchId;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || seen.has(id)) {
      throw new MixLifecycleRefusal("Batch IDs must be unique positive integers.", 400);
    }
    seen.add(id);
    if (item.notes != null && typeof item.notes !== "string") {
      throw new MixLifecycleRefusal("Usage notes must be text.", 400);
    }
    return {
      batchId: id,
      kgUsed: quantity(item.kgUsed, "kgUsed"),
      notes: typeof item.notes === "string" ? item.notes.slice(0, 2000) : null,
    };
  });
  return {
    usedDate,
    operatorUser: typeof request.operatorUser === "string" ? request.operatorUser.slice(0, 200) : null,
    entries,
  };
}

export function requireMixFinalizeDecision(
  batch: MixLifecycleBatch,
  body: unknown
): {
  remainingKg: Decimal;
  wasteReason: string | null;
} {
  const remaining = requireMixLifecycleAvailable(batch);
  if (remaining.eq(0)) return { remainingKg: remaining, wasteReason: null };
  const values = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (values.confirmRemainderAsWaste !== true) {
    throw new MixLifecycleRefusal(
      `Mix ${batch.batchCode} still has ${remaining.toFixed(3)} kg. Finalization would write off this stock. ` +
        "Confirm the exact remainder and document the waste reason, or use a verified carry-forward."
    );
  }
  const reason = typeof values.wasteReason === "string" ? values.wasteReason.trim() : "";
  if (reason.length < 10 || reason.length > 1000) {
    throw new MixLifecycleRefusal("Waste finalization needs a 10–1000 character reason.", 400);
  }
  const requested = quantity(values.wasteKg, "wasteKg");
  if (!requested.eq(remaining)) {
    throw new MixLifecycleRefusal(
      `The write-off amount changed. Current remainder is ${remaining.toFixed(3)} kg; re-review before finalizing.`
    );
  }
  return { remainingKg: remaining, wasteReason: reason };
}

/**
 * Deleting a used/completed mix would recredit raw source kilograms without
 * undoing its historical downstream production. This is not a safe ordinary
 * soft-delete and must be reviewed as a controlled quantity/accounting reversal.
 */
export function requireMixDeletionSafe(
  batch: MixLifecycleBatch & { carryForwardFromId?: number | null },
  linkedDownstream: boolean
): void {
  if (batch.deletedAt) {
    throw new MixLifecycleRefusal("This mix is already deleted.");
  }
  const used = toMoney(batch.usedKg);
  if (
    !used.isFinite() ||
    used.lt(0) ||
    ["CLOSED", "COMPLETED"].includes(batch.status) ||
    used.gt(0) ||
    batch.carryForwardFromId != null ||
    linkedDownstream
  ) {
    throw new MixLifecycleRefusal(
      "This mix has recorded consumption, completion, carry-forward, or downstream references. " +
        "Ordinary deletion would recredit raw stock without verified production reversal. " +
        "Review its lineage and use a controlled historical correction instead."
    );
  }
}

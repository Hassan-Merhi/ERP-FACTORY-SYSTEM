/**
 * Phase 4: prevent new negative physical raw-material stock when creating or
 * topping up a Factory mix. Uses exact decimals; no permitted overdraw.
 *
 * Existing historical shortages are reported separately, never silently
 * zeroed, repriced or overwritten by this guard.
 */
import { toMoney } from "../../lib/money";

export class MixRawStockShortageError extends Error {
  readonly code = "MIX_RAW_STOCK_SHORTAGE";
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "MixRawStockShortageError";
  }
}

export function requireMixRawStockCapacity(args: {
  availableKg: string | number;
  requestedKg: string | number;
  source: string;
}): void {
  const available = toMoney(args.availableKg);
  const required = toMoney(args.requestedKg);
  if (!available.isFinite() || !required.isFinite() || required.lte(0) || available.lt(required)) {
    throw new MixRawStockShortageError(
      `Insufficient raw material for ${args.source}. Required ${required.toFixed(3)} kg; ` +
      `available ${available.toFixed(3)} kg. Record and verify the physical receipt or adjustment first.`
    );
  }
}

export function requireMixFifoFullyAllocated(
  remainingKg: string | number,
  supplierId: number,
): void {
  if (toMoney(remainingKg).gt(0)) {
    throw new MixRawStockShortageError(
      `Supplier #${supplierId} does not have enough recorded raw stock for this mix. ` +
      `Unallocated quantity: ${toMoney(remainingKg).toFixed(3)} kg. No negative-stock allocation was posted.`
    );
  }
}

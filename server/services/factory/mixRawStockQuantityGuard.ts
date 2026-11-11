/**
 * Phase 4: enforce raw-material availability against receipts AND supplier ADD
 * adjustments. ADD increases supplier-available kg without increasing a
 * container's receivedKg, so legacy raw rows can legitimately show an overdraw.
 *
 * The allowance computation never changes historical rates or vouchers.
 */
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { factoryRawMaterialAdjustments, factoryMixBatchSources, factoryMixBatches } from "@shared/schema";
import type { DatabaseOrTransaction } from "../../db";
import { toMoney, MoneyDecimal } from "../../lib/money";

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
      `Insufficient container raw stock for ${args.source}. Required ${required.toFixed(3)} kg; ` +
        `available ${available.toFixed(3)} kg. Supplier ADD adjustments cannot be attributed to a specific container.`
    );
  }
}

export interface SupplierStockUsage {
  receivedKg: string | number;
  usedKg: string | number;
}

/** Available ADD-backed kg, net of previous receipt-row overdraw.
 *
 * DEDUCT adjustments reduce raw-stock receivedKg already; subtracting DEDUCT
 * again would double-count them. When no container exists, count supplier-only
 * source consumption explicitly, since it cannot appear in raw usedKg.
 *
 * Source supplier row/physical stock locks must be held by the caller
 * before using this allowance in a write transaction.
 */
export async function availableSupplierAddAllowance(
  tx: DatabaseOrTransaction,
  companyId: number,
  supplierId: number,
  rawRows: readonly SupplierStockUsage[],
  asOfBusinessDate?: string
): Promise<ReturnType<typeof toMoney>> {
  if (asOfBusinessDate && !/^\d{4}-\d{2}-\d{2}$/.test(asOfBusinessDate)) {
    throw new MixRawStockShortageError("Supplier ADD stock requires a valid YYYY-MM-DD mix business date.");
  }
  const [additions] = await tx
    .select({
      kg: sql<string>`COALESCE(SUM(${factoryRawMaterialAdjustments.kg}), 0)`,
    })
    .from(factoryRawMaterialAdjustments)
    .where(
      and(
        eq(factoryRawMaterialAdjustments.companyId, companyId),
        eq(factoryRawMaterialAdjustments.supplierId, supplierId),
        eq(factoryRawMaterialAdjustments.type, "ADD"),
        isNull(factoryRawMaterialAdjustments.deletedAt),
        asOfBusinessDate ? lte(factoryRawMaterialAdjustments.date, asOfBusinessDate) : undefined
      )
    );
  const addKg = toMoney(additions?.kg ?? "0");
  let consumedFromAdds = new MoneyDecimal(0);
  for (const row of rawRows) {
    const overdraft = toMoney(row.usedKg).minus(row.receivedKg);
    if (overdraft.gt(0)) consumedFromAdds = consumedFromAdds.plus(overdraft);
  }
  // Legacy supplier-only rows may have been recorded without a container
  // link. We cannot prove whether the quantity was already deducted from a
  // physical row, so subtract it conservatively from the ADD allowance.
  // This can block a legitimate source edit, but cannot mint extra stock.
  if (addKg.gt(consumedFromAdds)) {
    const [manual] = await tx
      .select({
        kg: sql<string>`COALESCE(SUM(${factoryMixBatchSources.weightKg}), 0)`,
      })
      .from(factoryMixBatchSources)
      .innerJoin(factoryMixBatches, eq(factoryMixBatchSources.mixBatchId, factoryMixBatches.id))
      .where(
        and(
          eq(factoryMixBatches.companyId, companyId),
          isNull(factoryMixBatches.deletedAt),
          eq(factoryMixBatchSources.supplierId, supplierId),
          isNull(factoryMixBatchSources.containerId),
          isNull(factoryMixBatchSources.sourceBatchId)
        )
      );
    consumedFromAdds = consumedFromAdds.plus(manual?.kg ?? "0");
  }
  return MoneyDecimal.max(0, addKg.minus(consumedFromAdds));
}

/** Refuses unbacked over-use. Adjustment-backed usage is allowed at supplier
 * level but remains visible in audit as a receipt-row negative quantity. */
export function requireMixFifoFullyAllocated(
  remainingKg: string | number,
  supplierId: number,
  availableAddKg: string | number = 0
): void {
  const remaining = toMoney(remainingKg);
  const addAllowance = toMoney(availableAddKg);
  if (remaining.gt(addAllowance)) {
    throw new MixRawStockShortageError(
      `Supplier #${supplierId} cannot cover ${remaining.toFixed(3)} kg of remaining mix usage. ` +
        `Unconsumed, recorded ADD backing: ${addAllowance.toFixed(3)} kg. ` +
        `No unbacked negative stock was posted.`
    );
  }
}

/**
 * Supplier-level negative stock is an advance against a future offload, not
 * an invented container receipt or a free ADD adjustment. Keep the two
 * components distinct in persisted mix-source provenance. The existing
 * supplier aggregate (SUM(received - used)) will net the advance against a
 * later offload of the same supplier without rewriting past receipts.
 */
export function splitSupplierShortfall(
  shortfallKg: string | number,
  recordedAddAllowanceKg: string | number
): { adjustmentKg: ReturnType<typeof toMoney>; advanceKg: ReturnType<typeof toMoney> } {
  // toMoney() coerces unparseable text to zero; a non-numeric quantity must be
  // refused here rather than silently recorded as "no shortfall".
  const isPlainDecimal = (value: string | number) => /^-?\d+(\.\d+)?$/.test(String(value).trim());
  if (!isPlainDecimal(shortfallKg) || !isPlainDecimal(recordedAddAllowanceKg)) {
    throw new MixRawStockShortageError("Invalid supplier shortfall or ADD allowance.");
  }
  const shortfall = toMoney(shortfallKg);
  const allowance = toMoney(recordedAddAllowanceKg);
  if (!shortfall.isFinite() || !allowance.isFinite() || shortfall.lt(0) || allowance.lt(0)) {
    throw new MixRawStockShortageError("Invalid supplier shortfall or ADD allowance.");
  }
  const adjustmentKg = MoneyDecimal.min(shortfall, allowance);
  return { adjustmentKg, advanceKg: shortfall.minus(adjustmentKg) };
}

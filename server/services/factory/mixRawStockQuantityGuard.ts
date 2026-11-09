/**
 * Phase 4: enforce raw-material availability against receipts AND supplier ADD
 * adjustments. ADD increases supplier-available kg without increasing a
 * container's receivedKg, so legacy raw rows can legitimately show an overdraw.
 *
 * The allowance computation never changes historical rates or vouchers.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { factoryRawMaterialAdjustments, factoryMixBatchSources, factoryMixBatches } from "@shared/schema";
import type { DatabaseOrTransaction } from "../../db";
import { toMoney, MoneyDecimal } from "../../lib/money";

export class MixRawStockShortageError extends Error {
  readonly code = "MIX_RAW_STOCK_SHORTAGE";
  readonly status = 409;
  constructor(message: string) { super(message); this.name = "MixRawStockShortageError"; }
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
 * Supply-row locks and the supplier advisory lock must be held by the caller
 * before using this allowance in a write transaction.
 */
export async function availableSupplierAddAllowance(
  tx: DatabaseOrTransaction,
  companyId: number,
  supplierId: number,
  rawRows: readonly SupplierStockUsage[],
): Promise<ReturnType<typeof toMoney>> {
  const [additions] = await tx.select({
    kg: sql<string>`COALESCE(SUM(${factoryRawMaterialAdjustments.kg}), 0)`,
  }).from(factoryRawMaterialAdjustments).where(and(
    eq(factoryRawMaterialAdjustments.companyId, companyId),
    eq(factoryRawMaterialAdjustments.supplierId, supplierId),
    eq(factoryRawMaterialAdjustments.type, "ADD"),
    isNull(factoryRawMaterialAdjustments.deletedAt),
  ));
  const addKg = toMoney(additions?.kg ?? "0");
  let consumedFromAdds = new MoneyDecimal(0);
  for (const row of rawRows) {
    const overdraft = toMoney(row.usedKg).minus(row.receivedKg);
    if (overdraft.gt(0)) consumedFromAdds = consumedFromAdds.plus(overdraft);
  }
  if (rawRows.length === 0) {
    const [manual] = await tx.select({
      kg: sql<string>`COALESCE(SUM(${factoryMixBatchSources.weightKg}), 0)`,
    }).from(factoryMixBatchSources)
      .innerJoin(factoryMixBatches, eq(factoryMixBatchSources.mixBatchId, factoryMixBatches.id))
      .where(and(
        eq(factoryMixBatches.companyId, companyId),
        isNull(factoryMixBatches.deletedAt),
        eq(factoryMixBatchSources.supplierId, supplierId),
        isNull(factoryMixBatchSources.containerId),
        isNull(factoryMixBatchSources.sourceBatchId),
      ));
    consumedFromAdds = consumedFromAdds.plus(manual?.kg ?? "0");
  }
  return MoneyDecimal.max(0, addKg.minus(consumedFromAdds));
}

/** Refuses unbacked over-use. Adjustment-backed usage is allowed at supplier
 * level but remains visible in audit as a receipt-row negative quantity. */
export function requireMixFifoFullyAllocated(
  remainingKg: string | number,
  supplierId: number,
  availableAddKg: string | number = 0,
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

// Extracted from ./_helpers.ts
import { db } from "../../db";
import {
  factoryUserProfiles,
  factoryContainers,
  factoryRawStock,
  factoryMixBatchSources,
  factoryMixBatches,
  factoryContainerCommissions,
  factoryOffloadAdditionalCharges,
} from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { resolveStoredFxRate, UnresolvedExchangeRateError } from "../../services/factory/currencyConversion";
import type { DbTransaction } from "../../db";
import type Decimal from "decimal.js";
import { MoneyDecimal, sumMoney, toMoney } from "../../lib/money";
import { resolveMixSourcePricingBasis } from "../../services/factory/mixSourcePricingBasis";

export async function recalculateContainerCostsInner(
  tx: DbTransaction,
  companyId: number,
  containerId: number
): Promise<{ totalCost: number; inclusiveCostPerKg: number; costPerKgUsd: number; rawStockId: number | null }> {
  const [container] = await tx
    .select()
    .from(factoryContainers)
    .where(and(eq(factoryContainers.id, containerId), eq(factoryContainers.companyId, companyId)));
  if (!container) throw new Error(`Container ${containerId} not found`);

  const actualKg = toMoney(container.actualReceivedKg);
  if (actualKg.lessThanOrEqualTo(0)) throw new Error("Container has no received weight");

  const containerCcy = container.currencyCode || "USD";
  const { fxRate, looksSet: containerFxLooksSet } = resolveStoredFxRate(containerCcy, container.fxRateToUsd);
  if (!containerFxLooksSet) {
    throw new UnresolvedExchangeRateError(containerCcy);
  }
  const containerFx = toMoney(fxRate);
  // An amount in `ccy`, its USD value (`usd`) given, expressed in the container currency.
  const inContainerCcy = (amount: Decimal, ccy: string, usd: Decimal) =>
    ccy === containerCcy ? amount : containerFx.greaterThan(0) ? usd.dividedBy(containerFx) : amount;

  // Base material cost
  const basePayable = actualKg.times(toMoney(container.ratePerKg));

  // Freight — may be in a different currency; normalise to container currency
  const freightVal = toMoney(container.freight);
  const freightCcy = container.freightCurrencyCode || containerCcy;
  // `container.freightFxRate` is not a column on factory_containers (the stored
  // freight rate is `freightFxRateToUsd`), so this branch has always been
  // undefined; kept as-is so the computed freight is unchanged.
  const freightFx = toMoney(container.fxRateToUsdOffload || String(fxRate));
  const freightUsd = freightCcy === "USD" ? freightVal : freightVal.times(freightFx);
  const freightInCcy = inContainerCcy(freightVal, freightCcy, freightUsd);

  // Other charges (bulk field)
  const ocVal = toMoney(container.otherCharges);
  const ocCcy = container.otherChargesCurrencyCode || containerCcy;
  // factory_containers has no other-charges FX column, so this has always
  // resolved to the container rate.
  const ocUsd = ocCcy === "USD" ? ocVal : ocVal.times(containerFx);
  const ocInCcy = inContainerCcy(ocVal, ocCcy, ocUsd);

  // Commission
  const [commission] = await tx
    .select()
    .from(factoryContainerCommissions)
    .where(eq(factoryContainerCommissions.containerId, containerId));
  const commVal = commission ? toMoney(commission.commissionTotal) : toMoney(container.commissionAmount);
  const commCcy = commission ? commission.currencyCode || "USD" : containerCcy;
  let commFx = fxRate;
  if (commission && commCcy !== "USD") {
    if (commCcy === containerCcy) {
      commFx = fxRate; // same currency as container — reuse the already-validated container rate
    } else {
      const { fxRate: resolvedCommFx, looksSet: commFxLooksSet } = resolveStoredFxRate(
        commCcy,
        commission.fxRateToUsd,
        commission.fxRateConfirmed
      );
      if (!commFxLooksSet) throw new UnresolvedExchangeRateError(commCcy);
      commFx = resolvedCommFx;
    }
  }
  const commUsdAmt = commCcy === "USD" ? commVal : commVal.times(toMoney(commFx));
  const commInCcy = inContainerCcy(commVal, commCcy, commUsdAmt);

  // Duty (only included when CONFIRMED)
  const dutyVal = container.dutyStatus === "CONFIRMED" ? toMoney(container.dutyAmount) : new MoneyDecimal(0);

  // Additional offload charges
  const additionalCharges = await tx
    .select()
    .from(factoryOffloadAdditionalCharges)
    .where(
      and(
        eq(factoryOffloadAdditionalCharges.containerId, containerId),
        eq(factoryOffloadAdditionalCharges.companyId, companyId)
      )
    );
  const additionalTotal = sumMoney(
    additionalCharges.map((c) => {
      const amt = toMoney(c.amount);
      const ccy = c.currencyCode || containerCcy;
      const amtUsd = ccy === "USD" ? amt : amt.times(toMoney(c.fxRateToUsd || String(fxRate)));
      // Unlike the charges above, a zero container rate leaves the USD amount.
      return ccy === containerCcy ? amt : containerFx.greaterThan(0) ? amtUsd.dividedBy(containerFx) : amtUsd;
    })
  );

  const totalCostExact = sumMoney([basePayable, freightInCcy, ocInCcy, commInCcy, dutyVal, additionalTotal]);
  const costPerKgExact = totalCostExact.dividedBy(actualKg);
  const costPerKgUsdExact = containerCcy === "USD" ? costPerKgExact : costPerKgExact.times(containerFx);
  const finalPayableAmountUsd = actualKg.times(costPerKgUsdExact);
  const totalCost = totalCostExact.toNumber();
  const inclusiveCostPerKg = costPerKgExact.toNumber();
  const costPerKgUsd = costPerKgUsdExact.toNumber();

  // Values are written at their columns' scales, rounded half away from zero
  // as Postgres rounds them.
  // 1. Update container summary fields
  await tx
    .update(factoryContainers)
    .set({
      finalPayableAmount: totalCostExact.toFixed(4),
      ratePerKgUsd: costPerKgUsdExact.toFixed(6),
      finalPayableAmountUsd: finalPayableAmountUsd.toFixed(4),
      updatedAt: new Date(),
    })
    .where(eq(factoryContainers.id, containerId));

  // 2. Update rawStock
  const [rawStockRow] = await tx
    .select()
    .from(factoryRawStock)
    .where(and(eq(factoryRawStock.companyId, companyId), eq(factoryRawStock.containerId, containerId)));

  let rawStockId: number | null = null;
  if (rawStockRow) {
    rawStockId = rawStockRow.id;
    await tx
      .update(factoryRawStock)
      .set({ costPerKg: costPerKgExact.toFixed(7), costPerKgUsd: costPerKgUsdExact.toFixed(7) })
      .where(eq(factoryRawStock.id, rawStockRow.id));
  }

  // 3. Update mix batch sources from this container
  const mixSources = await tx
    .select()
    .from(factoryMixBatchSources)
    .where(eq(factoryMixBatchSources.containerId, containerId));

  if (mixSources.length > 0) {
    for (const src of mixSources) {
      // Only a source priced from this container alone follows its cost; a
      // supplier-priced source keeps the supplier's locked rate (USD).
      if (resolveMixSourcePricingBasis(src) !== "CONTAINER_DIRECT") continue;
      const newSrcCost = toMoney(src.weightKg).times(costPerKgUsdExact);
      await tx
        .update(factoryMixBatchSources)
        .set({ costPerKg: costPerKgUsdExact.toFixed(7), totalCost: newSrcCost.toFixed(7) })
        .where(eq(factoryMixBatchSources.id, src.id));
    }

    // 4. Recalculate weighted-average costPerKg on affected mix batches
    const affectedBatchIds = Array.from(
      new Set<number>(mixSources.map((s: (typeof mixSources)[number]) => s.mixBatchId))
    );
    for (const batchId of affectedBatchIds) {
      const allSrc = await tx
        .select()
        .from(factoryMixBatchSources)
        .where(eq(factoryMixBatchSources.mixBatchId, batchId));
      const batchTotalCost = sumMoney(allSrc.map((r) => r.totalCost));
      const batchTotalWeight = sumMoney(allSrc.map((r) => r.weightKg));
      const batchCostPerKg = batchTotalWeight.greaterThan(0)
        ? batchTotalCost.dividedBy(batchTotalWeight)
        : new MoneyDecimal(0);
      await tx
        .update(factoryMixBatches)
        .set({
          costPerKg: batchCostPerKg.toFixed(7),
          totalCost: batchTotalCost.toFixed(7),
          updatedAt: new Date(),
        })
        .where(eq(factoryMixBatches.id, batchId));
    }
  }

  return { totalCost, inclusiveCostPerKg, costPerKgUsd, rawStockId };
}

/**
 * Returns true if the logged-in user has "hideAllCosts" enabled.
 * Admins and owners always return false (they always see costs).
 */
export async function getUserHideAllCosts(req: import("express").Request): Promise<boolean> {
  try {
    const userId = req.session?.userId;
    if (!userId) return false;
    const role = req.session?.currentRole?.toLowerCase?.();
    if (role === "admin" || role === "owner" || role === "developer") return false;
    const [profile] = await db
      .select({ hideAllCosts: factoryUserProfiles.hideAllCosts })
      .from(factoryUserProfiles)
      .where(eq(factoryUserProfiles.userId, userId))
      .limit(1);
    return profile?.hideAllCosts ?? false;
  } catch {
    return false;
  }
}

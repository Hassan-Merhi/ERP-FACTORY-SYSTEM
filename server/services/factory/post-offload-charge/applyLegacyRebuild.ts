// Extracted from ./apply.ts: the LEGACY_REBUILD branch of the post-offload charge mutation.
import Decimal from "decimal.js";
import { toMoney } from "../../../lib/money";
import { and, eq, isNull } from "drizzle-orm";
import { factoryOffloadAdditionalCharges, factorySuppliers } from "../../../../shared/schema";
import { assertNoLaterSupplierCostEvents } from "./legacy-links";
import type { DbTransaction } from "../../../db";
import type { computeRemainingFraction } from "./loaders";
import type { PostOffloadMutationParams } from "./types";
import type { FactoryContainer } from "@shared/schema";

type ComputeRemainingFractionResult = Awaited<ReturnType<typeof computeRemainingFraction>>;

export async function applyPostOffloadChargeLegacyRebuild({
  params,
  tx,
  companyId,
  supplierId,
  dFraction,
  supplierRemainingKg,
  userId,
  container,
  supplierLockedRateBefore,
  dReceivedKg,
  dRemainingKg,
}: {
  params: PostOffloadMutationParams;
  tx: DbTransaction;
  companyId: PostOffloadMutationParams["companyId"];
  supplierId: number | null;
  dFraction: ComputeRemainingFractionResult["dFraction"];
  supplierRemainingKg: number;
  userId: PostOffloadMutationParams["userId"];
  container: FactoryContainer;
  supplierLockedRateBefore: string | null;
  dReceivedKg: ComputeRemainingFractionResult["dReceivedKg"];
  dRemainingKg: ComputeRemainingFractionResult["dRemainingKg"];
}) {
  const { chargeId, legacyBaselineRate, expectedVersion } = params;
  if (!chargeId) throw new Error("chargeId is required for LEGACY_REBUILD");
  if (legacyBaselineRate === undefined || legacyBaselineRate === null)
    throw new Error("legacyBaselineRate is required for LEGACY_REBUILD");

  // Lock the charge row FOR UPDATE
  const [chargeRow] = await tx
    .select()
    .from(factoryOffloadAdditionalCharges)
    .where(
      and(
        eq(factoryOffloadAdditionalCharges.id, chargeId),
        eq(factoryOffloadAdditionalCharges.companyId, companyId),
        isNull(factoryOffloadAdditionalCharges.deletedAt)
      )
    )
    .for("update");
  if (!chargeRow) throw new Error("Charge not found or already undone");
  if (expectedVersion !== undefined && chargeRow.version !== expectedVersion) {
    const err: Error & { status?: number } = new Error("Charge was modified by another request — please retry");
    err.status = 409;
    throw err;
  }

  // Guard: must be a legacy charge (no prior snapshot)
  if (chargeRow.supplierLockedRateBefore !== null) {
    throw new Error("This charge already has a supplier-rate snapshot. Use Edit instead of Legacy Rebuild.");
  }
  if (!supplierId) throw new Error("Container has no supplier — cannot rebuild supplier rate");

  // Guard: no later supplier cost events
  await assertNoLaterSupplierCostEvents(tx, companyId, supplierId, new Date(chargeRow.createdAt));

  // Compute the correct supplier rate:
  //   newRate = legacyBaselineRate + (chargeAmountUsd × remainingFraction) / supplierRemainingKg
  const chargeAmountUsd = new Decimal(String(chargeRow.amount)).times(
    new Decimal(String(chargeRow.fxRateToUsd || "1"))
  );
  const dSupplierInventoryValueDeltaUsd = chargeAmountUsd.times(dFraction);
  const dAuthKg = new Decimal(String(supplierRemainingKg));
  const dBaseRate = new Decimal(String(legacyBaselineRate));

  const dNewRate = dAuthKg.gt(0) ? dBaseRate.plus(dSupplierInventoryValueDeltaUsd.div(dAuthKg)) : dBaseRate;

  // Set supplier locked rate directly
  await tx
    .update(factorySuppliers)
    .set({ currentRawMaterialCostPerKgUsd: Decimal.max(0, dNewRate).toFixed(8), updatedAt: new Date() })
    .where(and(eq(factorySuppliers.id, supplierId), eq(factorySuppliers.companyId, companyId)));

  const supplierLockedRateAfterStr = Decimal.max(0, dNewRate).toFixed(8);

  // Save snapshots on the charge row
  await tx
    .update(factoryOffloadAdditionalCharges)
    .set({
      supplierLockedRateBefore: String(legacyBaselineRate),
      supplierLockedRateAfter: supplierLockedRateAfterStr,
      supplierRemainingKgAtApply: dAuthKg.toFixed(3),
      fullContainerValueDeltaUsd: chargeAmountUsd.toFixed(6),
      supplierInventoryValueDeltaUsd: dSupplierInventoryValueDeltaUsd.toFixed(6),
      remainingFractionAtApply: dFraction.toFixed(8),
      updatedByUserId: userId || null,
      updatedAt: new Date(),
      version: (chargeRow.version || 1) + 1,
    })
    .where(eq(factoryOffloadAdditionalCharges.id, chargeId));

  return {
    chargeId,
    action: "LEGACY_REBUILD",
    oldContainerCostPerKgUsd: toMoney(container.ratePerKgUsd).toNumber(),
    newContainerCostPerKgUsd: toMoney(container.ratePerKgUsd).toNumber(),
    supplierLockedRateBefore,
    supplierLockedRateAfter: supplierLockedRateAfterStr,
    supplierRemainingKg,
    containerReceivedKg: dReceivedKg.toNumber(),
    containerRemainingKg: dRemainingKg.toNumber(),
    remainingFraction: dFraction.toFixed(8),
    fullContainerValueDeltaUsd: chargeAmountUsd.toFixed(6),
    supplierInventoryValueDeltaUsd: dSupplierInventoryValueDeltaUsd.toFixed(6),
    supplierValueBeforeUsd: supplierLockedRateBefore
      ? new Decimal(supplierLockedRateBefore).times(dAuthKg).toFixed(6)
      : null,
    supplierValueAfterUsd: new Decimal(supplierLockedRateAfterStr).times(dAuthKg).toFixed(6),
    cascadeResult: null,
  };
}

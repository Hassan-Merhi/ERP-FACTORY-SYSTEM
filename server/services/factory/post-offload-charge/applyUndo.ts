// Extracted from ./apply.ts: the UNDO branch of the post-offload charge mutation.
import Decimal from "decimal.js";
import { toMoney } from "../../../lib/money";
import { and, eq } from "drizzle-orm";
import { factoryOffloadAdditionalCharges, factorySuppliers, factoryDaybookEntries } from "../../../../shared/schema";
import { cascadeContainerCostChange } from "../rawStockCostCascade";
import { computeCorrectContainerCost } from "../raw-stock-recalc";
import { writeDaybookEntry } from "../../../routes/factory/_helpers";
import {
  assertNoLaterSupplierCostEvents,
  resolveLegacyPostOffloadAccountingLinks,
  updateContainerCost,
} from "./legacy-links";
import { loadActiveCharges } from "./loaders";
import { assertResolvedHistoricalLinks } from "./guards";
import type { CascadeResult } from "../rawStockCostCascade";
import { retireChargeVoucherTx } from "./retireChargeVoucher";
import type { DbTransaction } from "../../../db";
import type { computeRemainingFraction, loadCostInputs } from "./loaders";
import type { PostOffloadMutationParams } from "./types";
import type { FactoryContainer } from "@shared/schema";

type ComputeRemainingFractionResult = Awaited<ReturnType<typeof computeRemainingFraction>>;
type LoadCostInputsResult = Awaited<ReturnType<typeof loadCostInputs>>;

export async function applyPostOffloadChargeUndo({
  params,
  tx,
  companyId,
  container,
  supplierRemainingKg,
  dReceivedKg,
  dRemainingKg,
  dFraction,
  containerId,
  commissionRecord,
  otherChargeRows,
  userId,
  supplierLockedRateBefore,
  supplierId,
}: {
  params: PostOffloadMutationParams;
  tx: DbTransaction;
  companyId: PostOffloadMutationParams["companyId"];
  container: FactoryContainer;
  supplierRemainingKg: number;
  dReceivedKg: ComputeRemainingFractionResult["dReceivedKg"];
  dRemainingKg: ComputeRemainingFractionResult["dRemainingKg"];
  dFraction: ComputeRemainingFractionResult["dFraction"];
  containerId: PostOffloadMutationParams["containerId"];
  commissionRecord: LoadCostInputsResult["commissionRecord"];
  otherChargeRows: LoadCostInputsResult["otherChargeRows"];
  userId: PostOffloadMutationParams["userId"];
  supplierLockedRateBefore: string | null;
  supplierId: number | null;
}) {
  const { chargeId, expectedVersion } = params;
  if (!chargeId) throw new Error("chargeId is required for UNDO");

  // Lock the charge FOR UPDATE
  const [rawCharge] = await tx
    .select()
    .from(factoryOffloadAdditionalCharges)
    .where(
      and(eq(factoryOffloadAdditionalCharges.id, chargeId), eq(factoryOffloadAdditionalCharges.companyId, companyId))
    )
    .for("update");
  if (!rawCharge) throw new Error("Charge not found");

  // Idempotent: already undone
  if (rawCharge.deletedAt) {
    return {
      chargeId,
      action: "UNDO",
      alreadyUndone: true,
      oldContainerCostPerKgUsd: toMoney(container.ratePerKgUsd).toNumber(),
      newContainerCostPerKgUsd: toMoney(container.ratePerKgUsd).toNumber(),
      supplierLockedRateBefore: null,
      supplierLockedRateAfter: null,
      supplierRemainingKg,
      containerReceivedKg: dReceivedKg.toNumber(),
      containerRemainingKg: dRemainingKg.toNumber(),
      remainingFraction: dFraction.toFixed(8),
      fullContainerValueDeltaUsd: "0.000000",
      supplierInventoryValueDeltaUsd: "0.000000",
      supplierValueBeforeUsd: null,
      supplierValueAfterUsd: null,
      cascadeResult: null,
      reversalDaybookEntryId: rawCharge.reversalDaybookEntryId,
    };
  }

  if (expectedVersion !== undefined && rawCharge.version !== expectedVersion) {
    const err: Error & { status?: number } = new Error("Charge was modified by another request — please retry");
    err.status = 409;
    throw err;
  }

  // Resolve legacy accounting links if needed
  const chargeRow = await resolveLegacyPostOffloadAccountingLinks(tx, companyId, containerId, rawCharge);
  assertResolvedHistoricalLinks(chargeRow);

  // Compute OLD canonical cost (with this charge included)
  const activeCharges = await loadActiveCharges(tx, companyId, containerId);
  const oldCost = computeCorrectContainerCost(container, activeCharges, commissionRecord, otherChargeRows);
  if (oldCost.fxUnresolved) throw new Error(`FX rate unresolved for container ${container.containerNumber}`);

  // Soft-delete the charge
  const now = new Date();
  await tx
    .update(factoryOffloadAdditionalCharges)
    .set({
      deletedAt: now,
      updatedAt: now,
      updatedByUserId: userId || null,
      version: (chargeRow.version || 1) + 1,
    })
    .where(eq(factoryOffloadAdditionalCharges.id, chargeId));

  // Compute NEW canonical cost (without this charge)
  const remainingActiveCharges = activeCharges.filter((c) => c.id !== chargeId);
  const newCost = computeCorrectContainerCost(container, remainingActiveCharges, commissionRecord, otherChargeRows);
  if (newCost.fxUnresolved) throw new Error(`FX rate unresolved for container ${container.containerNumber}`);

  // Exact negative delta
  const dOldTotal = new Decimal(String(oldCost.totalUsd));
  const dNewTotal = new Decimal(String(newCost.totalUsd));
  const dFullDelta = dNewTotal.minus(dOldTotal); // negative
  const dSupplierDelta = dFullDelta.times(dFraction); // negative

  // Update container
  await updateContainerCost(tx, containerId, newCost);

  const dAuthKg = new Decimal(String(supplierRemainingKg));
  const supplierValueBeforeUsd = supplierLockedRateBefore
    ? new Decimal(supplierLockedRateBefore).times(dAuthKg).toFixed(6)
    : null;

  let cascadeResult: CascadeResult;
  const isLegacyUnknownBaseline =
    chargeRow.supplierLockedRateBefore === null && params.legacyBaselineRate !== undefined;

  if (isLegacyUnknownBaseline && supplierId) {
    // Legacy undo: set supplier rate directly to the baseline (skip cascade supplier update)
    await assertNoLaterSupplierCostEvents(tx, companyId, supplierId, new Date(chargeRow.createdAt));
    await tx
      .update(factorySuppliers)
      .set({
        currentRawMaterialCostPerKgUsd: new Decimal(String(params.legacyBaselineRate)).toFixed(8),
        updatedAt: new Date(),
      })
      .where(and(eq(factorySuppliers.id, supplierId), eq(factorySuppliers.companyId, companyId)));
    cascadeResult = await cascadeContainerCostChange(
      tx,
      {
        companyId,
        containerId,
        newCostPerKg: newCost.costPerKg,
        newCostPerKgUsd: newCost.costPerKgUsd,
        skipSupplierRateUpdate: true,
      },
      { includeCompletedBatches: true }
    );
  } else {
    cascadeResult = await cascadeContainerCostChange(
      tx,
      {
        companyId,
        containerId,
        newCostPerKg: newCost.costPerKg,
        newCostPerKgUsd: newCost.costPerKgUsd,
        supplierInventoryValueDeltaUsdOverride: dSupplierDelta,
      },
      { includeCompletedBatches: true }
    );
  }

  // Capture supplier rate after cascade
  let supplierLockedRateAfter: string | null = null;
  if (supplierId) {
    const [supAfter] = await tx
      .select({ rate: factorySuppliers.currentRawMaterialCostPerKgUsd })
      .from(factorySuppliers)
      .where(and(eq(factorySuppliers.id, supplierId), eq(factorySuppliers.companyId, companyId)));
    supplierLockedRateAfter = supAfter?.rate ?? null;
  }

  // Soft-delete linked voucher
  if (chargeRow.voucherId) {
    // Phase 22 (C): retired (audited, number and posting identity released);
    // was an unaudited soft delete.
    await retireChargeVoucherTx(tx, chargeRow.voucherId, "post-offload-charge-reversed");
  }

  // Create reversing daybook entry (avoid duplicate if already reversed)
  let reversalDaybookEntryId: number | null = chargeRow.reversalDaybookEntryId || null;
  if (!reversalDaybookEntryId && chargeRow.daybookEntryId) {
    // Load the original daybook entry for amounts
    const [origEntry] = await tx
      .select()
      .from(factoryDaybookEntries)
      .where(eq(factoryDaybookEntries.id, chargeRow.daybookEntryId));

    if (origEntry) {
      const reversalEntry = await writeDaybookEntry(tx, {
        companyId,
        txDate: params.txDate,
        txType: "OTHER_CHARGE",
        referenceId: containerId,
        description: `REVERSAL: ${chargeRow.description} (post-offload) — container ${container.containerNumber}`,
        currencyCode: origEntry.currencyCode,
        amountCurrency: toMoney(origEntry.amountCurrency).neg().toNumber(),
        fxRateToUsd: toMoney(origEntry.fxRateToUsd || "1").toNumber(),
        amountUsd: toMoney(origEntry.amountUsd).neg().toNumber(),
        metaJson: JSON.stringify({
          sourceType: "POST_OFFLOAD_ADDITIONAL_REVERSAL",
          chargeId,
          reversesDaybookEntryId: chargeRow.daybookEntryId,
        }),
      });
      reversalDaybookEntryId = reversalEntry.id;
    }
  }

  // Persist reversalDaybookEntryId on the charge row
  if (reversalDaybookEntryId) {
    await tx
      .update(factoryOffloadAdditionalCharges)
      .set({
        reversalDaybookEntryId,
        supplierLockedRateAfter: isLegacyUnknownBaseline ? String(params.legacyBaselineRate) : supplierLockedRateAfter,
      })
      .where(eq(factoryOffloadAdditionalCharges.id, chargeId));
  }

  const supplierValueAfterUsd = supplierLockedRateAfter
    ? new Decimal(supplierLockedRateAfter).times(dAuthKg).toFixed(6)
    : null;

  return {
    chargeId,
    action: "UNDO",
    oldContainerCostPerKgUsd: toMoney(container.ratePerKgUsd).toNumber(),
    newContainerCostPerKgUsd: newCost.costPerKgUsd,
    supplierLockedRateBefore,
    supplierLockedRateAfter,
    supplierRemainingKg,
    containerReceivedKg: dReceivedKg.toNumber(),
    containerRemainingKg: dRemainingKg.toNumber(),
    remainingFraction: dFraction.toFixed(8),
    fullContainerValueDeltaUsd: dFullDelta.toFixed(6),
    supplierInventoryValueDeltaUsd: dSupplierDelta.toFixed(6),
    supplierValueBeforeUsd,
    supplierValueAfterUsd,
    cascadeResult,
    reversalDaybookEntryId,
  };
}

// Extracted from ./apply.ts: the CREATE branch of the post-offload charge mutation.
import { postFactoryVoucherTx } from "../factoryVoucherPosting";
import Decimal from "decimal.js";
import { toMoney } from "../../../lib/money";
import { and, eq } from "drizzle-orm";
import { factoryOffloadAdditionalCharges, factorySuppliers } from "../../../../shared/schema";
import { cascadeContainerCostChange } from "../rawStockCostCascade";
import { computeCorrectContainerCost } from "../raw-stock-recalc";
import { writeDaybookEntry } from "../../../routes/factory/_helpers";
import { updateContainerCost } from "./legacy-links";
import { loadActiveCharges } from "./loaders";
import { assertChargePostingDestination } from "./guards";
import type { DbTransaction } from "../../../db";
import type { computeRemainingFraction, loadCostInputs } from "./loaders";
import type { PostOffloadMutationParams } from "./types";
import type { FactoryContainer } from "@shared/schema";

type ComputeRemainingFractionResult = Awaited<ReturnType<typeof computeRemainingFraction>>;
type LoadCostInputsResult = Awaited<ReturnType<typeof loadCostInputs>>;

export async function applyPostOffloadChargeCreate({
  params,
  companyId,
  tx,
  containerId,
  container,
  commissionRecord,
  otherChargeRows,
  userId,
  dFraction,
  supplierRemainingKg,
  supplierLockedRateBefore,
  supplierId,
  txDate,
  dReceivedKg,
  dRemainingKg,
}: {
  params: PostOffloadMutationParams;
  companyId: PostOffloadMutationParams["companyId"];
  tx: DbTransaction;
  containerId: PostOffloadMutationParams["containerId"];
  container: FactoryContainer;
  commissionRecord: LoadCostInputsResult["commissionRecord"];
  otherChargeRows: LoadCostInputsResult["otherChargeRows"];
  userId: PostOffloadMutationParams["userId"];
  dFraction: ComputeRemainingFractionResult["dFraction"];
  supplierRemainingKg: number;
  supplierLockedRateBefore: string | null;
  supplierId: number | null;
  txDate: PostOffloadMutationParams["txDate"];
  dReceivedKg: ComputeRemainingFractionResult["dReceivedKg"];
  dRemainingKg: ComputeRemainingFractionResult["dRemainingKg"];
}) {
  const { chargeData, accountingCtx } = params;
  if (!chargeData) throw new Error("chargeData is required for CREATE");
  assertChargePostingDestination(
    companyId,
    chargeData,
    accountingCtx,
    "Post-offload charge requires exactly one company-owned expense account or supplier and a valid payable account."
  );

  // Compute OLD canonical cost
  const activeCharges = await loadActiveCharges(tx, companyId, containerId);
  const oldCost = computeCorrectContainerCost(container, activeCharges, commissionRecord, otherChargeRows);
  if (oldCost.fxUnresolved) throw new Error(`FX rate unresolved for container ${container.containerNumber}`);

  // Insert the new charge row
  const [inserted] = await tx
    .insert(factoryOffloadAdditionalCharges)
    .values({
      companyId,
      containerId,
      description: chargeData.description,
      amount: String(chargeData.amount),
      currencyCode: chargeData.currencyCode,
      fxRateToUsd: String(chargeData.fxRateToUsd),
      fxRateConfirmed: chargeData.fxRateConfirmed,
      fxRateDate: chargeData.fxRateDate || null,
      ledgerAccountId: chargeData.ledgerAccountId,
      supplierId: chargeData.supplierId,
      createdByUserId: userId || null,
      updatedByUserId: userId || null,
      version: 1,
    })
    .returning();

  // Compute NEW canonical cost
  const allCharges = [...activeCharges, inserted];
  const newCost = computeCorrectContainerCost(container, allCharges, commissionRecord, otherChargeRows);
  if (newCost.fxUnresolved) throw new Error(`FX rate unresolved for container ${container.containerNumber}`);

  // Exact value delta
  const dOldTotal = new Decimal(String(oldCost.totalUsd));
  const dNewTotal = new Decimal(String(newCost.totalUsd));
  const dFullDelta = dNewTotal.minus(dOldTotal);
  const dSupplierDelta = dFullDelta.times(dFraction);

  // Update container
  await updateContainerCost(tx, containerId, newCost);

  // Compute supplier value before (for response)
  const dAuthKg = new Decimal(String(supplierRemainingKg));
  const supplierValueBeforeUsd = supplierLockedRateBefore
    ? new Decimal(supplierLockedRateBefore).times(dAuthKg).toFixed(6)
    : null;

  // Cascade
  const cascadeResult = await cascadeContainerCostChange(
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

  // Capture supplier rate after cascade
  let supplierLockedRateAfter: string | null = null;
  if (supplierId) {
    const [supAfter] = await tx
      .select({ rate: factorySuppliers.currentRawMaterialCostPerKgUsd })
      .from(factorySuppliers)
      .where(and(eq(factorySuppliers.id, supplierId), eq(factorySuppliers.companyId, companyId)));
    supplierLockedRateAfter = supAfter?.rate ?? null;
  }

  // Write daybook entry
  const daybookEntry = await writeDaybookEntry(tx, {
    companyId,
    txDate,
    txType: "OTHER_CHARGE",
    referenceId: containerId,
    referenceTable: "factory_containers",
    description: `${chargeData.description} (post-offload) — container ${container.containerNumber}`,
    currencyCode: chargeData.currencyCode,
    amountCurrency: chargeData.amount,
    fxRateToUsd: chargeData.fxRateToUsd,
    metaJson: JSON.stringify({
      containerId,
      sourceType: "POST_OFFLOAD_ADDITIONAL",
      chargeId: inserted.id,
    }),
  });

  // The journal is mandatory and part of the charge/cost transaction.
  // A posting failure rolls the charge and all costing changes back.
  let voucherId: number;
  {
    const { voucherCompanyId, chargesPayableAcctId } = accountingCtx;
    // Phase 22 (C): through the engine with the charge's posting identity; the
    // FACTORY-POC-{container}-{charge}- family number is read by
    // legacy-links.ts, so it keeps its prefix with a deterministic suffix.
    const { voucher: voucherRow } = await postFactoryVoucherTx(tx, {
      companyId: voucherCompanyId,
      voucherNumber: (generation) => `FACTORY-POC-${containerId}-${inserted.id}-${generation}`,
      voucherDate: txDate,
      description: `${chargeData.description} (post-offload) — container ${container.containerNumber}`,
      currency: chargeData.currencyCode,
      fxRateToUsd: String(chargeData.fxRateToUsd),
      source: {
        sourceType: "factory-post-offload-charge",
        sourceId: `${companyId}:${containerId}:${inserted.id}`,
        phase: "voucher",
      },
      actor: { userId: params.userId ?? null },
      lines: [
        {
          ledgerAccountId: chargesPayableAcctId,
          debit: String(chargeData.amount),
          narration: `${chargeData.description} payable — container ${container.containerNumber}`,
        },
        chargeData.ledgerAccountId
          ? {
              ledgerAccountId: chargeData.ledgerAccountId,
              credit: String(chargeData.amount),
              narration: `${chargeData.description} — container ${container.containerNumber}`,
            }
          : {
              factorySupplierId: chargeData.supplierId,
              credit: String(chargeData.amount),
              narration: `${chargeData.description} — container ${container.containerNumber}`,
            },
      ],
    });
    voucherId = voucherRow.id;
  }

  // Save snapshots + accounting links on the charge row
  await tx
    .update(factoryOffloadAdditionalCharges)
    .set({
      daybookEntryId: daybookEntry.id,
      voucherId,
      supplierLockedRateBefore,
      supplierLockedRateAfter,
      supplierRemainingKgAtApply: dAuthKg.toFixed(3),
      fullContainerValueDeltaUsd: dFullDelta.toFixed(6),
      supplierInventoryValueDeltaUsd: dSupplierDelta.toFixed(6),
      remainingFractionAtApply: dFraction.toFixed(8),
      updatedAt: new Date(),
    })
    .where(eq(factoryOffloadAdditionalCharges.id, inserted.id));

  const supplierValueAfterUsd = supplierLockedRateAfter
    ? new Decimal(supplierLockedRateAfter).times(dAuthKg).toFixed(6)
    : null;

  return {
    chargeId: inserted.id,
    action: "CREATE",
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
  };
}

// Extracted from ./apply.ts: the EDIT branch of the post-offload charge mutation.
import { postFactoryVoucherTx } from "../factoryVoucherPosting";
import { editPostedFactoryVoucherTx } from "../factoryVoucherCorrection";
import Decimal from "decimal.js";
import { toMoney } from "../../../lib/money";
import { and, eq, isNull } from "drizzle-orm";
import {
  factoryOffloadAdditionalCharges,
  factorySuppliers,
  factoryDaybookEntries,
  vouchers,
  voucherEntries,
} from "../../../../shared/schema";
import { cascadeContainerCostChange } from "../rawStockCostCascade";
import { computeCorrectContainerCost } from "../raw-stock-recalc";
import { writeDaybookEntry } from "../../../routes/factory/_helpers";
import { normFactoryEntry } from "../factoryVoucherEntryAmounts";
import {
  assertNoLaterSupplierCostEvents,
  resolveLegacyPostOffloadAccountingLinks,
  updateContainerCost,
} from "./legacy-links";
import { loadActiveCharges } from "./loaders";
import { assertChargePostingDestination, assertResolvedHistoricalLinks } from "./guards";
import type { CascadeResult } from "../rawStockCostCascade";
import { retireChargeVoucherTx } from "./retireChargeVoucher";
import type { DbTransaction } from "../../../db";
import type { computeRemainingFraction, loadCostInputs } from "./loaders";
import type { PostOffloadMutationParams } from "./types";
import type { FactoryContainer } from "@shared/schema";

type ComputeRemainingFractionResult = Awaited<ReturnType<typeof computeRemainingFraction>>;
type LoadCostInputsResult = Awaited<ReturnType<typeof loadCostInputs>>;

export async function applyPostOffloadChargeEdit({
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
  const { chargeId, chargeData, accountingCtx, expectedVersion } = params;
  if (!chargeId) throw new Error("chargeId is required for EDIT");
  if (!chargeData) throw new Error("chargeData is required for EDIT");
  assertChargePostingDestination(
    companyId,
    chargeData,
    accountingCtx,
    "Charge editing requires a valid same-company ledger destination; no unposted charge changes are permitted."
  );

  // Lock the charge row FOR UPDATE
  const [rawCharge] = await tx
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
  if (!rawCharge) throw new Error("Charge not found or already undone");
  if (expectedVersion !== undefined && rawCharge.version !== expectedVersion) {
    const err: Error & { status?: number } = new Error("Charge was modified by another request — please retry");
    err.status = 409;
    throw err;
  }

  // Resolve legacy accounting links if needed
  const chargeRow = await resolveLegacyPostOffloadAccountingLinks(tx, companyId, containerId, rawCharge);
  assertResolvedHistoricalLinks(chargeRow);

  // Compute OLD canonical cost (all active charges, including old version of this one)
  const activeCharges = await loadActiveCharges(tx, companyId, containerId);
  const oldCost = computeCorrectContainerCost(container, activeCharges, commissionRecord, otherChargeRows);
  if (oldCost.fxUnresolved) throw new Error(`FX rate unresolved for container ${container.containerNumber}`);

  // Update the charge row in-place
  await tx
    .update(factoryOffloadAdditionalCharges)
    .set({
      description: chargeData.description,
      amount: String(chargeData.amount),
      currencyCode: chargeData.currencyCode,
      fxRateToUsd: String(chargeData.fxRateToUsd),
      fxRateConfirmed: chargeData.fxRateConfirmed,
      fxRateDate: chargeData.fxRateDate || null,
      ledgerAccountId: chargeData.ledgerAccountId,
      supplierId: chargeData.supplierId,
      updatedByUserId: userId || null,
      updatedAt: new Date(),
      version: (chargeRow.version || 1) + 1,
    })
    .where(eq(factoryOffloadAdditionalCharges.id, chargeId));

  // Compute NEW canonical cost (reload active charges — now reflects the edit)
  const updatedActiveCharges = await loadActiveCharges(tx, companyId, containerId);
  const newCost = computeCorrectContainerCost(container, updatedActiveCharges, commissionRecord, otherChargeRows);
  if (newCost.fxUnresolved) throw new Error(`FX rate unresolved for container ${container.containerNumber}`);

  // Exact delta
  const dOldTotal = new Decimal(String(oldCost.totalUsd));
  const dNewTotal = new Decimal(String(newCost.totalUsd));
  const dFullDelta = dNewTotal.minus(dOldTotal);
  const dSupplierDelta = dFullDelta.times(dFraction);

  const isLegacyUnknownBaseline =
    chargeRow.supplierLockedRateBefore === null && params.legacyBaselineRate !== undefined;
  let cascadeResult: CascadeResult | null = null;

  // Update container cost
  await updateContainerCost(tx, containerId, newCost);

  // Supplier value before
  const dAuthKg = new Decimal(String(supplierRemainingKg));
  const supplierValueBeforeUsd = supplierLockedRateBefore
    ? new Decimal(supplierLockedRateBefore).times(dAuthKg).toFixed(6)
    : null;

  if (isLegacyUnknownBaseline) {
    // Legacy edit: directly set supplier rate using baseline + correct formula
    // Guard: no later supplier cost events
    if (supplierId) {
      await assertNoLaterSupplierCostEvents(tx, companyId, supplierId, new Date(chargeRow.createdAt));
      const chargeAmountUsd = new Decimal(String(chargeData.amount)).times(new Decimal(String(chargeData.fxRateToUsd)));
      const dSupplierInventoryValueDeltaUsd = chargeAmountUsd.times(dFraction);
      const dBaseRate = new Decimal(String(params.legacyBaselineRate));
      const dNewRate = dAuthKg.gt(0) ? dBaseRate.plus(dSupplierInventoryValueDeltaUsd.div(dAuthKg)) : dBaseRate;
      await tx
        .update(factorySuppliers)
        .set({ currentRawMaterialCostPerKgUsd: Decimal.max(0, dNewRate).toFixed(8), updatedAt: new Date() })
        .where(and(eq(factorySuppliers.id, supplierId), eq(factorySuppliers.companyId, companyId)));
      // Also cascade raw-stock cost change without touching supplier rate again
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
    }
  } else {
    // Normal edit cascade
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

  // ── Update daybook entry in-place ──────────────────────────────────────
  let newDaybookEntryId = chargeRow.daybookEntryId;
  if (chargeRow.daybookEntryId) {
    const chargeAmountUsd =
      chargeData.currencyCode === "USD" ? chargeData.amount : chargeData.amount * chargeData.fxRateToUsd;
    await tx
      .update(factoryDaybookEntries)
      .set({
        txDate,
        description: `${chargeData.description} (post-offload) — container ${container.containerNumber}`,
        currencyCode: chargeData.currencyCode,
        amountCurrency: String(chargeData.amount),
        fxRateToUsd: String(chargeData.fxRateToUsd),
        amountUsd: String(chargeAmountUsd),
        metaJson: JSON.stringify({
          containerId,
          sourceType: "POST_OFFLOAD_ADDITIONAL",
          chargeId,
        }),
      })
      .where(eq(factoryDaybookEntries.id, chargeRow.daybookEntryId));
  } else {
    // No prior daybook entry — create one now
    const entry = await writeDaybookEntry(tx, {
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
        chargeId,
      }),
    });
    newDaybookEntryId = entry.id;
  }

  // ── Update voucher in-place ─────────────────────────────────────────────
  let newVoucherId: number | null = chargeRow.voucherId;
  const needsAccounting = !!(chargeData.ledgerAccountId || chargeData.supplierId);
  if (chargeRow.voucherId) {
    if (!needsAccounting) {
      // Remove accounting: retire the voucher (phase 22 C: was an unaudited
      // soft delete that kept its number and posting identity).
      await retireChargeVoucherTx(tx, chargeRow.voucherId, "post-offload-charge-accounting-removed");
      newVoucherId = null;
    } else {
      // Update existing voucher header + recreate entries — an audited
      // open-period edit (phase 22 C, G4/PE9); refused (409, reverse and
      // re-post) in a closed period.
      const { chargesPayableAcctId } = accountingCtx || { chargesPayableAcctId: 0 };
      const editedVoucherId = chargeRow.voucherId;
      const [voucherOwner] = await tx
        .select({ companyId: vouchers.companyId })
        .from(vouchers)
        .where(eq(vouchers.id, editedVoucherId));
      await editPostedFactoryVoucherTx(
        tx,
        {
          companyId: voucherOwner?.companyId ?? companyId,
          voucherIds: [editedVoucherId],
          reason: "post-offload-charge-edit",
          actor: { userId: params.userId ?? null },
          newVoucherDate: txDate,
        },
        async () => {
          const lines = [
            {
              ledgerAccountId: chargesPayableAcctId,
              ...normFactoryEntry(chargeData.currencyCode, String(chargeData.amount), "0", chargeData.fxRateToUsd),
              narration: `${chargeData.description} payable — container ${container.containerNumber}`,
            },
            ...(chargeData.ledgerAccountId
              ? [
                  {
                    ledgerAccountId: chargeData.ledgerAccountId,
                    ...normFactoryEntry(
                      chargeData.currencyCode,
                      "0",
                      String(chargeData.amount),
                      chargeData.fxRateToUsd
                    ),
                    narration: `${chargeData.description} — container ${container.containerNumber}`,
                  },
                ]
              : chargeData.supplierId
                ? [
                    {
                      factorySupplierId: chargeData.supplierId,
                      ...normFactoryEntry(
                        chargeData.currencyCode,
                        "0",
                        String(chargeData.amount),
                        chargeData.fxRateToUsd
                      ),
                      narration: `${chargeData.description} — container ${container.containerNumber}`,
                    },
                  ]
                : []),
          ];
          await tx
            .update(vouchers)
            .set({
              voucherDate: txDate,
              description: `${chargeData.description} (post-offload) — container ${container.containerNumber}`,
              totalAmount: String(chargeData.amount),
              currency: chargeData.currencyCode,
              exchangeRate: String(chargeData.fxRateToUsd),
            })
            .where(eq(vouchers.id, editedVoucherId));
          // Delete and recreate entries
          await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, editedVoucherId));
          await tx.insert(voucherEntries).values(lines.map((line) => ({ voucherId: editedVoucherId, ...line })));
        }
      );
    }
  } else if (needsAccounting && accountingCtx && accountingCtx.chargesPayableAcctId > 0) {
    // Create a new voucher for this charge that previously had none
    const { voucherCompanyId, chargesPayableAcctId } = accountingCtx;
    const { voucher: voucherRow } = await postFactoryVoucherTx(tx, {
      companyId: voucherCompanyId,
      voucherNumber: (generation) => `FACTORY-POC-${containerId}-${chargeId}-${generation}`,
      voucherDate: txDate,
      description: `${chargeData.description} (post-offload) — container ${container.containerNumber}`,
      currency: chargeData.currencyCode,
      fxRateToUsd: String(chargeData.fxRateToUsd),
      source: {
        sourceType: "factory-post-offload-charge",
        sourceId: `${companyId}:${containerId}:${chargeId}`,
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
    newVoucherId = voucherRow.id;
  }

  // Save snapshots on the charge row
  await tx
    .update(factoryOffloadAdditionalCharges)
    .set({
      daybookEntryId: newDaybookEntryId,
      voucherId: newVoucherId,
      supplierLockedRateBefore: isLegacyUnknownBaseline
        ? String(params.legacyBaselineRate)
        : chargeRow.supplierLockedRateBefore,
      supplierLockedRateAfter,
      supplierRemainingKgAtApply: dAuthKg.toFixed(3),
      fullContainerValueDeltaUsd: dFullDelta.toFixed(6),
      supplierInventoryValueDeltaUsd: dSupplierDelta.toFixed(6),
      remainingFractionAtApply: dFraction.toFixed(8),
      updatedByUserId: userId || null,
      // version was already bumped in the data update above
    })
    .where(eq(factoryOffloadAdditionalCharges.id, chargeId));

  const supplierValueAfterUsd = supplierLockedRateAfter
    ? new Decimal(supplierLockedRateAfter).times(dAuthKg).toFixed(6)
    : null;

  return {
    chargeId,
    action: "EDIT",
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

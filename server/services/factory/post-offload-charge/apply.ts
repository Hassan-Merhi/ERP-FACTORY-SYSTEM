import type { DbTransaction } from "../../../db";
import { retireVouchersTx } from "../../accounting/voucherRetirement";
import { postFactoryVoucherTx } from "../factoryVoucherPosting";
import { editPostedFactoryVoucherTx } from "../factoryVoucherCorrection";
import Decimal from "decimal.js";
import { toMoney } from "../../../lib/money";
import { and, eq, isNull } from "drizzle-orm";
import {
  factoryContainers,
  factoryOffloadAdditionalCharges,
  factorySuppliers,
  factoryDaybookEntries,
  vouchers,
  voucherEntries,
} from "../../../../shared/schema";
import { cascadeContainerCostChange } from "../rawStockCostCascade";
import { computeCorrectContainerCost } from "../raw-stock-recalc";
import { getAuthoritativeSupplierRemainingKg } from "../rawStockLockedRate";
import { writeDaybookEntry } from "../../../routes/factory/_helpers";
import { normFactoryEntry } from "../factoryVoucherEntryAmounts";
import {
  assertNoLaterSupplierCostEvents,
  getSupplierRateForUpdate,
  resolveLegacyPostOffloadAccountingLinks,
  updateContainerCost,
} from "./legacy-links";
import { computeRemainingFraction, loadActiveCharges, loadCostInputs } from "./loaders";
import { PostOffloadMutationParams, PostOffloadMutationResult } from "./types";
import type { CascadeResult } from "../rawStockCostCascade";

/** Retire a charge's voucher in its own company (audited; number and identity released). */
async function retireChargeVoucherTx(tx: DbTransaction, voucherId: number, reason: string): Promise<void> {
  const [owner] = await tx.select({ companyId: vouchers.companyId }).from(vouchers).where(eq(vouchers.id, voucherId));
  if (!owner) return;
  await retireVouchersTx(tx, { companyId: owner.companyId, voucherIds: [voucherId], reason });
}

export async function applyPostOffloadChargeMutation(
  tx: DbTransaction,
  params: PostOffloadMutationParams
): Promise<PostOffloadMutationResult> {
  const { action, companyId, containerId, txDate, userId } = params;

  // ── Load container (with FOR UPDATE lock) ──────────────────────────────────
  const [container] = await tx
    .select()
    .from(factoryContainers)
    .where(and(eq(factoryContainers.id, containerId), eq(factoryContainers.companyId, companyId)))
    .for("update");
  if (!container) throw new Error("Container not found");

  const supplierId = container.supplierId as number | null;

  // ── Shared cost inputs ─────────────────────────────────────────────────────
  const { commissionRecord, otherChargeRows } = await loadCostInputs(tx, companyId, containerId);

  // ── Capture supplier rate before mutation ─────────────────────────────────
  let supplierLockedRateBefore: string | null = null;
  let supplierRemainingKg = 0;
  if (supplierId) {
    supplierLockedRateBefore = await getSupplierRateForUpdate(tx, companyId, supplierId);
    supplierRemainingKg = await getAuthoritativeSupplierRemainingKg(tx, companyId, supplierId);
  }

  // ── Remaining fraction ─────────────────────────────────────────────────────
  const { dReceivedKg, dRemainingKg, dFraction } = await computeRemainingFraction(tx, companyId, containerId);

  // ─────────────────────────────────────────────────────────────────────────
  // Action: LEGACY_REBUILD
  // Fix the supplier locked rate for a charge that was applied with the old
  // (pre-fix) formula. Does NOT change container/raw-stock costs or accounting.
  // ─────────────────────────────────────────────────────────────────────────
  if (action === "LEGACY_REBUILD") {
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

  // ─────────────────────────────────────────────────────────────────────────
  // Action: CREATE
  // ─────────────────────────────────────────────────────────────────────────
  if (action === "CREATE") {
    const { chargeData, accountingCtx } = params;
    if (!chargeData) throw new Error("chargeData is required for CREATE");
    // Fail closed before any inventory costing or charge is saved. A charge
    // without both sides of its ledger posting would otherwise become a
    // permanent unposted financial operation.
    if (
      !accountingCtx ||
      accountingCtx.voucherCompanyId !== companyId ||
      accountingCtx.chargesPayableAcctId <= 0 ||
      Number(Boolean(chargeData.ledgerAccountId)) + Number(Boolean(chargeData.supplierId)) !== 1
    ) {
      throw new Error(
        "Post-offload charge requires exactly one company-owned expense account or supplier and a valid payable account."
      );
    }

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

  // ─────────────────────────────────────────────────────────────────────────
  // Action: EDIT
  // ─────────────────────────────────────────────────────────────────────────
  if (action === "EDIT") {
    const { chargeId, chargeData, accountingCtx, expectedVersion } = params;
    if (!chargeId) throw new Error("chargeId is required for EDIT");
    if (!chargeData) throw new Error("chargeData is required for EDIT");
    if (
      !accountingCtx ||
      accountingCtx.voucherCompanyId !== companyId ||
      accountingCtx.chargesPayableAcctId <= 0 ||
      Number(Boolean(chargeData.ledgerAccountId)) + Number(Boolean(chargeData.supplierId)) !== 1
    ) {
      throw new Error(
        "Charge editing requires a valid same-company ledger destination; no unposted charge changes are permitted."
      );
    }

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
    // Never edit/undo a historical charge if its accounting identity cannot be
    // resolved. Otherwise the charge/cost changes while the original payable
    // voucher survives and cannot be retired or updated.
    if (!chargeRow.voucherId || !chargeRow.daybookEntryId) {
      throw new Error(
        `Charge #${chargeRow.id} has missing historical voucher/daybook links. Reconcile the original records before editing or undoing it.`
      );
    }

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
        const chargeAmountUsd = new Decimal(String(chargeData.amount)).times(
          new Decimal(String(chargeData.fxRateToUsd))
        );
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

  // ─────────────────────────────────────────────────────────────────────────
  // Action: UNDO
  // ─────────────────────────────────────────────────────────────────────────
  if (action === "UNDO") {
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
    // Never edit/undo a historical charge if its accounting identity cannot be
    // resolved. Otherwise the charge/cost changes while the original payable
    // voucher survives and cannot be retired or updated.
    if (!chargeRow.voucherId || !chargeRow.daybookEntryId) {
      throw new Error(
        `Charge #${chargeRow.id} has missing historical voucher/daybook links. Reconcile the original records before editing or undoing it.`
      );
    }

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
          supplierLockedRateAfter: isLegacyUnknownBaseline
            ? String(params.legacyBaselineRate)
            : supplierLockedRateAfter,
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

  throw new Error(`Unknown action: ${action}`);
}

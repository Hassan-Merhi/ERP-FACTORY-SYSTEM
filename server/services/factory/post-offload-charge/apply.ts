import type { DbTransaction } from "../../../db";
import {
  infrastructurePostingIdentity,
  insertInfrastructureVoucherTx,
} from "../../accounting/infrastructureVoucherIdentity";
import Decimal from "decimal.js";
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
import {
  assertNoLaterSupplierCostEvents,
  getSupplierRateForUpdate,
  resolveLegacyPostOffloadAccountingLinks,
  updateContainerCost,
} from "./legacy-links";
import { computeRemainingFraction, loadActiveCharges, loadCostInputs } from "./loaders";
import { PostOffloadMutationParams, PostOffloadMutationResult } from "./types";
import type { CascadeResult } from "../rawStockCostCascade";

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
      const err: any = new Error("Charge was modified by another request — please retry");
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
      oldContainerCostPerKgUsd: parseFloat(String(container.ratePerKgUsd || "0")),
      newContainerCostPerKgUsd: parseFloat(String(container.ratePerKgUsd || "0")),
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

    // Write voucher if accounting context is provided
    let voucherId: number | null = null;
    if (accountingCtx && accountingCtx.chargesPayableAcctId > 0) {
      const { voucherCompanyId, chargesPayableAcctId } = accountingCtx;
      const voucherNum = `FACTORY-POC-${containerId}-${inserted.id}-${Date.now()}`;
      const { voucher: voucherRow } = await insertInfrastructureVoucherTx(
        tx,
        {
          companyId: voucherCompanyId,
          voucherType: "Journal",
          voucherNumber: voucherNum,
          voucherDate: txDate,
          description: `${chargeData.description} (post-offload) — container ${container.containerNumber}`,
          totalAmount: String(chargeData.amount),
          currency: chargeData.currencyCode,
          exchangeRate: String(chargeData.fxRateToUsd),
          sourceModule: "FACTORY",
        },
        infrastructurePostingIdentity(
          "factory-post-offload-charge",
          `${companyId}:${containerId}:${inserted.id}`,
          "voucher"
        ),
        params
      );
      voucherId = voucherRow.id;

      await tx.insert(voucherEntries).values({
        voucherId: voucherRow.id,
        ledgerAccountId: chargesPayableAcctId,
        debitAmount: String(chargeData.amount),
        creditAmount: "0",
        narration: `${chargeData.description} payable — container ${container.containerNumber}`,
      });
      if (chargeData.ledgerAccountId) {
        await tx.insert(voucherEntries).values({
          voucherId: voucherRow.id,
          ledgerAccountId: chargeData.ledgerAccountId,
          debitAmount: "0",
          creditAmount: String(chargeData.amount),
          narration: `${chargeData.description} — container ${container.containerNumber}`,
        });
      } else if (chargeData.supplierId) {
        await tx.insert(voucherEntries).values({
          voucherId: voucherRow.id,
          factorySupplierId: chargeData.supplierId,
          debitAmount: "0",
          creditAmount: String(chargeData.amount),
          narration: `${chargeData.description} — container ${container.containerNumber}`,
        });
      }
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
      oldContainerCostPerKgUsd: parseFloat(String(container.ratePerKgUsd || "0")),
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
      const err: any = new Error("Charge was modified by another request — please retry");
      err.status = 409;
      throw err;
    }

    // Resolve legacy accounting links if needed
    const chargeRow = await resolveLegacyPostOffloadAccountingLinks(tx, companyId, containerId, rawCharge);

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
    let newVoucherId = chargeRow.voucherId;
    const needsAccounting = !!(chargeData.ledgerAccountId || chargeData.supplierId);
    if (chargeRow.voucherId) {
      if (!needsAccounting) {
        // Remove accounting: soft-delete the voucher
        await tx.update(vouchers).set({ deletedAt: new Date() }).where(eq(vouchers.id, chargeRow.voucherId));
        newVoucherId = null;
      } else {
        // Update existing voucher header + recreate entries
        const { voucherCompanyId: _voucherCompanyId, chargesPayableAcctId } = accountingCtx || {
          voucherCompanyId: companyId,
          chargesPayableAcctId: 0,
        };
        await tx
          .update(vouchers)
          .set({
            voucherDate: txDate,
            description: `${chargeData.description} (post-offload) — container ${container.containerNumber}`,
            totalAmount: String(chargeData.amount),
            currency: chargeData.currencyCode,
            exchangeRate: String(chargeData.fxRateToUsd),
          })
          .where(eq(vouchers.id, chargeRow.voucherId));
        // Delete and recreate entries
        await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, chargeRow.voucherId));
        await tx.insert(voucherEntries).values({
          voucherId: chargeRow.voucherId,
          ledgerAccountId: chargesPayableAcctId,
          debitAmount: String(chargeData.amount),
          creditAmount: "0",
          narration: `${chargeData.description} payable — container ${container.containerNumber}`,
        });
        if (chargeData.ledgerAccountId) {
          await tx.insert(voucherEntries).values({
            voucherId: chargeRow.voucherId,
            ledgerAccountId: chargeData.ledgerAccountId,
            debitAmount: "0",
            creditAmount: String(chargeData.amount),
            narration: `${chargeData.description} — container ${container.containerNumber}`,
          });
        } else if (chargeData.supplierId) {
          await tx.insert(voucherEntries).values({
            voucherId: chargeRow.voucherId,
            factorySupplierId: chargeData.supplierId,
            debitAmount: "0",
            creditAmount: String(chargeData.amount),
            narration: `${chargeData.description} — container ${container.containerNumber}`,
          });
        }
      }
    } else if (needsAccounting && accountingCtx && accountingCtx.chargesPayableAcctId > 0) {
      // Create a new voucher for this charge that previously had none
      const { voucherCompanyId, chargesPayableAcctId } = accountingCtx;
      const voucherNum = `FACTORY-POC-${containerId}-${chargeId}-${Date.now()}`;
      const { voucher: voucherRow } = await insertInfrastructureVoucherTx(
        tx,
        {
          companyId: voucherCompanyId,
          voucherType: "Journal",
          voucherNumber: voucherNum,
          voucherDate: txDate,
          description: `${chargeData.description} (post-offload) — container ${container.containerNumber}`,
          totalAmount: String(chargeData.amount),
          currency: chargeData.currencyCode,
          exchangeRate: String(chargeData.fxRateToUsd),
          sourceModule: "FACTORY",
        },
        infrastructurePostingIdentity(
          "factory-post-offload-charge",
          `${companyId}:${containerId}:${chargeId}`,
          "voucher"
        ),
        params
      );
      newVoucherId = voucherRow.id;
      await tx.insert(voucherEntries).values({
        voucherId: voucherRow.id,
        ledgerAccountId: chargesPayableAcctId,
        debitAmount: String(chargeData.amount),
        creditAmount: "0",
        narration: `${chargeData.description} payable — container ${container.containerNumber}`,
      });
      if (chargeData.ledgerAccountId) {
        await tx.insert(voucherEntries).values({
          voucherId: voucherRow.id,
          ledgerAccountId: chargeData.ledgerAccountId,
          debitAmount: "0",
          creditAmount: String(chargeData.amount),
          narration: `${chargeData.description} — container ${container.containerNumber}`,
        });
      } else if (chargeData.supplierId) {
        await tx.insert(voucherEntries).values({
          voucherId: voucherRow.id,
          factorySupplierId: chargeData.supplierId,
          debitAmount: "0",
          creditAmount: String(chargeData.amount),
          narration: `${chargeData.description} — container ${container.containerNumber}`,
        });
      }
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
      oldContainerCostPerKgUsd: parseFloat(String(container.ratePerKgUsd || "0")),
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
        oldContainerCostPerKgUsd: parseFloat(String(container.ratePerKgUsd || "0")),
        newContainerCostPerKgUsd: parseFloat(String(container.ratePerKgUsd || "0")),
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
      const err: any = new Error("Charge was modified by another request — please retry");
      err.status = 409;
      throw err;
    }

    // Resolve legacy accounting links if needed
    const chargeRow = await resolveLegacyPostOffloadAccountingLinks(tx, companyId, containerId, rawCharge);

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
      await tx.update(vouchers).set({ deletedAt: now }).where(eq(vouchers.id, chargeRow.voucherId));
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
          amountCurrency: -parseFloat(String(origEntry.amountCurrency || "0")),
          fxRateToUsd: parseFloat(String(origEntry.fxRateToUsd || "1")),
          amountUsd: -parseFloat(String(origEntry.amountUsd || "0")),
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
      oldContainerCostPerKgUsd: parseFloat(String(container.ratePerKgUsd || "0")),
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

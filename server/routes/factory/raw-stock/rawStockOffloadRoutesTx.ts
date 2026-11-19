// Extracted from ./rawStockOffloadRoutes.ts: a stage of rawStockOffloadRoutes.
import Decimal from "decimal.js";
import { applyOffloadMovingAverage } from "../../../services/factory/rawStockLockedRate";
import {
  factoryContainers,
  factoryRawStock,
  factoryMixBatchSources,
  factoryContainerCommissions,
  factoryOffloadAdditionalCharges,
  factoryContainerReceipts,
} from "@shared/schema";
import { eq } from "drizzle-orm";
import { applySubsequentReceipt } from "./subsequentReceipt";
import { parseMoneyInput } from "../../../lib/money";
import { syncContainerCommissionJournalTx } from "../../../services/factory/containerCommissionJournal";
import { requestNumber } from "./rawStockOffloadRoutesHelpers";
import type { Request } from "express";
import type { DbTransaction } from "../../../db";
import type { rawStockOffloadRoutesStep } from "./rawStockOffloadRoutesStep";

type RawStockOffloadRoutesStepResult = Awaited<ReturnType<typeof rawStockOffloadRoutesStep>>;

export async function rawStockOffloadRoutesTx({
  rso1,
  offload,
  tx,
  req,
  writeOffloadAuditTx,
}: {
  rso1: Extract<RawStockOffloadRoutesStepResult, { done: false }>;
  offload: { rawStock?: typeof factoryRawStock.$inferSelect };
  tx: DbTransaction;
  req: Request;
  writeOffloadAuditTx: (tx: DbTransaction) => Promise<void>;
}) {
  const {
    isSubsequentReceipt,
    companyId,
    containerId,
    container,
    currencyCode,
    fxRate,
    offloadDate,
    declaredKg,
    dReceivedKg,
    mixBatchAllocationsArr,
    reqDestination,
    idempotencyKey,
    materialSupplier,
    dCostPerKgUsd,
    commInsertValues,
    dInclusiveCostPerKg,
    newStatus,
    finalPayableAmount,
    differenceKg,
    finalPayableAmountUsd,
    freightVal,
    reqFreightAccountId,
    effectiveFreightSupplierId,
    otherChargesVal,
    ocCcy,
    reqOtherChargesAccountId,
    reqOtherChargesSupplierId,
    commTotalVal,
    commCurrencyForUsd,
    commFxRateForUsd,
    dutyStatus,
    reqDutyAmount,
    reqDutyAccountId,
    reqDutyNotes,
    additionalChargesArr,
  } = rso1;
  // ── SUBSEQUENT RECEIPT PATH ───────────────────────────────────────────────
  // When a raw-stock row already exists (PARTIALLY_RECEIVED container), we only:
  //   1. Apply the moving-average using the FIXED rate from the first offload
  //   2. Increment raw-stock receivedKg
  //   3. Optionally insert mix-batch sources at the same fixed rate
  //   4. Update the container's cumulative actualReceivedKg and status
  //   5. Record this event in factory_container_receipts
  // Financial posting (commission, daybook, freight/OC vouchers) already happened
  // on the first receipt — do NOT repeat it here.
  if (isSubsequentReceipt) {
    // Continuation receipt: stock movement only, no financial posting.
    offload.rawStock = await applySubsequentReceipt({
      tx,
      companyId: companyId,
      containerId: containerId,
      container: container,
      currencyCode: currencyCode,
      fxRate: fxRate,
      offloadDate: offloadDate,
      declaredKg: declaredKg,
      dReceivedKg: dReceivedKg,
      mixBatchAllocationsArr: mixBatchAllocationsArr,
      reqDestination: reqDestination,
      idempotencyKey: idempotencyKey,
      userId: req.session.userId || null,
      supplierName: materialSupplier?.name ?? null,
    });
    await writeOffloadAuditTx(tx);
    return { done: true as const, value: undefined }; // Skip all other financial posting — already done on first receipt
  }

  // ── FIRST RECEIPT PATH ───────────────────────────────────────────────────
  // 0. Update the supplier's locked raw-material rate using the moving-average
  //    formula, BEFORE inserting the new raw-stock row, so "remaining kg" reflects
  //    stock immediately before this offload (already-consumed stock never
  //    re-enters the average). Row-locks the supplier to serialize concurrent
  //    offloads. Only applies to a real supplier — manual/no-supplier containers
  //    have no locked rate to maintain.
  // Capture newLockedRate so mix-batch allocations created in this same
  // transaction use the post-offload supplier moving-average rate, not the
  // individual container's landed cost (which is correct only for raw-stock
  // valuation, not for supplier-level blended cost tracking).
  let firstReceiptNewLockedRate = dCostPerKgUsd.toNumber(); // fallback for no-supplier
  if (container.supplierId) {
    const movAvgResult = await applyOffloadMovingAverage(tx, {
      companyId: companyId,
      supplierId: container.supplierId,
      newReceivedKg: dReceivedKg.toNumber(),
      newContainerLandedCostPerKgUsd: dCostPerKgUsd.toNumber(),
    });
    firstReceiptNewLockedRate = movAvgResult.newLockedRate;
  }

  // 1. Commission INSERT
  if (commInsertValues) {
    [rso1.commissionRecord] = await tx.insert(factoryContainerCommissions).values(commInsertValues).returning();
  }

  // 2. Raw stock INSERT
  [offload.rawStock] = await tx
    .insert(factoryRawStock)
    .values({
      companyId: companyId,
      containerId: containerId,
      receivedKg: dReceivedKg.toDecimalPlaces(3).toFixed(3),
      costPerKg: dInclusiveCostPerKg.toDecimalPlaces(6).toFixed(6),
      costPerKgUsd: dCostPerKgUsd.toDecimalPlaces(6).toFixed(6),
    })
    .returning();

  // 3. Record the first receipt event (enables idempotency on retries and audit history).
  //    The subsequent-receipt idempotency check looks for this row by idempotencyKey.
  await tx.insert(factoryContainerReceipts).values({
    companyId: companyId,
    containerId: containerId,
    receiptDate: offloadDate,
    receivedKg: dReceivedKg.toDecimalPlaces(3).toFixed(3),
    cumulativeReceivedKg: dReceivedKg.toDecimalPlaces(3).toFixed(3),
    fixedCostPerKg: dInclusiveCostPerKg.toDecimalPlaces(6).toFixed(6),
    fixedCostPerKgUsd: dCostPerKgUsd.toDecimalPlaces(6).toFixed(6),
    receiptValue: dReceivedKg.times(dInclusiveCostPerKg).toDecimalPlaces(6).toFixed(6),
    receiptValueUsd: dReceivedKg.times(dCostPerKgUsd).toDecimalPlaces(6).toFixed(6),
    currencyCode: currencyCode,
    fxRateToUsd: String(fxRate),
    createdBy: req.session.userId || null,
    idempotencyKey: idempotencyKey || null,
  });

  // 4. Mix batch source INSERTs
  //    Supplier-backed sources must be priced at the post-offload supplier
  //    moving-average rate (firstReceiptNewLockedRate), NOT the container's
  //    individual landed cost (dCostPerKgUsd). The container's own USD rate
  //    is the canonical raw-stock valuation; the supplier moving-average is
  //    the correct blended rate for all material consumed from that supplier.
  //    FIFO / containerId is stored for provenance only.
  for (const alloc of mixBatchAllocationsArr) {
    const dAllocKg = parseMoneyInput(alloc.weightKg || "0");
    if (!alloc.mixBatchId || !dAllocKg || dAllocKg.lessThanOrEqualTo(0)) continue;
    // Rate: supplier moving-average for supplier-backed containers;
    //       container's own USD rate for no-supplier containers.
    const dAllocRate = container.supplierId ? new Decimal(firstReceiptNewLockedRate) : dCostPerKgUsd;
    // sourceType: SUPPLIER_FIFO when supplierId + containerId present,
    //             CONTAINER_DIRECT when no supplier.
    const firstSrcType = container.supplierId ? "SUPPLIER_FIFO" : "CONTAINER_DIRECT";
    await tx.insert(factoryMixBatchSources).values({
      mixBatchId: parseInt(alloc.mixBatchId),
      containerId: containerId,
      supplierId: container.supplierId || null,
      sourceType: firstSrcType,
      weightKg: dAllocKg.toFixed(),
      costPerKg: dAllocRate.toDecimalPlaces(6).toFixed(6),
      totalCost: dAllocKg.times(dAllocRate).toDecimalPlaces(6).toFixed(6),
      inventorySupplierId: container.supplierId || null,
    });
  }

  // 5. Container UPDATE (status + financials + pre-offload snapshot)
  await tx
    .update(factoryContainers)
    .set({
      status: newStatus,
      declaredKg: String(declaredKg),
      actualReceivedKg: dReceivedKg.toDecimalPlaces(3).toFixed(3),
      finalPayableAmount: finalPayableAmount,
      differenceKg: differenceKg,
      currencyCode: currencyCode,
      fxRateToUsd: String(fxRate),
      // fxRate was already resolved above (explicit rate, USD, a fetched live
      // rate, or the container's own already-confirmed rate) — never left at the
      // unset default — so this offload's rate is confirmed. Without this flag,
      // every freshly-offloaded non-USD container would still read back as
      // "unresolved" everywhere fxRateConfirmed is checked (recalc, reverse-offload,
      // supplier balance reconciliation), even though the rate is known-good.
      fxRateConfirmed: true,
      fxRateToUsdOffload: String(fxRate),
      fxRateDateOffload: offloadDate,
      ratePerKgUsd: dCostPerKgUsd.toDecimalPlaces(6).toFixed(6),
      finalPayableAmountUsd: finalPayableAmountUsd,
      freight: String(freightVal),
      freightAccountId: reqFreightAccountId ? parseInt(reqFreightAccountId) : null,
      freightSupplierId: effectiveFreightSupplierId,
      // Record how freight was paid so the supplier balance formula
      // (isSupplierPaidFreight) does not default to "supplier" and
      // wrongly include own-account freight in the supplier's payable.
      freightPaidBy: effectiveFreightSupplierId
        ? "supplier"
        : reqFreightAccountId
          ? "own"
          : container.freightPaidBy || "supplier",
      // When own-account is used, persist the credit account so the
      // reverse-offload can correctly restore it without falling back
      // to the material supplier.
      freightOwnAccountId: !effectiveFreightSupplierId && reqFreightAccountId ? parseInt(reqFreightAccountId) : null,
      otherCharges: String(otherChargesVal),
      otherChargesCurrencyCode: ocCcy || null,
      otherChargesAccountId: reqOtherChargesAccountId ? parseInt(reqOtherChargesAccountId) : null,
      otherChargesSupplierId: reqOtherChargesSupplierId ? parseInt(reqOtherChargesSupplierId) : null,
      commissionAmount: commTotalVal > 0 ? String(commTotalVal) : container.commissionAmount || "0",
      commissionCurrencyCode: commTotalVal > 0 ? commCurrencyForUsd : container.commissionCurrencyCode || "USD",
      // Persist the resolved commission-specific FX rate so computeCorrectContainerCost
      // and repair scripts can use it without re-fetching.  When there is no commission
      // (commTotalVal == 0) clear all three fields so stale pre-offload values don't linger.
      commissionFxRateToUsd: commTotalVal > 0 ? String(commFxRateForUsd) : null,
      commissionFxRateConfirmed: commTotalVal > 0,
      commissionFxRateDate: commTotalVal > 0 ? offloadDate : null,
      dutyAmount: dutyStatus !== "NONE" ? String(requestNumber(reqDutyAmount || "0")) : null,
      dutyAccountId: reqDutyAccountId ? parseInt(reqDutyAccountId) : null,
      dutyStatus: dutyStatus,
      dutyNotes: reqDutyNotes || null,
      preOffloadFreight: container.freight || "0",
      preOffloadFreightCurrencyCode: container.freightCurrencyCode || container.currencyCode || "USD",
      preOffloadFreightAccountId: container.freightAccountId || null,
      preOffloadFreightSupplierId: container.freightSupplierId || null,
      preOffloadOtherCharges: container.otherCharges || "0",
      preOffloadOtherChargesAccountId: container.otherChargesAccountId || null,
      preOffloadOtherChargesSupplierId: container.otherChargesSupplierId || null,
      preOffloadStatus: container.status,
      preOffloadCommissionAmount: container.commissionAmount || "0",
      preOffloadCommissionCurrencyCode: container.commissionCurrencyCode || "USD",
      preOffloadCommissionAccountId: container.commissionAccountId || null,
      preOffloadCommissionSupplierId: container.commissionSupplierId || null,
      preOffloadCommissionNotes: container.commissionNotes || null,
      destination: reqDestination ? String(reqDestination).trim() : container.destination || null,
      updatedAt: new Date(),
    })
    .where(eq(factoryContainers.id, containerId));
  // Wave 8.4 continuation: the commission journal follows the commission just written.
  await syncContainerCommissionJournalTx(tx, companyId, containerId);

  // 6. Additional charges INSERTs
  const insertedAdditionalCharges = [];
  if (additionalChargesArr.length > 0) {
    for (const charge of additionalChargesArr) {
      if (requestNumber(charge.amount || "0") > 0) {
        const [inserted] = await tx
          .insert(factoryOffloadAdditionalCharges)
          .values({
            companyId: companyId,
            containerId: containerId,
            description: charge.description || "Additional Charge",
            amount: String(charge.amount),
            currencyCode: charge.currencyCode || currencyCode,
            fxRateToUsd: String(charge.fxRateToUsd || (currencyCode === "USD" ? "1" : String(fxRate))),
            // Same reasoning as the container/commission fix above: the rate used
            // here is either explicitly supplied on the charge or the already-
            // resolved offload fxRate, never an unset default — mark it confirmed
            // so downstream reads (recalc, reversal, reconciliation) don't treat
            // a known-good rate as unresolved.
            fxRateConfirmed: true,
            ledgerAccountId: charge.ledgerAccountId ? parseInt(charge.ledgerAccountId) : null,
            supplierId: charge.supplierId ? parseInt(charge.supplierId) : null,
          })
          .returning();
        insertedAdditionalCharges.push(inserted);
      }
    }
  }

  return { done: false as const, insertedAdditionalCharges };
}

import Decimal from "decimal.js";
import { eq, and, isNull } from "drizzle-orm";

import { factoryContainers, factoryRawStock, factoryMixBatchSources, factoryContainerReceipts } from "@shared/schema";

import { db } from "../../../db";

import { writeDaybookEntry } from "../_helpers";
import { getLockedSupplierRateReadOnly } from "../../../services/factory/rawStockLockedRate";

/**
 * The continuation-receipt path of POST /api/factory/raw-stock/offload.
 *
 * A PARTIALLY_RECEIVED container can take further kg. When it does, only the
 * stock movement is repeated: the supplier moving-average remains locked at the
 * rate established by the first receipt, raw-stock and container kg are
 * incremented, mix-batch sources are optionally added at that same locked rate,
 * and the event is recorded. No financial posting happens — commission,
 * freight, other charges and their vouchers were all posted on the first
 * receipt, and repeating them would double-count.
 *
 * It runs inside the caller's transaction and returns the raw-stock row the
 * response needs, which is the one value the branch produced for its caller.
 *
 * config/report-characterization.json pins the endpoint's output across the move.
 */
/** The transaction handle drizzle hands to a `db.transaction` callback. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** One mix-batch allocation as the offload request sends it. */
export interface MixBatchAllocationInput {
  mixBatchId?: string;
  weightKg?: string;
}

export interface SubsequentReceiptContext {
  tx: Tx;
  companyId: number;
  containerId: number;
  container: typeof factoryContainers.$inferSelect;
  currencyCode: string;
  fxRate: number;
  offloadDate: string;
  declaredKg: string;
  dReceivedKg: Decimal;
  mixBatchAllocationsArr: MixBatchAllocationInput[];
  reqDestination?: string;
  idempotencyKey?: string | null;
  userId: string | null;
}

export async function applySubsequentReceipt(
  ctx: SubsequentReceiptContext
): Promise<typeof factoryRawStock.$inferSelect> {
  const {
    tx,
    companyId,
    containerId,
    container,
    currencyCode,
    fxRate,
    offloadDate,
    declaredKg: _declaredKg,
    dReceivedKg,
    mixBatchAllocationsArr,
    reqDestination,
    idempotencyKey,
    userId,
  } = ctx;

  // ── Concurrency-safe continuation receipt ─────────────────────────────
  // Lock container + raw-stock FOR UPDATE so two simultaneous receipts for
  // the same container cannot race and produce wrong cumulative kg.
  const [lockedContainer] = await tx
    .select()
    .from(factoryContainers)
    .where(and(eq(factoryContainers.id, containerId), eq(factoryContainers.companyId, companyId)))
    .for("update");
  if (!lockedContainer) throw new Error("Container not found inside transaction");
  if (lockedContainer.status === "OFFLOADED") throw new Error("This container has already been fully offloaded");

  const [lockedRawStock] = await tx
    .select()
    .from(factoryRawStock)
    .where(and(eq(factoryRawStock.companyId, companyId), eq(factoryRawStock.containerId, containerId)))
    .for("update");
  if (!lockedRawStock) throw new Error("No raw-stock record found for this container");

  // Re-derive all amounts from locked rows — never from pre-transaction reads.
  const lockedValuationKg = new Decimal(
    lockedContainer.totalKg || lockedContainer.declaredKg || lockedContainer.actualReceivedKg || "0"
  );
  const dPrevReceivedKg = new Decimal(lockedRawStock.receivedKg || "0");
  const dRemainingKg = lockedValuationKg.minus(dPrevReceivedKg);

  if (dReceivedKg.gt(dRemainingKg.plus(new Decimal("0.001")))) {
    throw new Error(
      `Cannot receive ${dReceivedKg.toDecimalPlaces(3).toFixed(3)} kg — only ${dRemainingKg.toDecimalPlaces(3).toFixed(3)} kg remaining from valuation ${lockedValuationKg.toDecimalPlaces(3).toFixed(3)} kg`
    );
  }
  const dNewCumulativeKg = dPrevReceivedKg.plus(dReceivedKg);

  // ── Idempotency check — must happen AFTER locking ────────────────────
  if (idempotencyKey) {
    const [existingReceipt] = await tx
      .select({ id: factoryContainerReceipts.id })
      .from(factoryContainerReceipts)
      .where(
        and(
          eq(factoryContainerReceipts.companyId, companyId),
          eq(factoryContainerReceipts.containerId, containerId),
          eq(factoryContainerReceipts.idempotencyKey, idempotencyKey),
          isNull(factoryContainerReceipts.deletedAt)
        )
      );
    if (existingReceipt) {
      // Already applied — return current state without re-posting.
      return lockedRawStock;
    }
  }

  const fixedCostPerKg = parseFloat(lockedRawStock.costPerKg || "0");
  const fixedCostPerKgUsd = parseFloat(lockedRawStock.costPerKgUsd || "0");
  const thisReceiptKg = dReceivedKg.toNumber();
  const newCumulativeKg = dNewCumulativeKg.toDecimalPlaces(3).toNumber();
  const lockedValuationKgNum = lockedValuationKg.toDecimalPlaces(3).toNumber();

  // 0. A continuation receipt must not reprice the supplier. The first receipt
  //    is the supplier-cost event; later kg for that same container use the
  //    already-established supplier moving-average. This preserves the locked
  //    supplier cost while still letting mix-batch provenance point to this
  //    container receipt.
  let supplierLockedRate = fixedCostPerKgUsd; // fallback for no-supplier containers
  if (lockedContainer.supplierId) {
    const { rate } = await getLockedSupplierRateReadOnly(tx, companyId, lockedContainer.supplierId);
    if (rate > 0) supplierLockedRate = rate;
  }

  // 1. Update raw-stock receivedKg (cumulative) using locked row id
  await tx
    .update(factoryRawStock)
    .set({ receivedKg: dNewCumulativeKg.toDecimalPlaces(3).toFixed(3) })
    .where(eq(factoryRawStock.id, lockedRawStock.id));
  const rawStock: typeof factoryRawStock.$inferSelect = {
    ...lockedRawStock,
    receivedKg: dNewCumulativeKg.toDecimalPlaces(3).toFixed(3),
  };

  // 2. Mix-batch sources use the supplier's already-locked moving-average for
  //    supplier-backed material. Container-direct material keeps its own fixed
  //    landed cost. Neither path mutates supplier cost during a continuation.
  for (const alloc of mixBatchAllocationsArr) {
    const allocKg = parseFloat(alloc.weightKg || "0");
    if (!alloc.mixBatchId || allocKg <= 0) continue;
    const dAllocKg = new Decimal(allocKg);
    const dAllocRate = lockedContainer.supplierId ? new Decimal(supplierLockedRate) : new Decimal(fixedCostPerKgUsd);
    // sourceType: SUPPLIER_FIFO when both supplierId + containerId present,
    //             CONTAINER_DIRECT when no supplier.
    const subseqSrcType = lockedContainer.supplierId ? "SUPPLIER_FIFO" : "CONTAINER_DIRECT";
    await tx.insert(factoryMixBatchSources).values({
      mixBatchId: parseInt(alloc.mixBatchId),
      containerId,
      supplierId: lockedContainer.supplierId || null,
      sourceType: subseqSrcType,
      weightKg: String(allocKg),
      costPerKg: dAllocRate.toDecimalPlaces(6).toFixed(6),
      totalCost: dAllocKg.times(dAllocRate).toDecimalPlaces(6).toFixed(6),
      // V7: container.supplierId is the inventory owner for both SUPPLIER_FIFO
      // and CONTAINER_DIRECT source types. Null for containers without a supplier.
      inventorySupplierId: lockedContainer.supplierId || null,
    });
  }

  // 3. Update container cumulative actualReceivedKg and status
  const subsequentStatus = newCumulativeKg >= lockedValuationKgNum - 0.001 ? "OFFLOADED" : "PARTIALLY_RECEIVED";
  await tx
    .update(factoryContainers)
    .set({
      actualReceivedKg: dNewCumulativeKg.toDecimalPlaces(3).toFixed(3),
      differenceKg: String(Math.max(0, lockedValuationKgNum - newCumulativeKg)),
      status: subsequentStatus,
      destination: reqDestination ? String(reqDestination).trim() : lockedContainer.destination || null,
      updatedAt: new Date(),
    })
    .where(eq(factoryContainers.id, containerId));

  // 4. Record this receipt event — includes idempotencyKey for retry safety
  await tx.insert(factoryContainerReceipts).values({
    companyId,
    containerId,
    receiptDate: offloadDate,
    receivedKg: dReceivedKg.toDecimalPlaces(3).toFixed(3),
    cumulativeReceivedKg: dNewCumulativeKg.toDecimalPlaces(3).toFixed(3),
    fixedCostPerKg: String(fixedCostPerKg),
    fixedCostPerKgUsd: String(fixedCostPerKgUsd),
    receiptValue: dReceivedKg.times(new Decimal(fixedCostPerKg)).toDecimalPlaces(6).toFixed(6),
    receiptValueUsd: dReceivedKg.times(new Decimal(fixedCostPerKgUsd)).toDecimalPlaces(6).toFixed(6),
    currencyCode,
    fxRateToUsd: String(fxRate),
    createdBy: userId,
    idempotencyKey: idempotencyKey || null,
  });

  // 5. Daybook entry for this incremental receipt
  await writeDaybookEntry(tx, {
    companyId,
    txDate: offloadDate,
    txType: "OFFLOAD_RAW_STOCK",
    referenceId: lockedRawStock.id,
    referenceTable: "factory_raw_stock",
    description: `Continuation receipt — container ${container.containerNumber}: ${dReceivedKg.toDecimalPlaces(3).toFixed(3)} kg at ${new Decimal(fixedCostPerKg).toDecimalPlaces(6).toFixed(6)}/kg (fixed landed rate)`,
    currencyCode,
    amountCurrency: dReceivedKg.times(new Decimal(fixedCostPerKg)).toDecimalPlaces(6).toNumber(),
    fxRateToUsd: fxRate,
    metaJson: JSON.stringify({ containerId, sourceType: "BASE_MATERIAL", receiptKg: thisReceiptKg }),
  });

  return rawStock;
}

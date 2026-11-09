/**
 * Phase 2: read-only review of a proposed mix-batch source edit.
 *
 * A review never mutates stock or creates vouchers. The authoritative PATCH
 * recalculates this review under a transaction and rejects any stale hash
 * before it changes consumption. Completed / already-used batches are review
 * only until the downstream bale/GL reconciliation phases are implemented.
 */
import { and, eq, isNull } from "drizzle-orm";
import { factoryMixBatches, factoryBales, factoryPressingBatches, factoryDailyUsages } from "@shared/schema";
import type { DatabaseOrTransaction } from "../../db";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { getStableSupplierCost } from "./rawStockStableCost";
import { supplierLockedUsdRate } from "./baleCostBasis";
import {
  mixEditReviewHash,
  sameMixEditSources,
  type MixEditSelection,
} from "./mixBatchEditRequest";

export interface MixBatchForSourceReview {
  id: number;
  companyId: number;
  batchCode: string;
  status: string;
  deletedAt: Date | null;
  updatedAt: Date | null;
  totalWeightKg: string;
  totalCost: string;
  usedKg: string;
  costPerKg: string;
  batchDate?: string | null;
}

export interface MixSourceForReview {
  id: number;
  mixBatchId: number;
  supplierId: number | null;
  containerId: number | null;
  sourceBatchId: number | null;
  weightKg: string;
  costPerKg: string;
  totalCost: string;
}

export interface MixSourceEditReview {
  changed: boolean;
  allowed: boolean;
  reviewHash: string | null;
  recordedWeightKg: string;
  proposedWeightKg: string;
  recordedTotalCost: string;
  estimatedTotalCost: string | null;
  estimatedCostPerKg: string | null;
  estimatedDeltaUsd: string | null;
  warnings: string[];
}

export async function prepareMixSourceEditReview(
  executor: DatabaseOrTransaction,
  companyId: number,
  batch: MixBatchForSourceReview,
  oldSources: readonly MixSourceForReview[],
  proposed: MixEditSelection,
  reason: string,
  opts: { forUpdate?: boolean; proposedBatchDate?: string | null } = {},
): Promise<MixSourceEditReview> {
  const changed = !sameMixEditSources(oldSources, proposed);
  const warnings: string[] = [];
  const snapshot: unknown[] = [];
  const recordedCost = toMoney(batch.totalCost);
  const oldByContainer = new Map<number, ReturnType<typeof toMoney>>();
  const oldBySupplier = new Map<number, MixSourceForReview[]>();
  const oldByBatch = new Map<number, ReturnType<typeof toMoney>>();

  for (const source of oldSources) {
    if (source.containerId !== null && source.supplierId === null) {
      warnings.push("An original container source has no supplier attribution. It requires an audited historical correction.");
    }
    if (source.containerId !== null && source.sourceBatchId !== null) {
      warnings.push("An original row has conflicting container and source-batch references.");
    }
    if (source.containerId !== null) {
      oldByContainer.set(
        source.containerId,
        (oldByContainer.get(source.containerId) ?? new MoneyDecimal(0)).plus(source.weightKg),
      );
    }
    if (source.supplierId !== null && source.sourceBatchId === null) {
      const list = oldBySupplier.get(source.supplierId) ?? [];
      list.push(source);
      oldBySupplier.set(source.supplierId, list);
    }
    if (source.sourceBatchId !== null) {
      oldByBatch.set(
        source.sourceBatchId,
        (oldByBatch.get(source.sourceBatchId) ?? new MoneyDecimal(0)).plus(source.weightKg),
      );
    }
  }

  if (batch.deletedAt) warnings.push("Deleted batches cannot have their sources edited.");
  if (!["OPEN", "ACTIVE", "CARRY_FORWARD"].includes(batch.status)) {
    warnings.push("This batch has been completed or closed. Review-only: historical output and accounting must be reconciled first.");
  }
  if (toMoney(batch.usedKg).greaterThan(0)) {
    warnings.push("The batch has recorded production/usage; source edits require downstream bale and accounting reconciliation.");
  }
  if (toMoney(proposed.totalWeightKg).lessThan(toMoney(batch.usedKg))) {
    warnings.push("Proposed materials do not cover already-used kilograms.");
  }
  if (!changed) {
    return {
      changed: false,
      allowed: true,
      reviewHash: null,
      recordedWeightKg: toMoney(batch.totalWeightKg).toFixed(3),
      proposedWeightKg: proposed.totalWeightKg,
      recordedTotalCost: recordedCost.toFixed(7),
      estimatedTotalCost: recordedCost.toFixed(7),
      estimatedCostPerKg: toMoney(batch.costPerKg).toFixed(7),
      estimatedDeltaUsd: "0.0000000",
      warnings: [],
    };
  }
  if (reason.trim().length < 10 || reason.trim().length > 500) {
    warnings.push("An audit reason between 10 and 500 characters is required for a source edit.");
  }
  // Do not rely on usedKg alone: legacy imports and partial pressing can have
  // downstream records even when a batch's usage counter has not caught up.
  const [linkedBales, linkedPressing, linkedUsage] = await Promise.all([
    executor.select({ id: factoryBales.id }).from(factoryBales).where(and(
      eq(factoryBales.companyId, companyId),
      eq(factoryBales.mixBatchId, batch.id),
      isNull(factoryBales.deletedAt),
    )).limit(1),
    executor.select({ id: factoryPressingBatches.id }).from(factoryPressingBatches).where(and(
      eq(factoryPressingBatches.companyId, companyId),
      eq(factoryPressingBatches.mixBatchId, batch.id),
    )).limit(1),
    executor.select({ id: factoryDailyUsages.id }).from(factoryDailyUsages).where(and(
      eq(factoryDailyUsages.companyId, companyId),
      eq(factoryDailyUsages.mixBatchId, batch.id),
    )).limit(1),
  ]);
  if (linkedBales.length || linkedPressing.length || linkedUsage.length) {
    warnings.push("This mix is referenced by bale, pressing or consumption records and requires downstream reconciliation.");
  }
  const supplierIds = [...new Set([
    ...oldBySupplier.keys(),
    ...proposed.supplierSources.map((item) => item.supplierId!),
  ])].sort((a, b) => a - b);
  const proposedSuppliers = new Map(proposed.supplierSources.map((s) => [s.supplierId!, toMoney(s.weightKg)]));
  const proposedBatches = new Map(proposed.batchSources.map((s) => [s.sourceBatchId!, toMoney(s.weightKg)]));
  let estimatedCost = new MoneyDecimal(0);
  let costAvailable = true;

  // Every old source must be reversible from the exact inventory row that
  // originally carried it. Legacy supplier-only rows are not safe to reverse
  // by guessing which container to credit.
  for (const supplierId of supplierIds) {
    const rate = await supplierLockedUsdRate(executor, companyId, supplierId);
    const raw = await getStableSupplierCost(executor, companyId, supplierId, opts);
    const rowByContainer = new Map(raw.rows.map((row) => [row.containerId, row]));
    let releasedKg = new MoneyDecimal(0);
    for (const old of oldBySupplier.get(supplierId) ?? []) {
      if (old.containerId === null) {
        if (raw.rows.length) {
          warnings.push(`Supplier #${supplierId} has legacy unallocated sources; historical allocation must be reviewed.`);
        }
        continue;
      }
      const row = rowByContainer.get(old.containerId);
      if (!row) {
        warnings.push(`Supplier #${supplierId} has a source/container ownership mismatch; correct that link first.`);
        continue;
      }
      if (toMoney(row.usedKg).lessThan(toMoney(oldByContainer.get(old.containerId) ?? 0))) {
        warnings.push(`Supplier #${supplierId} has insufficient recorded consumption to reverse safely.`);
      }
      releasedKg = releasedKg.plus(old.weightKg);
    }
    const free = raw.rows.reduce(
      (sum, row) => sum.plus(toMoney(row.receivedKg).minus(toMoney(row.usedKg))),
      new MoneyDecimal(0),
    );
    const nextKg = proposedSuppliers.get(supplierId) ?? new MoneyDecimal(0);
    if (raw.rows.length && nextKg.gt(free.plus(releasedKg).plus(0.001))) {
      warnings.push(`Supplier #${supplierId} does not have enough available kilograms for the proposed allocation.`);
    }
    if (nextKg.gt(0)) {
      if (rate === null) {
        warnings.push(`Supplier #${supplierId} has no current locked USD rate; confirm its rate before editing.`);
        costAvailable = false;
      } else {
        estimatedCost = estimatedCost.plus(nextKg.times(rate));
      }
    }
    snapshot.push({
      kind: "supplier", id: supplierId, rate: rate?.toFixed(8) ?? null,
      stock: raw.rows.map((row) => ({
        id: row.id, containerId: row.containerId,
        received: toMoney(row.receivedKg).toFixed(3),
        used: toMoney(row.usedKg).toFixed(3),
      })),
    });
  }

  const upstreamIds = [...new Set([...oldByBatch.keys(), ...proposedBatches.keys()])].sort((a, b) => a - b);
  for (const upstreamId of upstreamIds) {
    if (upstreamId === batch.id) {
      warnings.push("A batch cannot use itself as a source.");
      continue;
    }
    const q = executor.select().from(factoryMixBatches).where(
      and(eq(factoryMixBatches.id, upstreamId), eq(factoryMixBatches.companyId, companyId), isNull(factoryMixBatches.deletedAt)),
    );
    const [upstream] = await (opts.forUpdate ? q.for("update") : q);
    if (!upstream) {
      warnings.push(`Source batch #${upstreamId} is unavailable or belongs to a different company.`);
      continue;
    }
    const oldKg = oldByBatch.get(upstreamId) ?? new MoneyDecimal(0);
    const requestedKg = proposedBatches.get(upstreamId) ?? new MoneyDecimal(0);
    if (toMoney(upstream.usedKg).lt(oldKg)) {
      warnings.push(`Source batch ${upstream.batchCode} has less used material than this mix references.`);
    }
    if (requestedKg.gt(toMoney(upstream.totalWeightKg).minus(toMoney(upstream.usedKg)).plus(oldKg).plus(0.001))) {
      warnings.push(`Source batch ${upstream.batchCode} has insufficient remaining kilograms.`);
    }
    if (requestedKg.gt(0)) {
      if (toMoney(upstream.costPerKg).lessThanOrEqualTo(0)) {
        warnings.push(`Source batch ${upstream.batchCode} has no recorded USD cost.`);
        costAvailable = false;
      } else {
        estimatedCost = estimatedCost.plus(requestedKg.times(upstream.costPerKg));
      }
    }
    snapshot.push({
      kind: "batch", id: upstreamId, updatedAt: upstream.updatedAt?.toISOString() ?? null,
      weight: upstream.totalWeightKg, used: upstream.usedKg, rate: upstream.costPerKg,
    });
  }

  const allowed = warnings.length === 0;
  const normalizedOld = [...oldSources].sort((a, b) => a.id - b.id).map((row) => ({
    id: row.id, supplierId: row.supplierId, sourceBatchId: row.sourceBatchId,
    containerId: row.containerId, kg: row.weightKg, rate: row.costPerKg, cost: row.totalCost,
  }));
  const reviewHash = mixEditReviewHash({
    companyId, batchId: batch.id,
    state: {
      status: batch.status, updatedAt: batch.updatedAt?.toISOString() ?? null,
      kg: batch.totalWeightKg, used: batch.usedKg, cost: batch.totalCost,
    },
    old: normalizedOld, proposed,
    live: snapshot, reason: reason.trim(),
    proposedBatchDate: opts.proposedBatchDate ?? batch.batchDate ?? null,
  });
  return {
    changed,
    allowed,
    reviewHash,
    recordedWeightKg: toMoney(batch.totalWeightKg).toFixed(3),
    proposedWeightKg: proposed.totalWeightKg,
    recordedTotalCost: recordedCost.toFixed(7),
    estimatedTotalCost: costAvailable ? estimatedCost.toFixed(7) : null,
    estimatedCostPerKg: costAvailable ? estimatedCost.div(proposed.totalWeightKg).toFixed(7) : null,
    estimatedDeltaUsd: costAvailable ? estimatedCost.minus(recordedCost).toFixed(7) : null,
    warnings,
  };
}

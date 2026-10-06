import { eq, and, isNull, sql, inArray, gt } from "drizzle-orm";
import { pool } from "../../../db";
import { db } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import {
  factoryContainers,
  factoryRawStock,
  factoryOffloadAdditionalCharges,
  factoryContainerCommissions,
  factoryContainerOtherCharges,
  factorySuppliers,
} from "@shared/schema";
import { computeCorrectContainerCost, costEquals } from "./cost-math";

export interface RecalcRow {
  containerId: number;
  /** null when the active raw-stock row is missing/deleted */
  rawStockId: number | null;
  containerNumber: string;
  containerStatus: string;
  supplierId: number | null;
  supplierName: string;
  currencyCode: string;
  receivedKg: number;
  usedKg: number;
  remainingKg: number;
  fullyUsed: boolean;
  activeRawStockRowExists: boolean;
  /** A soft-deleted raw-stock row exists for this container */
  rawStockDeleted: boolean;
  mixSourceCount: number;
  affectedOpenBatchCount: number;
  affectedCompletedBatchCount: number;
  old: { costPerKg: number; costPerKgUsd: number };
  next: { costPerKg: number; costPerKgUsd: number };
  diffPct: number;
  changed: boolean;
  fxUnresolved: boolean;
  /** Declared/agreed KG for this container (totalKg || declaredKg || actualReceivedKg). */
  valuationKg: number;
  /** KG actually received (from raw-stock row or container.actualReceivedKg). */
  actualReceivedKg: number;
  /** True when the container had only a partial receipt (actualReceivedKg < valuationKg). */
  wasPartialReceipt: boolean;
}

export const OPEN_BATCH_STATUSES = ["ACTIVE", "OPEN", "CARRY_FORWARD"];
export const COMPLETED_BATCH_STATUSES = ["COMPLETED", "CLOSED"];

/** Read-only: build the full diff list.
 *  Covers containers with an active raw-stock row AND historical/fully-consumed
 *  containers that have linked mix-batch sources but no active raw-stock row. */
export async function getRawStockRecalcPreview(companyId: number): Promise<RecalcRow[]> {
  // A. Containers with an active raw-stock row
  const rowsWithStock = await db
    .select({
      rawStockId: factoryRawStock.id,
      containerId: factoryRawStock.containerId,
      receivedKg: factoryRawStock.receivedKg,
      usedKg: factoryRawStock.usedKg,
      costPerKg: factoryRawStock.costPerKg,
      costPerKgUsd: factoryRawStock.costPerKgUsd,
      container: factoryContainers,
      supplierName: factorySuppliers.name,
    })
    .from(factoryRawStock)
    .innerJoin(factoryContainers, eq(factoryContainers.id, factoryRawStock.containerId))
    .leftJoin(factorySuppliers, eq(factorySuppliers.id, factoryContainers.supplierId))
    .where(and(eq(factoryRawStock.companyId, companyId), isNull(factoryRawStock.deletedAt)));

  // B. Containers without active raw-stock but with linked mix-batch sources
  const stockedIds = rowsWithStock.length > 0 ? rowsWithStock.map((r) => r.containerId) : [-1];

  const historicalRows = await db
    .select({
      container: factoryContainers,
      supplierName: factorySuppliers.name,
    })
    .from(factoryContainers)
    .leftJoin(factorySuppliers, eq(factorySuppliers.id, factoryContainers.supplierId))
    .where(
      and(
        eq(factoryContainers.companyId, companyId),
        sql`${factoryContainers.id} NOT IN (${sql.join(
          stockedIds.map((id) => sql`${id}`),
          sql`, `
        )})`,
        sql`EXISTS (SELECT 1 FROM factory_mix_batch_sources fmbs WHERE fmbs.container_id = ${factoryContainers.id})`,
        gt(factoryContainers.actualReceivedKg, "0")
      )
    );

  if (rowsWithStock.length === 0 && historicalRows.length === 0) return [];

  const allContainerIds = [...rowsWithStock.map((r) => r.containerId), ...historicalRows.map((r) => r.container.id)];

  // Load supporting data in parallel
  const [allAdditionalCharges, allCommissions, allOtherCharges, sourceCountResult, deletedRsRows] = await Promise.all([
    db.select().from(factoryOffloadAdditionalCharges).where(eq(factoryOffloadAdditionalCharges.companyId, companyId)),
    db.select().from(factoryContainerCommissions).where(eq(factoryContainerCommissions.companyId, companyId)),
    db.select().from(factoryContainerOtherCharges).where(eq(factoryContainerOtherCharges.companyId, companyId)),
    pool.query<{
      container_id: string;
      source_count: string;
      open_batch_count: string;
      completed_batch_count: string;
    }>(
      `SELECT
          fmbs.container_id,
          COUNT(*)::int AS source_count,
          COUNT(DISTINCT CASE WHEN fmb.status IN ('ACTIVE','OPEN','CARRY_FORWARD') THEN fmb.id END)::int AS open_batch_count,
          COUNT(DISTINCT CASE WHEN fmb.status IN ('COMPLETED','CLOSED') THEN fmb.id END)::int AS completed_batch_count
        FROM factory_mix_batch_sources fmbs
        JOIN factory_mix_batches fmb ON fmb.id = fmbs.mix_batch_id
        WHERE fmbs.container_id = ANY($1)
          AND fmb.deleted_at IS NULL
        GROUP BY fmbs.container_id`,
      [allContainerIds]
    ),
    // Soft-deleted raw-stock per container
    db
      .select({ containerId: factoryRawStock.containerId })
      .from(factoryRawStock)
      .where(
        and(
          eq(factoryRawStock.companyId, companyId),
          inArray(factoryRawStock.containerId, allContainerIds),
          sql`${factoryRawStock.deletedAt} IS NOT NULL`
        )
      ),
  ]);

  // Build lookup maps
  const chargesByContainer = new Map<number, (typeof factoryOffloadAdditionalCharges.$inferSelect)[]>();
  for (const c of allAdditionalCharges) {
    if (!chargesByContainer.has(c.containerId)) chargesByContainer.set(c.containerId, []);
    chargesByContainer.get(c.containerId)!.push(c);
  }
  const commissionByContainer = new Map<number, typeof factoryContainerCommissions.$inferSelect>();
  for (const c of allCommissions) {
    const existing = commissionByContainer.get(c.containerId);
    if (!existing || c.id > existing.id) commissionByContainer.set(c.containerId, c);
  }
  const otherChargesByContainer = new Map<number, (typeof factoryContainerOtherCharges.$inferSelect)[]>();
  for (const oc of allOtherCharges) {
    if (!otherChargesByContainer.has(oc.containerId)) otherChargesByContainer.set(oc.containerId, []);
    otherChargesByContainer.get(oc.containerId)!.push(oc);
  }
  const sourceCountByContainer = new Map<
    number,
    { source_count: number; open_batch_count: number; completed_batch_count: number }
  >();
  for (const r of sourceCountResult.rows) {
    sourceCountByContainer.set(Number(r.container_id), {
      source_count: Number(r.source_count),
      open_batch_count: Number(r.open_batch_count),
      completed_batch_count: Number(r.completed_batch_count),
    });
  }
  const deletedRsContainerIds = new Set(deletedRsRows.map((r) => r.containerId as number));

  const results: RecalcRow[] = [];

  // Process containers with active raw-stock
  for (const row of rowsWithStock) {
    const container = row.container;
    const additionalCharges = chargesByContainer.get(container.id) || [];
    const commissionRecord = commissionByContainer.get(container.id) || null;
    const ocRows = otherChargesByContainer.get(container.id) || [];
    const next = computeCorrectContainerCost(container, additionalCharges, commissionRecord, ocRows);

    const oldCostPerKg = toMoney(row.costPerKg).toNumber();
    const oldCostPerKgUsd = toMoney(row.costPerKgUsd).toNumber();
    const changed =
      !next.fxUnresolved &&
      (!costEquals(next.costPerKg, oldCostPerKg) || !costEquals(next.costPerKgUsd, oldCostPerKgUsd));
    const diffPct = oldCostPerKgUsd > 0 ? ((next.costPerKgUsd - oldCostPerKgUsd) / oldCostPerKgUsd) * 100 : 0;

    const receivedKg = toMoney(row.receivedKg).toNumber();
    const usedKg = toMoney(row.usedKg).toNumber();
    const remainingKg = MoneyDecimal.max(0, toMoney(row.receivedKg).minus(toMoney(row.usedKg))).toNumber();
    const sc = sourceCountByContainer.get(container.id);

    const rawStockValuationKg = toMoney(
      container.totalKg || container.declaredKg || container.actualReceivedKg || "0"
    ).toNumber();
    results.push({
      containerId: container.id,
      rawStockId: row.rawStockId,
      containerStatus: container.status,
      containerNumber: container.containerNumber,
      supplierId: container.supplierId,
      supplierName: row.supplierName || "Unknown Supplier",
      currencyCode: container.currencyCode || "USD",
      receivedKg,
      usedKg,
      remainingKg,
      fullyUsed: receivedKg > 0 && remainingKg === 0,
      activeRawStockRowExists: true,
      rawStockDeleted: deletedRsContainerIds.has(container.id),
      mixSourceCount: sc?.source_count || 0,
      affectedOpenBatchCount: sc?.open_batch_count || 0,
      affectedCompletedBatchCount: sc?.completed_batch_count || 0,
      old: { costPerKg: oldCostPerKg, costPerKgUsd: oldCostPerKgUsd },
      next: { costPerKg: next.costPerKg, costPerKgUsd: next.costPerKgUsd },
      diffPct: next.fxUnresolved ? 0 : diffPct,
      changed,
      fxUnresolved: next.fxUnresolved,
      valuationKg: rawStockValuationKg,
      actualReceivedKg: receivedKg,
      wasPartialReceipt: receivedKg > 0 && receivedKg < rawStockValuationKg - 0.001,
    });
  }

  // Process historical containers without active raw-stock
  for (const { container, supplierName } of historicalRows) {
    const additionalCharges = chargesByContainer.get(container.id) || [];
    const commissionRecord = commissionByContainer.get(container.id) || null;
    const ocRows = otherChargesByContainer.get(container.id) || [];
    const next = computeCorrectContainerCost(container, additionalCharges, commissionRecord, ocRows);

    // For historical containers compare against ratePerKgUsd snapshot
    const oldCostPerKgUsd = toMoney(container.ratePerKgUsd).toNumber();
    const oldCostPerKg = toMoney(container.ratePerKg).toNumber();
    const changed =
      !next.fxUnresolved &&
      (!costEquals(next.costPerKg, oldCostPerKg) || !costEquals(next.costPerKgUsd, oldCostPerKgUsd));
    const diffPct = oldCostPerKgUsd > 0 ? ((next.costPerKgUsd - oldCostPerKgUsd) / oldCostPerKgUsd) * 100 : 0;

    const receivedKg = toMoney(container.actualReceivedKg).toNumber();
    const sc = sourceCountByContainer.get(container.id);

    const histValuationKg = toMoney(
      container.totalKg || container.declaredKg || container.actualReceivedKg || "0"
    ).toNumber();
    results.push({
      containerId: container.id,
      rawStockId: null,
      containerStatus: container.status,
      containerNumber: container.containerNumber,
      supplierId: container.supplierId,
      supplierName: supplierName || "Unknown Supplier",
      currencyCode: container.currencyCode || "USD",
      receivedKg,
      usedKg: receivedKg,
      remainingKg: 0,
      fullyUsed: true,
      activeRawStockRowExists: false,
      rawStockDeleted: deletedRsContainerIds.has(container.id),
      mixSourceCount: sc?.source_count || 0,
      affectedOpenBatchCount: sc?.open_batch_count || 0,
      affectedCompletedBatchCount: sc?.completed_batch_count || 0,
      old: { costPerKg: oldCostPerKg, costPerKgUsd: oldCostPerKgUsd },
      next: { costPerKg: next.costPerKg, costPerKgUsd: next.costPerKgUsd },
      diffPct: next.fxUnresolved ? 0 : diffPct,
      // Historical containers always need review if they have sources
      changed: changed || (sc?.source_count || 0) > 0,
      fxUnresolved: next.fxUnresolved,
      valuationKg: histValuationKg,
      actualReceivedKg: receivedKg,
      wasPartialReceipt: receivedKg > 0 && receivedKg < histValuationKg - 0.001,
    });
  }

  results.sort((a, b) => {
    if (a.fxUnresolved !== b.fxUnresolved) return a.fxUnresolved ? -1 : 1;
    if (a.changed !== b.changed) return a.changed ? -1 : 1;
    return Math.abs(b.diffPct) - Math.abs(a.diffPct);
  });

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// calculateBatchCostPreview — shared Decimal.js weighted-average helper
// ─────────────────────────────────────────────────────────────────────────────

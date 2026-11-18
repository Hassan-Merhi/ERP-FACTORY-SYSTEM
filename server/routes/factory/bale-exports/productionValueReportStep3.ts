// Extracted from ./production-value-report.ts: a stage of production-value-report.
import { pool } from "../../../db";
import {
  BatchRateDecimal,
  calculateProductionProfit,
  calculateProductionWeightCost,
  calculatePeriodTableBalance,
} from "./production-value-math";
import { toMoney } from "../../../lib/money";
import { getFactoryBalanceOnTableSnapshot } from "../../../services/factory/productionBalanceOnTable";
import type { productionValueReportStep } from "./productionValueReportStep";
import type { productionValueReportStep2 } from "./productionValueReportStep2";

type ProductionValueReportStepResult = Awaited<ReturnType<typeof productionValueReportStep>>;
type ProductionValueReportStep2Result = Awaited<ReturnType<typeof productionValueReportStep2>>;

export async function productionValueReportStep3({
  pvr1,
  pvr2,
}: {
  pvr1: Extract<ProductionValueReportStepResult, { done: false }>;
  pvr2: ProductionValueReportStep2Result;
}) {
  const {
    balanceWeightKg,
    totalMixWeightDecimal,
    totalMixCostDecimal,
    totalBaleWeightKg,
    totalWgWeightKg,
    balanceBatchRateDecimal,
    totalProductionValue,
    totalMixWeightKg,
    mixSourceRows,
    reportSupplierIds,
    reportSourcesByBatch,
    reportSupplierRateMap,
    productRows,
    categoryRows,
    wgRows,
    wgProductRows,
    correctedBatchRows,
  } = pvr2;
  const { from, companyId, mixBatchRows, hideReportCosts } = pvr1;

  // Preserve the overall as-of Balance on Table snapshot without changing
  // Production Weight Cost. Closed mix batches are normally fully used at
  // creation, so their current "ACTIVE" status is NOT a historical month
  // balance. For the filtered KPI, compare the physical balances at the
  // selected period's boundaries. This is period net movement (up/down),
  // valued at the period's correct original-batch weighted-average rate.
  const priorDate = from
    ? (() => {
        const firstDay = new Date(`${from}T00:00:00Z`);
        if (!Number.isFinite(firstDay.getTime()) || firstDay.toISOString().slice(0, 10) !== from) {
          throw new RangeError();
        }
        firstDay.setUTCDate(firstDay.getUTCDate() - 1);
        return firstDay.toISOString().slice(0, 10);
      })()
    : null;
  const beforePeriodSnapshot = priorDate ? await getFactoryBalanceOnTableSnapshot(companyId, priorDate) : null;
  const filteredTable = calculatePeriodTableBalance({
    weightAtEndKg: balanceWeightKg,
    weightBeforePeriodKg: beforePeriodSnapshot?.weightKg ?? 0,
    mixedPeriodWeightKg: totalMixWeightDecimal,
    mixedPeriodCost: totalMixCostDecimal,
  });

  // Weight Cost includes all material converted during the selected period:
  // regular bales plus wipers and garbage. Those groups are mutually exclusive
  // in baleRows, so each kilogram is charged once at the historical cumulative
  // batch rate. This stays separate from the period-only Balance on Table rate.
  const weightCostDecimal = calculateProductionWeightCost({
    producedWeightKg: new BatchRateDecimal(totalBaleWeightKg).plus(totalWgWeightKg),
    batchRateCost: balanceBatchRateDecimal,
  });
  // Profit follows the active valuation mode:
  // Cost Price: cost production value - Weight Cost
  // Selling Price: selling production value - Weight Cost
  const { weightCost, profitValue, profitMarginPct } = calculateProductionProfit({
    productionValue: totalProductionValue,
    weightCost: weightCostDecimal,
  });
  const statusValue = profitValue;

  // ── Kg comparison ──
  const kgDiff = totalBaleWeightKg - totalMixWeightKg;

  // ── Supplier mix breakdown (per day, per supplier) ──
  // Use inventorySupplierId — the canonical ownership field set on ALL source types,
  // including batch-to-batch sources. This traces back to the ultimate raw-material supplier
  // even when the immediate source is another mix batch.
  const inventorySupplierIds = [
    ...new Set(mixSourceRows.filter((s) => s.inventorySupplierId != null).map((s) => s.inventorySupplierId as number)),
  ];

  // Also collect direct supplierId / container supplierId as fallback
  const allSupplierIdsForNames = [...new Set([...inventorySupplierIds, ...reportSupplierIds])];

  // Fallback: container → supplier name for sources without inventorySupplierId.
  // Resolve container ownership in one query, then load every required supplier
  // name in one batch. This removes the old one-query-per-container-supplier loop.
  const containerIds = [
    ...new Set(
      mixSourceRows
        .filter((s) => s.inventorySupplierId == null && s.containerId != null)
        .map((s) => s.containerId as number)
    ),
  ];
  const containerSupplierIdMap = new Map<number, number | null>();
  if (containerIds.length > 0) {
    const cRows = await pool.query(`SELECT id, supplier_id FROM factory_containers WHERE id = ANY($1)`, [containerIds]);
    for (const r of cRows.rows) {
      containerSupplierIdMap.set(r.id as number, r.supplier_id as number | null);
    }
  }

  const supplierIdsForNames = [
    ...new Set([
      ...allSupplierIdsForNames,
      ...[...containerSupplierIdMap.values()].filter((id): id is number => id != null),
    ]),
  ];
  const supplierNameById = new Map<number, string>();
  if (supplierIdsForNames.length > 0) {
    const sRows = await pool.query(`SELECT id, name FROM factory_suppliers WHERE id = ANY($1)`, [supplierIdsForNames]);
    for (const r of sRows.rows) {
      supplierNameById.set(r.id as number, r.name as string);
    }
  }

  // Resolve supplier name for one source row
  function resolveSupplierName(src: {
    inventorySupplierId?: number | null;
    supplierId?: number | null;
    containerId?: number | null;
  }): string {
    // 1. inventorySupplierId — most authoritative
    if (src.inventorySupplierId != null) {
      return supplierNameById.get(src.inventorySupplierId) ?? `Supplier #${src.inventorySupplierId}`;
    }
    // 2. Direct supplierId on the source row
    if (src.supplierId != null) {
      return supplierNameById.get(src.supplierId) ?? `Supplier #${src.supplierId}`;
    }
    // 3. Container → supplier
    if (src.containerId != null) {
      const csid = containerSupplierIdMap.get(src.containerId);
      if (csid) return supplierNameById.get(csid) ?? `Supplier #${csid}`;
    }
    return "Unknown";
  }

  // Group ALL sources (including batch-to-batch) by (date, supplierName)
  type SupDay = { date: string; supplierName: string; totalKg: number; totalCost: number };
  const supDayMap = new Map<string, SupDay>();

  for (const batch of mixBatchRows) {
    const batchDate: string = batch.batchDate
      ? String(batch.batchDate).slice(0, 10)
      : String(batch.createdAt).slice(0, 10);
    const sources = reportSourcesByBatch.get(batch.id) || [];

    for (const src of sources) {
      const supplierName = resolveSupplierName(src);
      if (
        supplierName === "Unknown" &&
        src.inventorySupplierId == null &&
        src.supplierId == null &&
        src.containerId == null
      ) {
        continue; // truly unresolvable — skip
      }

      const w = toMoney(src.weightKg).toNumber();
      // Use effective cost: locked rate for direct-supplier sources, stored costPerKg otherwise
      let cpk: number;
      if (src.supplierId != null) {
        cpk = reportSupplierRateMap.get(src.supplierId) ?? toMoney(src.costPerKg).toNumber();
      } else {
        cpk = toMoney(src.costPerKg).toNumber();
      }

      const key = `${batchDate}::${supplierName}`;
      const ex = supDayMap.get(key);
      if (ex) {
        ex.totalKg += w;
        ex.totalCost += w * cpk;
      } else {
        supDayMap.set(key, { date: batchDate, supplierName, totalKg: w, totalCost: w * cpk });
      }
    }
  }

  const supplierMixBreakdown = [...supDayMap.values()].sort((a, b) =>
    a.date !== b.date ? a.date.localeCompare(b.date) : a.supplierName.localeCompare(b.supplierName)
  );

  const safeProductRows = hideReportCosts
    ? productRows.map((row) => ({
        ...row,
        costPricePerBale: 0,
        pricePerBale: 0,
        totalValue: 0,
      }))
    : productRows;
  const safeCategoryRows = hideReportCosts
    ? categoryRows.map((row) => ({
        ...row,
        totalValue: 0,
      }))
    : categoryRows;
  const safeWgRows = hideReportCosts
    ? wgRows.map((row) => ({
        ...row,
        totalValue: 0,
      }))
    : wgRows;
  const safeWgProductRows = hideReportCosts
    ? wgProductRows.map((row) => ({
        ...row,
        costPricePerBale: 0,
        pricePerBale: 0,
        totalValue: 0,
      }))
    : wgProductRows;
  const safeBatchRows = hideReportCosts
    ? correctedBatchRows.map((row) => ({
        ...row,
        costPerKg: "0",
        totalCost: "0",
      }))
    : correctedBatchRows;
  const safeSupplierMixBreakdown = hideReportCosts
    ? supplierMixBreakdown.map((row) => ({
        ...row,
        totalCost: 0,
      }))
    : supplierMixBreakdown;

  return {
    filteredTable,
    weightCost,
    profitValue,
    profitMarginPct,
    statusValue,
    kgDiff,
    safeProductRows,
    safeCategoryRows,
    safeWgRows,
    safeWgProductRows,
    safeBatchRows,
    safeSupplierMixBreakdown,
  };
}

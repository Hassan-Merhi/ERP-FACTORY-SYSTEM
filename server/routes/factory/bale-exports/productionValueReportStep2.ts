// Extracted from ./production-value-report.ts: a stage of production-value-report.
import { db } from "../../../db";
import { getLockedSupplierRatesReadOnlyBulk } from "../../../services/factory/rawStockLockedRateBulk";
import { BatchRateDecimal } from "./production-value-math";
import { factoryMixBatchSources } from "@shared/schema";
import { inArray } from "drizzle-orm";
import { toMoney } from "../../../lib/money";
import { getFactoryBalanceOnTableSnapshot } from "../../../services/factory/productionBalanceOnTable";
import type { productionValueReportStep } from "./productionValueReportStep";

type ProductionValueReportStepResult = Awaited<ReturnType<typeof productionValueReportStep>>;

export async function productionValueReportStep2({
  pvr1,
}: {
  pvr1: Extract<ProductionValueReportStepResult, { done: false }>;
}) {
  const {
    baleRows,
    valuationMode,
    isWiperOrGarbage,
    wgMap,
    wgProductMap,
    productMap,
    categoryMap,
    mixBatchRows,
    companyId,
    to,
  } = pvr1;
  let missingSelectedPriceBales = 0;
  let missingCostPriceBales = 0;
  let missingSellingPriceBales = 0;

  for (const bale of baleRows) {
    const code = bale.articleCode || "UNKNOWN";
    const name = bale.productName || code;
    const catName = bale.categoryName || "Uncategorized";
    const wt = toMoney(bale.weightKg).toNumber();
    const costPrice = toMoney(bale.productionPrice).toNumber();
    const sellingPrice = toMoney(bale.sellingPrice).toNumber();
    const price = valuationMode === "selling" ? sellingPrice : costPrice;
    const value = price; // catalog price is per bale (not per kg)
    // Prefer the live worker record; fall back to the name snapshotted on the bale.
    const workerName = (bale.workerFullName || bale.baleWorkerName || "").trim();
    const workerId = bale.finalizedBy ?? null;

    if (isWiperOrGarbage(catName)) {
      // Route to wipers/garbage bucket
      const lower = catName.toLowerCase();
      const subType: "wiper" | "garbage" | "other" = lower.includes("wiper")
        ? "wiper"
        : lower.includes("garbage")
          ? "garbage"
          : "other";
      const existing = wgMap.get(catName);
      if (existing) {
        existing.qty += 1;
        existing.totalWeightKg += wt;
        existing.totalValue += value;
      } else {
        wgMap.set(catName, { subType, qty: 1, totalWeightKg: wt, totalValue: value });
      }

      const wgCode = bale.catalogArticleCode || code;
      const wgName = bale.catalogProductName || name;
      const wgKey = bale.productId != null ? `product:${bale.productId}` : `code:${wgCode}`;
      const existingProduct = wgProductMap.get(wgKey);
      if (existingProduct) {
        existingProduct.qty += 1;
        existingProduct.totalWeightKg += wt;
        existingProduct.totalValue += value;
        existingProduct.pricePerBale = existingProduct.totalValue / existingProduct.qty;
      } else {
        wgProductMap.set(wgKey, {
          articleCode: wgCode,
          productName: wgName,
          categoryName: "Wipers & Garbage",
          qty: 1,
          totalWeightKg: wt,
          costPricePerBale: costPrice,
          pricePerBale: price,
          totalValue: value,
        });
      }
    } else {
      // Track both catalog values; the active valuation mode decides which one
      // becomes Production Value and therefore which one drives Profit.
      pvr1.totalSellingValue += sellingPrice;
      pvr1.totalProductionCostValue += costPrice;
      if (!(price > 0)) missingSelectedPriceBales += 1;
      if (!(costPrice > 0)) missingCostPriceBales += 1;
      if (!(sellingPrice > 0)) missingSellingPriceBales += 1;

      const existing = productMap.get(code);
      if (existing) {
        existing.qty += 1;
        existing.totalWeightKg += wt;
        existing.totalValue += value;
        if (bale.mixBatchId != null) existing.mixBatchIds.add(bale.mixBatchId);
      } else {
        productMap.set(code, {
          articleCode: code,
          productName: name,
          categoryName: catName,
          qty: 1,
          totalWeightKg: wt,
          costPricePerBale: costPrice,
          pricePerBale: price,
          totalValue: value,
          mixBatchIds: new Set(bale.mixBatchId != null ? [bale.mixBatchId] : []),
          workers: new Map(),
        });
      }

      if (workerName || workerId != null) {
        const wMap = productMap.get(code)!.workers;
        const wKey = workerId != null ? `id:${workerId}` : `name:${workerName.toLowerCase()}`;
        const wEx = wMap.get(wKey);
        if (wEx) wEx.qty += 1;
        else wMap.set(wKey, { id: workerId, name: workerName || `Worker #${workerId}`, qty: 1 });
      }

      const catExisting = categoryMap.get(catName);
      if (catExisting) {
        catExisting.qty += 1;
        catExisting.totalWeightKg += wt;
        catExisting.totalValue += value;
      } else {
        categoryMap.set(catName, { categoryName: catName, qty: 1, totalWeightKg: wt, totalValue: value });
      }
    }
  }

  const productRows = [...productMap.values()]
    .sort((a, b) => a.articleCode.localeCompare(b.articleCode))
    .map(({ workers, mixBatchIds, ...rest }) => ({
      ...rest,
      mixBatchIds: [...mixBatchIds].sort((a, b) => a - b),
      workers: [...workers.values()].sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name)),
    }));
  const categoryRows = [...categoryMap.values()].sort((a, b) => a.categoryName.localeCompare(b.categoryName));

  const totalBales = productRows.reduce((s, r) => s + r.qty, 0);
  const totalBaleWeightKg = productRows.reduce((s, r) => s + r.totalWeightKg, 0);
  const totalProductionValue = productRows.reduce((s, r) => s + r.totalValue, 0);

  // ── Wipers/garbage totals ──
  const wgRows = [...wgMap.entries()].map(([catName, v]) => ({ categoryName: catName, ...v }));
  const wgProductRows = [...wgProductMap.values()].sort(
    (a, b) => a.productName.localeCompare(b.productName) || a.articleCode.localeCompare(b.articleCode)
  );
  const totalWipersQty = wgRows.filter((r) => r.subType === "wiper").reduce((s, r) => s + r.qty, 0);
  const totalWipersKg = wgRows.filter((r) => r.subType === "wiper").reduce((s, r) => s + r.totalWeightKg, 0);
  const totalGarbageQty = wgRows
    .filter((r) => r.subType === "garbage" || r.subType === "other")
    .reduce((s, r) => s + r.qty, 0);
  const totalGarbageKg = wgRows
    .filter((r) => r.subType === "garbage" || r.subType === "other")
    .reduce((s, r) => s + r.totalWeightKg, 0);
  const totalWgValue = wgRows.reduce((s, r) => s + r.totalValue, 0);
  const totalWgWeightKg = wgRows.reduce((s, r) => s + r.totalWeightKg, 0);

  // ── Recompute each batch's display cost using current supplier locked rates ──
  // Mirrors GET /api/factory/mix-batches and EditMixBatchDialog: never uses the stored
  // batch cost fields directly; supplier-source rows always use the current locked USD rate.
  const reportBatchIds = mixBatchRows.map((r) => r.id);
  const mixSourceRows =
    reportBatchIds.length > 0
      ? await db
          .select({
            mixBatchId: factoryMixBatchSources.mixBatchId,
            sourceBatchId: factoryMixBatchSources.sourceBatchId,
            supplierId: factoryMixBatchSources.supplierId,
            inventorySupplierId: factoryMixBatchSources.inventorySupplierId,
            containerId: factoryMixBatchSources.containerId,
            weightKg: factoryMixBatchSources.weightKg,
            costPerKg: factoryMixBatchSources.costPerKg,
          })
          .from(factoryMixBatchSources)
          .where(inArray(factoryMixBatchSources.mixBatchId, reportBatchIds))
      : [];

  // Resolve current locked USD rate for every unique supplier referenced by sources
  const reportSupplierIds = [
    ...new Set(mixSourceRows.filter((s) => s.supplierId != null).map((s) => s.supplierId as number)),
  ];
  const reportSupplierRateMap = await getLockedSupplierRatesReadOnlyBulk(db, companyId, reportSupplierIds);

  // Group sources by batch
  const reportSourcesByBatch = new Map();
  for (const src of mixSourceRows) {
    if (!reportSourcesByBatch.has(src.mixBatchId)) reportSourcesByBatch.set(src.mixBatchId, []);
    reportSourcesByBatch.get(src.mixBatchId)!.push(src);
  }

  // Original Batches are historical batch valuations. Keep the stored batch cost/rate
  // instead of re-pricing old batches from today's supplier locked rates. Intentional
  // landed-cost corrections already cascade into these stored batch fields.
  const correctedBatchRows = mixBatchRows;

  // Keep batch-rate arithmetic in decimal space so summing many stored DECIMAL
  // values does not introduce binary floating-point drift before division.
  const totalMixWeightDecimal = correctedBatchRows.reduce(
    (sum, row) => sum.plus(row.totalWeightKg || 0),
    new BatchRateDecimal(0)
  );
  const totalMixCostDecimal = correctedBatchRows.reduce(
    (sum, row) => sum.plus(row.totalCost || 0),
    new BatchRateDecimal(0)
  );
  const totalMixWeightKg = totalMixWeightDecimal.toNumber();
  const totalMixCost = totalMixCostDecimal.toNumber();

  // Material from period batches that is still on the pressing table (not yet turned into bales).
  // Only ACTIVE batches have meaningful on-table material; COMPLETED batches set usedKg = totalWeightKg
  // when closed, so their contribution is already 0 by definition.
  const periodOnTableKg = mixBatchRows.reduce((s: number, r) => {
    if ((r.status || "ACTIVE") !== "ACTIVE") return s;
    const remaining = Math.max(0, toMoney(r.totalWeightKg).minus(toMoney(r.usedKg)).toNumber());
    return s + remaining;
  }, 0);

  // ── Balance on table ──
  // Balance on Table is an "as-of" snapshot. The report's start date never limits
  // this card: we cumulatively include factory history through the selected END date.
  // With no end date (All Time), the queries naturally include all available history.
  // Period blended rate is for the Original Batches card only.
  const blendedCostPerKgDecimal = totalMixWeightDecimal.gt(0)
    ? totalMixCostDecimal.dividedBy(totalMixWeightDecimal).toDecimalPlaces(10)
    : new BatchRateDecimal(0);
  const blendedCostPerKg = blendedCostPerKgDecimal.toNumber();

  // Same source and exact rounding as Factory Net Position.
  const balanceSnapshot = await getFactoryBalanceOnTableSnapshot(companyId, to);
  const balanceBatchRateDecimal = balanceSnapshot.batchRateDecimal;
  const balanceWeightKg = balanceSnapshot.weightKg;
  const balanceCostPerKg = balanceSnapshot.costPerKg;
  const balanceValue = balanceSnapshot.value;

  return {
    missingSelectedPriceBales,
    missingCostPriceBales,
    missingSellingPriceBales,
    productRows,
    categoryRows,
    totalBales,
    totalBaleWeightKg,
    totalProductionValue,
    wgRows,
    wgProductRows,
    totalWipersQty,
    totalWipersKg,
    totalGarbageQty,
    totalGarbageKg,
    totalWgValue,
    totalWgWeightKg,
    mixSourceRows,
    reportSupplierIds,
    reportSupplierRateMap,
    reportSourcesByBatch,
    correctedBatchRows,
    totalMixWeightDecimal,
    totalMixCostDecimal,
    totalMixWeightKg,
    totalMixCost,
    periodOnTableKg,
    blendedCostPerKg,
    balanceBatchRateDecimal,
    balanceWeightKg,
    balanceCostPerKg,
    balanceValue,
  };
}

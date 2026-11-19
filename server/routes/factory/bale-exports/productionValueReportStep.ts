// Extracted from ./production-value-report.ts: a stage of production-value-report.
import { db } from "../../../db";
import {
  factoryCategories,
  factoryBaleProducts,
  factoryMixBatches,
  factoryBales,
  factoryWorkers,
  factoryUserProfiles,
} from "@shared/schema";
import { eq, and, sql, inArray, isNull } from "drizzle-orm";
import type { Request, Response } from "express";

export async function productionValueReportStep({ req, res }: { req: Request; res: Response }) {
  const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
  if (!companyId) return { done: true as const, value: res.status(400).json({ message: "No company selected" }) };

  const currentRole = String(req.session.currentRole ?? req.user?.role ?? "").toLowerCase();
  const isPrivileged = ["admin", "owner", "developer"].includes(currentRole);
  const reportView = String(req.query.view ?? "");
  const valuationMode: "selling" | "cost" = req.query.valuationMode === "selling" ? "selling" : "cost";
  let hideReportCosts = false;
  if (!isPrivileged && req.session.userId) {
    const [profile] = await db
      .select({
        hiddenCostFields: factoryUserProfiles.hiddenCostFields,
        hideAllCosts: factoryUserProfiles.hideAllCosts,
      })
      .from(factoryUserProfiles)
      .where(and(eq(factoryUserProfiles.companyId, companyId), eq(factoryUserProfiles.userId, req.session.userId)))
      .limit(1);
    const hiddenFields = profile?.hiddenCostFields ?? [];
    const hasAnyProductionCostRestriction =
      hiddenFields.includes("production_comparison_costing") || hiddenFields.includes("production_report_costing");
    const viewCostRestricted =
      reportView === "production-comparison"
        ? hiddenFields.includes("production_comparison_costing")
        : reportView === "production"
          ? hiddenFields.includes("production_report_costing")
          : hasAnyProductionCostRestriction;
    hideReportCosts = Boolean(profile?.hideAllCosts || viewCostRestricted);
  }

  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  // Worker filter — accepts a single `workerId` (legacy) or a comma-separated
  // `workerIds` list (multi-select filter on the Production Comparison page).
  const workerIdParam = req.query.workerId as string | undefined;
  const workerIdsParam = req.query.workerIds as string | undefined;
  const workerIdFilter = [
    ...new Set(
      [...(workerIdsParam ? workerIdsParam.split(",") : []), ...(workerIdParam ? [workerIdParam] : [])]
        .map((v) => parseInt(String(v).trim(), 10))
        .filter((n) => Number.isFinite(n))
    ),
  ];

  // ── Build date range conditions ──
  // Use COALESCE(stock_entry_date, DATE(created_at)) so bales without a stock_entry_date
  // (e.g. wipers/garbage entered via stock import) are still included using their creation date.
  const baleConditions = [
    eq(factoryBales.companyId, companyId),
    // Exclude deleted/removed bales and REPACKED originals.
    // REPACKED: when a bale is repacked a new IN_STOCK bale is created with the same
    // weight; the original bale stays in the DB with status REPACKED.  Counting both
    // would double-count that weight in Productions.
    sql`${factoryBales.status} NOT IN ('DELETED', 'REMOVED', 'REPACKED')`,
  ];
  if (from)
    baleConditions.push(
      sql`COALESCE(DATE(${factoryBales.stockEntryDate}), DATE(${factoryBales.createdAt})) >= ${from}`
    );
  if (to)
    baleConditions.push(sql`COALESCE(DATE(${factoryBales.stockEntryDate}), DATE(${factoryBales.createdAt})) <= ${to}`);
  if (workerIdFilter.length === 1) baleConditions.push(eq(factoryBales.finalizedBy, workerIdFilter[0]));
  else if (workerIdFilter.length > 1) baleConditions.push(inArray(factoryBales.finalizedBy, workerIdFilter));

  // Exclude CARRY_FORWARD batches from the "Original Batches" total.
  // CARRY_FORWARD batches represent leftover material from a parent batch whose weight is
  // already counted in the parent's totalWeightKg.  Including them would double-count
  // that leftover and inflate the raw-material total.
  // Also exclude soft-deleted batches (deletedAt IS NOT NULL): their bales are deleted
  // and excluded from Productions, so counting them here would widen the gap unfairly.
  const mixBatchConditions = [
    eq(factoryMixBatches.companyId, companyId),
    sql`${factoryMixBatches.carryForwardFromId} IS NULL`,
    isNull(factoryMixBatches.deletedAt),
  ];
  if (from)
    mixBatchConditions.push(
      sql`COALESCE(${factoryMixBatches.batchDate}, DATE(${factoryMixBatches.createdAt})) >= ${from}`
    );
  if (to)
    mixBatchConditions.push(
      sql`COALESCE(${factoryMixBatches.batchDate}, DATE(${factoryMixBatches.createdAt})) <= ${to}`
    );

  // Bale and mix-batch reads are independent. Start them together so the
  // report does not pay both database latencies serially.
  const baleRowsPromise = db
    .select({
      id: factoryBales.id,
      mixBatchId: factoryBales.mixBatchId,
      articleCode: factoryBales.articleCode,
      productName: factoryBales.productName,
      catalogArticleCode: factoryBaleProducts.articleCode,
      catalogProductName: factoryBaleProducts.name,
      weightKg: factoryBales.weightKg,
      stockEntryDate: factoryBales.stockEntryDate,
      productionPrice: factoryBaleProducts.productionPrice,
      sellingPrice: factoryBaleProducts.sellingPrice,
      productId: factoryBales.productId,
      categoryId: factoryBaleProducts.categoryId,
      categoryName: factoryCategories.name,
      finalizedBy: factoryBales.finalizedBy,
      baleWorkerName: factoryBales.workerName,
      workerFullName: factoryWorkers.fullName,
    })
    .from(factoryBales)
    .leftJoin(factoryBaleProducts, eq(factoryBales.productId, factoryBaleProducts.id))
    .leftJoin(factoryCategories, eq(factoryBaleProducts.categoryId, factoryCategories.id))
    .leftJoin(factoryWorkers, eq(factoryBales.finalizedBy, factoryWorkers.id))
    .where(and(...baleConditions));

  const mixBatchRowsPromise = db
    .select({
      id: factoryMixBatches.id,
      batchCode: factoryMixBatches.batchCode,
      name: factoryMixBatches.name,
      totalWeightKg: factoryMixBatches.totalWeightKg,
      usedKg: factoryMixBatches.usedKg,
      status: factoryMixBatches.status,
      costPerKg: factoryMixBatches.costPerKg,
      totalCost: factoryMixBatches.totalCost,
      batchDate: factoryMixBatches.batchDate,
      createdAt: factoryMixBatches.createdAt,
    })
    .from(factoryMixBatches)
    .where(and(...mixBatchConditions))
    .orderBy(sql`COALESCE(${factoryMixBatches.batchDate}, DATE(${factoryMixBatches.createdAt}))`);

  const [baleRows, mixBatchRows] = await Promise.all([baleRowsPromise, mixBatchRowsPromise]);

  // Batch linkage follows the bales in the selected production period (and worker filter),
  // rather than the mix-batch creation date. This lets Production Comparison calculate
  // batch count/amount for whatever product/category/grade filters are applied client-side.
  const linkedMixBatchIds = [
    ...new Set(
      baleRows.map((row) => row.mixBatchId).filter((id): id is number => id != null && Number.isFinite(Number(id)))
    ),
  ];
  const linkedBatchRows =
    linkedMixBatchIds.length > 0
      ? await db
          .select({
            id: factoryMixBatches.id,
            totalWeightKg: factoryMixBatches.totalWeightKg,
          })
          .from(factoryMixBatches)
          .where(
            and(
              eq(factoryMixBatches.companyId, companyId),
              inArray(factoryMixBatches.id, linkedMixBatchIds),
              isNull(factoryMixBatches.deletedAt)
            )
          )
      : [];

  // ── Helper: detect wipers/garbage by category name ──
  function isWiperOrGarbage(catName: string): boolean {
    const lower = (catName || "").toLowerCase();
    return lower.includes("wiper") || lower.includes("garbage") || lower.includes("rag");
  }

  // ── Aggregate by article code (regular bales only) ──
  const productMap = new Map<
    string,
    {
      articleCode: string;
      productName: string;
      categoryName: string;
      qty: number;
      totalWeightKg: number;
      costPricePerBale: number;
      pricePerBale: number;
      totalValue: number;
      // Distinct mix batches that produced this product in the period.
      mixBatchIds: Set<number>;
      // Distinct workers who finalized bales of this product in the period.
      workers: Map<string, { id: number | null; name: string; qty: number }>;
    }
  >();

  // ── Aggregate by category (regular bales only) ──
  const categoryMap = new Map<
    string,
    {
      categoryName: string;
      qty: number;
      totalWeightKg: number;
      totalValue: number;
    }
  >();

  // ── Wipers & Garbage aggregation (separate) ──
  const wgMap = new Map<
    string,
    {
      subType: "wiper" | "garbage" | "other";
      qty: number;
      totalWeightKg: number;
      totalValue: number;
    }
  >();
  // Keep the existing subtype totals, but retain real catalogue products
  // so Production Overview can expand Wipers & Garbage like regular categories.
  const wgProductMap = new Map<
    string,
    {
      articleCode: string;
      productName: string;
      categoryName: string;
      qty: number;
      totalWeightKg: number;
      costPricePerBale: number;
      pricePerBale: number;
      totalValue: number;
    }
  >();

  const totalSellingValue = 0;
  const totalProductionCostValue = 0;

  return {
    done: false as const,
    companyId,
    valuationMode,
    hideReportCosts,
    from,
    to,
    baleRows,
    mixBatchRows,
    linkedBatchRows,
    isWiperOrGarbage,
    productMap,
    categoryMap,
    wgMap,
    wgProductMap,
    totalSellingValue,
    totalProductionCostValue,
  };
}

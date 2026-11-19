import { and, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { db } from "../db";
import { aiActionLog, salesItems, stockTransferVouchers, vouchers } from "@shared/schema";
import { roundNumber } from "./smartTransferPerformance";
import {
  APPROVAL_ACTION,
  DAY_MS,
  IMPORT_ACTION,
  PREVIEW_ACTION,
  RESET_ACTION,
  clamp,
  jsonObject,
  normalizeLines,
  numberValue,
  type FeedbackComparison,
} from "./createSmartTransferPreviewFeedback";
import { reconcileApprovals } from "./recordSmartTransferImportFeedback";
import { weightedAverage } from "./smartTransferFeedbackHelpers";
export { resetSmartTransferFeedback } from "./smartTransferFeedbackHelpers";
export { createSmartTransferPreviewFeedback } from "./createSmartTransferPreviewFeedback";
export { recordSmartTransferImportFeedback } from "./recordSmartTransferImportFeedback";

export async function getSmartTransferFeedbackSummary(companyId: number, requestedDays: number) {
  const periodDays = clamp(Math.floor(requestedDays || 90), 7, 365);
  const periodStart = new Date(Date.now() - periodDays * DAY_MS);
  const [latestReset] = await db
    .select()
    .from(aiActionLog)
    .where(and(eq(aiActionLog.companyId, companyId), eq(aiActionLog.actionName, RESET_ACTION)))
    .orderBy(desc(aiActionLog.createdAt))
    .limit(1);
  const since = latestReset && latestReset.createdAt > periodStart ? latestReset.createdAt : periodStart;

  await reconcileApprovals(companyId, since);

  const logs = await db
    .select()
    .from(aiActionLog)
    .where(
      and(
        eq(aiActionLog.companyId, companyId),
        inArray(aiActionLog.actionName, [PREVIEW_ACTION, IMPORT_ACTION, APPROVAL_ACTION]),
        gte(aiActionLog.createdAt, since)
      )
    )
    .orderBy(aiActionLog.createdAt);

  const previews = logs.filter((row) => row.actionName === PREVIEW_ACTION);
  const imports = logs.filter((row) => row.actionName === IMPORT_ACTION);
  const approvals = logs.filter((row) => row.actionName === APPROVAL_ACTION);
  const importComparisons = imports
    .map((row) => jsonObject(row.outputJson).comparison as FeedbackComparison | null)
    .filter((value): value is FeedbackComparison => Boolean(value));
  const approvalComparisons = approvals
    .map((row) => jsonObject(row.outputJson).comparison as FeedbackComparison | null)
    .filter((value): value is FeedbackComparison => Boolean(value));

  const comparisonPool = approvalComparisons.length > 0 ? approvalComparisons : importComparisons;
  const editing = {
    editedImportPct: roundNumber(
      importComparisons.length > 0
        ? (importComparisons.filter((comparison) => comparison.edited).length / importComparisons.length) * 100
        : 0,
      2
    ),
    quantityKeptPct: roundNumber(
      weightedAverage(
        comparisonPool.map((comparison) => ({
          value: comparison.quantityKeptPct,
          weight: comparison.suggestedQuantity,
        }))
      ),
      2
    ),
    lineKeptPct: roundNumber(
      weightedAverage(
        comparisonPool.map((comparison) => ({ value: comparison.lineKeptPct, weight: comparison.suggestedLineCount }))
      ),
      2
    ),
    itemKeptPct: roundNumber(
      weightedAverage(
        comparisonPool.map((comparison) => ({ value: comparison.itemKeptPct, weight: comparison.suggestedItemCount }))
      ),
      2
    ),
    sourceKeptPct: roundNumber(
      weightedAverage(
        comparisonPool.map((comparison) => ({ value: comparison.sourceKeptPct, weight: comparison.keptQuantity }))
      ),
      2
    ),
    addedQuantity: comparisonPool.reduce((sum, comparison) => sum + comparison.addedQuantity, 0),
    removedQuantity: comparisonPool.reduce((sum, comparison) => sum + comparison.removedQuantity, 0),
    sourceChangedQuantity: comparisonPool.reduce((sum, comparison) => sum + comparison.sourceChangedQuantity, 0),
  };

  const approvalPayloads = approvals.map((row) => ({ row, output: jsonObject(row.outputJson) }));
  const voucherIds = approvalPayloads
    .map((entry) => Number(entry.output.voucherId ?? entry.row.createdRecordId))
    .filter((id) => Number.isInteger(id) && id > 0);
  const transferRows =
    voucherIds.length > 0
      ? await db
          .select({
            voucherId: vouchers.id,
            voucherDate: vouchers.voucherDate,
            destinationLocationId: stockTransferVouchers.destinationLocationId,
            inventoryApplied: stockTransferVouchers.inventoryApplied,
          })
          .from(vouchers)
          .innerJoin(stockTransferVouchers, eq(stockTransferVouchers.voucherId, vouchers.id))
          .where(and(eq(vouchers.companyId, companyId), inArray(vouchers.id, voucherIds), isNull(vouchers.deletedAt)))
      : [];
  const transferByVoucher = new Map(transferRows.map((row) => [row.voucherId, row]));

  const performanceCandidates = approvalPayloads
    .map((entry) => {
      const voucherId = Number(entry.output.voucherId ?? entry.row.createdRecordId);
      const transfer = transferByVoucher.get(voucherId);
      const finalItems = normalizeLines(entry.output.finalItems);
      if (!transfer || !transfer.inventoryApplied || finalItems.length === 0) return null;
      const daysOld = Math.floor((Date.now() - new Date(`${transfer.voucherDate}T00:00:00Z`).getTime()) / DAY_MS);
      const daysObserved = Math.min(30, Math.max(0, daysOld));
      if (daysObserved < 7) return null;
      return {
        voucherId,
        voucherDate: transfer.voucherDate,
        destinationLocationId: transfer.destinationLocationId,
        daysObserved,
        finalItems,
        forecastByItem: jsonObject(entry.output.forecastByItem),
      };
    })
    .filter((value): value is NonNullable<typeof value> => Boolean(value));

  const itemIds = Array.from(
    new Set(performanceCandidates.flatMap((candidate) => candidate.finalItems.map((item) => item.stockItemId)))
  );
  const destinationIds = Array.from(new Set(performanceCandidates.map((candidate) => candidate.destinationLocationId)));
  const earliestVoucherDate = performanceCandidates.reduce<string | null>(
    (current, candidate) => (!current || candidate.voucherDate < current ? candidate.voucherDate : current),
    null
  );
  const today = new Date().toISOString().slice(0, 10);
  const salesRows =
    performanceCandidates.length > 0 && itemIds.length > 0 && destinationIds.length > 0 && earliestVoucherDate
      ? await db
          .select({
            stockItemId: salesItems.stockItemId,
            locationId: vouchers.locationId,
            voucherDate: vouchers.voucherDate,
            quantity: salesItems.quantity,
          })
          .from(salesItems)
          .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
          .where(
            and(
              eq(vouchers.companyId, companyId),
              eq(vouchers.voucherType, "Sales"),
              eq(vouchers.optional, false),
              isNull(vouchers.deletedAt),
              inArray(vouchers.locationId, destinationIds),
              inArray(salesItems.stockItemId, itemIds),
              gte(vouchers.voucherDate, earliestVoucherDate),
              lte(vouchers.voucherDate, today)
            )
          )
      : [];

  const performanceRows = performanceCandidates.map((candidate) => {
    const end = new Date(`${candidate.voucherDate}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + candidate.daysObserved);
    const endDate = end.toISOString().slice(0, 10);
    const approvedQty = candidate.finalItems.reduce((sum, item) => sum + item.quantity, 0);
    let actualSales = 0;
    let predictedSales = 0;

    for (const item of candidate.finalItems) {
      actualSales += salesRows
        .filter(
          (sale) =>
            sale.locationId === candidate.destinationLocationId &&
            sale.stockItemId === item.stockItemId &&
            sale.voucherDate >= candidate.voucherDate &&
            sale.voucherDate <= endDate
        )
        .reduce((sum, sale) => sum + numberValue(sale.quantity), 0);
      const forecastRate = numberValue(candidate.forecastByItem[String(item.stockItemId)]);
      predictedSales += forecastRate * candidate.daysObserved;
    }

    const accuracy = 100 * (1 - Math.abs(actualSales - predictedSales) / Math.max(1, actualSales, predictedSales));
    const biasPct = ((predictedSales - actualSales) / Math.max(1, actualSales)) * 100;
    return {
      voucherId: candidate.voucherId,
      approvedQty,
      actualSales,
      predictedSales,
      accuracyPct: clamp(accuracy, 0, 100),
      biasPct,
      observedSalesToTransferPct: (actualSales / Math.max(1, approvedQty)) * 100,
    };
  });

  const performance = {
    sampleSize: performanceRows.length,
    forecastAccuracyPct: roundNumber(
      weightedAverage(performanceRows.map((row) => ({ value: row.accuracyPct, weight: Math.max(1, row.actualSales) }))),
      2
    ),
    forecastBiasPct: roundNumber(
      weightedAverage(performanceRows.map((row) => ({ value: row.biasPct, weight: Math.max(1, row.actualSales) }))),
      2
    ),
    observedSalesToTransferPct: roundNumber(
      weightedAverage(
        performanceRows.map((row) => ({ value: row.observedSalesToTransferPct, weight: Math.max(1, row.approvedQty) }))
      ),
      2
    ),
    underForecastRatePct: roundNumber(
      performanceRows.length > 0
        ? (performanceRows.filter((row) => row.actualSales > row.predictedSales * 1.25).length /
            performanceRows.length) *
            100
        : 0,
      2
    ),
    overForecastRatePct: roundNumber(
      performanceRows.length > 0
        ? (performanceRows.filter((row) => row.predictedSales > row.actualSales * 1.25).length /
            performanceRows.length) *
            100
        : 0,
      2
    ),
    caveat:
      "Observed destination sales can include opening stock or other receipts; this is an accuracy indicator, not exact transfer-only sell-through.",
  };

  const recommendations: string[] = [];
  if (approvals.length < 5) {
    recommendations.push(
      "Collect at least five approved smart transfers before changing forecasting or source-selection weights."
    );
  } else {
    if (editing.quantityKeptPct < 70)
      recommendations.push(
        "Users frequently reduce suggested quantities; review demand coverage and concentration caps before increasing automation."
      );
    if (editing.sourceKeptPct < 70)
      recommendations.push(
        "Users frequently change source locations; review source reserve days, pending commitments and route-history weighting."
      );
    if (performance.sampleSize >= 5 && performance.forecastBiasPct > 20)
      recommendations.push(
        "Forecasts are running high versus observed destination sales; reduce recent-sales acceleration or coverage weighting cautiously."
      );
    if (performance.sampleSize >= 5 && performance.forecastBiasPct < -20)
      recommendations.push(
        "Forecasts are running low versus observed destination sales; increase recent-demand sensitivity cautiously."
      );
    if (performance.sampleSize >= 5 && performance.forecastAccuracyPct >= 80 && editing.quantityKeptPct >= 80)
      recommendations.push(
        "The current rules are stable enough for a limited pilot of stronger default recommendations, while keeping manual approval."
      );
  }
  if (recommendations.length === 0)
    recommendations.push(
      "Keep the current deterministic rules and continue collecting feedback; no tuning change is justified yet."
    );

  return {
    feedbackVersion: 4,
    learningMode: "observe-only",
    periodDays,
    since: since.toISOString(),
    resetAt: latestReset?.createdAt?.toISOString() ?? null,
    counts: {
      previews: previews.length,
      imports: imports.length,
      approvals: approvals.length,
      finalizedPerformanceSamples: performance.sampleSize,
    },
    adoption: {
      importRatePct: roundNumber(previews.length > 0 ? (imports.length / previews.length) * 100 : 0, 2),
      approvalRatePct: roundNumber(previews.length > 0 ? (approvals.length / previews.length) * 100 : 0, 2),
    },
    editing,
    performance,
    recommendations,
    lastUpdatedAt: new Date().toISOString(),
  };
}

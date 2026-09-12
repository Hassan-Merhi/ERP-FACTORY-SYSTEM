import { randomUUID } from "crypto";
import { logger } from "../lib/logger";
import { and, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { db } from "../db";
import { aiActionLog, salesItems, stockTransferItems, stockTransferVouchers, vouchers } from "@shared/schema";
import { roundNumber } from "./smartTransferPerformance";

const PREVIEW_ACTION = "smart_transfer_preview_v4";
const IMPORT_ACTION = "smart_transfer_import_v4";
const APPROVAL_ACTION = "smart_transfer_approval_v4";
const RESET_ACTION = "smart_transfer_feedback_reset_v4";
const MATCH_WINDOW_MS = 48 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface CompactFeedbackLine {
  stockItemId: number;
  sourceLocationId: number;
  quantity: number;
  forecastDailyRate: number;
  itemScore: number;
}

interface FeedbackComparison {
  suggestedQuantity: number;
  finalQuantity: number;
  keptQuantity: number;
  addedQuantity: number;
  removedQuantity: number;
  suggestedLineCount: number;
  finalLineCount: number;
  keptLineCount: number;
  suggestedItemCount: number;
  keptItemCount: number;
  sourceChangedQuantity: number;
  quantityKeptPct: number;
  lineKeptPct: number;
  itemKeptPct: number;
  sourceKeptPct: number;
  edited: boolean;
}

function numberValue(value: unknown): number {
  const parsed = Number.parseFloat(String(value ?? "0"));
  return Number.isFinite(parsed) ? parsed : 0;
}

function wholeNonNegative(value: unknown): number {
  const parsed = numberValue(value);
  return parsed > 0 ? Math.floor(parsed) : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function _dateKey(value: Date | string): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function normalizeLines(lines: unknown): CompactFeedbackLine[] {
  if (!Array.isArray(lines)) return [];
  const merged = new Map<string, CompactFeedbackLine>();

  for (const raw of lines) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const stockItemId = Number(row.stockItemId);
    const sourceLocationId = Number(row.sourceLocationId);
    const quantity = wholeNonNegative(row.quantity ?? row.suggestedQuantity);
    if (!Number.isInteger(stockItemId) || stockItemId <= 0) continue;
    if (!Number.isInteger(sourceLocationId) || sourceLocationId <= 0) continue;
    if (quantity <= 0) continue;

    const key = `${stockItemId}:${sourceLocationId}`;
    const existing = merged.get(key);
    if (existing) {
      existing.quantity += quantity;
      existing.forecastDailyRate = Math.max(existing.forecastDailyRate, numberValue(row.forecastDailyRate));
      existing.itemScore = Math.max(existing.itemScore, wholeNonNegative(row.itemScore));
    } else {
      merged.set(key, {
        stockItemId,
        sourceLocationId,
        quantity,
        forecastDailyRate: Math.max(0, numberValue(row.forecastDailyRate)),
        itemScore: clamp(wholeNonNegative(row.itemScore), 0, 100),
      });
    }
  }

  return Array.from(merged.values()).sort(
    (a, b) => a.stockItemId - b.stockItemId || a.sourceLocationId - b.sourceLocationId
  );
}

function lineMap(lines: CompactFeedbackLine[]): Map<string, CompactFeedbackLine> {
  return new Map(lines.map((line) => [`${line.stockItemId}:${line.sourceLocationId}`, line]));
}

function itemTotals(lines: CompactFeedbackLine[]): Map<number, number> {
  const totals = new Map<number, number>();
  for (const line of lines) totals.set(line.stockItemId, (totals.get(line.stockItemId) ?? 0) + line.quantity);
  return totals;
}

function compareLines(suggested: CompactFeedbackLine[], finalLines: CompactFeedbackLine[]): FeedbackComparison {
  const suggestedMap = lineMap(suggested);
  const finalMap = lineMap(finalLines);
  const suggestedItems = itemTotals(suggested);
  const finalItems = itemTotals(finalLines);

  let keptQuantity = 0;
  let addedQuantity = 0;
  let removedQuantity = 0;
  let keptLineCount = 0;

  for (const [key, suggestedLine] of suggestedMap.entries()) {
    const finalLine = finalMap.get(key);
    const finalQty = finalLine?.quantity ?? 0;
    keptQuantity += Math.min(suggestedLine.quantity, finalQty);
    if (finalQty > 0) keptLineCount += 1;
    if (suggestedLine.quantity > finalQty) removedQuantity += suggestedLine.quantity - finalQty;
  }
  for (const [key, finalLine] of finalMap.entries()) {
    const suggestedQty = suggestedMap.get(key)?.quantity ?? 0;
    if (finalLine.quantity > suggestedQty) addedQuantity += finalLine.quantity - suggestedQty;
  }

  let keptItemCount = 0;
  let itemOverlapQuantity = 0;
  for (const [stockItemId, suggestedQty] of suggestedItems.entries()) {
    const finalQty = finalItems.get(stockItemId) ?? 0;
    if (finalQty > 0) keptItemCount += 1;
    itemOverlapQuantity += Math.min(suggestedQty, finalQty);
  }

  const suggestedQuantity = suggested.reduce((sum, line) => sum + line.quantity, 0);
  const finalQuantity = finalLines.reduce((sum, line) => sum + line.quantity, 0);
  const sourceChangedQuantity = Math.max(0, itemOverlapQuantity - keptQuantity);
  const quantityKeptPct = suggestedQuantity > 0 ? (keptQuantity / suggestedQuantity) * 100 : 0;
  const lineKeptPct = suggestedMap.size > 0 ? (keptLineCount / suggestedMap.size) * 100 : 0;
  const itemKeptPct = suggestedItems.size > 0 ? (keptItemCount / suggestedItems.size) * 100 : 0;
  const sourceKeptPct = itemOverlapQuantity > 0 ? (keptQuantity / itemOverlapQuantity) * 100 : 0;

  return {
    suggestedQuantity,
    finalQuantity,
    keptQuantity,
    addedQuantity,
    removedQuantity,
    suggestedLineCount: suggestedMap.size,
    finalLineCount: finalMap.size,
    keptLineCount,
    suggestedItemCount: suggestedItems.size,
    keptItemCount,
    sourceChangedQuantity,
    quantityKeptPct: roundNumber(quantityKeptPct, 2),
    lineKeptPct: roundNumber(lineKeptPct, 2),
    itemKeptPct: roundNumber(itemKeptPct, 2),
    sourceKeptPct: roundNumber(sourceKeptPct, 2),
    edited: addedQuantity > 0 || removedQuantity > 0 || sourceChangedQuantity > 0,
  };
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The few top-level preview fields persisted into the feedback log. */
interface PreviewFeedbackFields {
  lines?: unknown;
  destinationLocationId?: unknown;
  targetQuantity?: unknown;
  achievedQuantity?: unknown;
  forecastingVersion?: number;
  sourceOptimizationVersion?: number;
  businessRulesVersion?: number;
}

export async function createSmartTransferPreviewFeedback(params: {
  companyId: number;
  userId: string;
  requestInput: unknown;
  preview: object;
}): Promise<string | null> {
  try {
    // The preview payload is a smart-transfer preview result; only these
    // top-level fields are persisted, so they are read structurally.
    const previewFields = params.preview as PreviewFeedbackFields;
    const sessionId = `stf_${randomUUID()}`;
    const lines = normalizeLines(previewFields.lines);
    const averageScore = lines.length > 0 ? lines.reduce((sum, line) => sum + line.itemScore, 0) / lines.length : 0;

    await db.insert(aiActionLog).values({
      companyId: params.companyId,
      userId: params.userId,
      sessionId,
      actionType: "draft",
      actionName: PREVIEW_ACTION,
      inputJson: params.requestInput,
      outputJson: {
        destinationLocationId: previewFields.destinationLocationId,
        targetQuantity: previewFields.targetQuantity,
        achievedQuantity: previewFields.achievedQuantity,
        forecastingVersion: previewFields.forecastingVersion ?? 1,
        sourceOptimizationVersion: previewFields.sourceOptimizationVersion ?? 2,
        businessRulesVersion: previewFields.businessRulesVersion ?? 3,
        averageItemScore: roundNumber(averageScore, 2),
        lines,
      },
      status: "success",
    });
    return sessionId;
  } catch (error) {
    logger.error("[SmartTransferFeedback] Preview log failed:", { error: (error as Error).message });
    return null;
  }
}

async function latestPreview(params: {
  companyId: number;
  userId: string;
  destinationLocationId: number;
  sessionId?: string | null;
}) {
  const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const rows = await db
    .select()
    .from(aiActionLog)
    .where(
      and(
        eq(aiActionLog.companyId, params.companyId),
        eq(aiActionLog.userId, params.userId),
        eq(aiActionLog.actionName, PREVIEW_ACTION),
        gte(aiActionLog.createdAt, cutoff),
        ...(params.sessionId ? [eq(aiActionLog.sessionId, params.sessionId)] : [])
      )
    )
    .orderBy(desc(aiActionLog.createdAt))
    .limit(20);

  return (
    rows.find((row) => {
      const output = jsonObject(row.outputJson);
      return Number(output.destinationLocationId) === params.destinationLocationId;
    }) ?? null
  );
}

export async function recordSmartTransferImportFeedback(params: {
  companyId: number;
  userId: string;
  destinationLocationId: number;
  sourceLocationIds: number[];
  importedItems: unknown;
  sessionId?: string | null;
}): Promise<{ sessionId: string; matchedPreview: boolean; comparison: FeedbackComparison | null }> {
  const preview = await latestPreview(params);
  const sessionId = preview?.sessionId || params.sessionId || `stf_${randomUUID()}`;
  const previewOutput = jsonObject(preview?.outputJson);
  const suggestedLines = normalizeLines(previewOutput.lines);
  const importedLines = normalizeLines(params.importedItems);
  const comparison = preview ? compareLines(suggestedLines, importedLines) : null;

  await db.insert(aiActionLog).values({
    companyId: params.companyId,
    userId: params.userId,
    sessionId,
    actionType: "draft",
    actionName: IMPORT_ACTION,
    inputJson: {
      destinationLocationId: params.destinationLocationId,
      sourceLocationIds: params.sourceLocationIds,
    },
    outputJson: {
      matchedPreview: Boolean(preview),
      importedItems: importedLines,
      comparison,
    },
    status: "success",
  });

  return { sessionId, matchedPreview: Boolean(preview), comparison };
}

function transferSimilarity(imported: CompactFeedbackLine[], actual: CompactFeedbackLine[]): number {
  if (imported.length === 0 || actual.length === 0) return 0;
  const comparison = compareLines(imported, actual);
  const totalRatio =
    Math.min(comparison.finalQuantity, comparison.suggestedQuantity) /
    Math.max(1, Math.max(comparison.finalQuantity, comparison.suggestedQuantity));
  return clamp(
    comparison.itemKeptPct * 0.35 +
      comparison.sourceKeptPct * 0.25 +
      comparison.quantityKeptPct * 0.25 +
      totalRatio * 100 * 0.15,
    0,
    100
  );
}

async function reconcileApprovals(companyId: number, since: Date): Promise<number> {
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

  const imports = logs.filter((row) => row.actionName === IMPORT_ACTION && row.sessionId);
  const approvalSessions = new Set(
    logs.filter((row) => row.actionName === APPROVAL_ACTION && row.sessionId).map((row) => row.sessionId as string)
  );
  const unmatched = imports.filter((row) => !approvalSessions.has(row.sessionId as string));
  if (unmatched.length === 0) return 0;

  const earliestImport = new Date(Math.min(...unmatched.map((row) => row.createdAt.getTime())));
  const latestMatchTime = new Date(Date.now());
  const transferRows = await db
    .select({
      transferId: stockTransferVouchers.id,
      voucherId: vouchers.id,
      destinationLocationId: stockTransferVouchers.destinationLocationId,
      inventoryApplied: stockTransferVouchers.inventoryApplied,
      optional: vouchers.optional,
      voucherDate: vouchers.voucherDate,
      createdAt: stockTransferVouchers.createdAt,
    })
    .from(stockTransferVouchers)
    .innerJoin(vouchers, eq(stockTransferVouchers.voucherId, vouchers.id))
    .where(
      and(
        eq(vouchers.companyId, companyId),
        inArray(vouchers.voucherType, ["Stock Transfer", "StockTransfer"]),
        isNull(vouchers.deletedAt),
        gte(stockTransferVouchers.createdAt, earliestImport),
        lte(stockTransferVouchers.createdAt, latestMatchTime)
      )
    );
  if (transferRows.length === 0) return 0;

  const transferIds = transferRows.map((row) => row.transferId);
  const itemRows = await db
    .select({
      transferId: stockTransferItems.transferId,
      stockItemId: stockTransferItems.stockItemId,
      sourceLocationId: stockTransferItems.sourceLocationId,
      quantity: stockTransferItems.quantity,
    })
    .from(stockTransferItems)
    .where(inArray(stockTransferItems.transferId, transferIds));

  const itemsByTransfer = new Map<number, CompactFeedbackLine[]>();
  for (const row of itemRows) {
    const list = itemsByTransfer.get(row.transferId) ?? [];
    list.push({
      stockItemId: row.stockItemId,
      sourceLocationId: Number(row.sourceLocationId),
      quantity: wholeNonNegative(row.quantity),
      forecastDailyRate: 0,
      itemScore: 0,
    });
    itemsByTransfer.set(row.transferId, list);
  }

  const previewBySession = new Map(
    logs
      .filter((row) => row.actionName === PREVIEW_ACTION && row.sessionId)
      .map((row) => [row.sessionId as string, row])
  );
  const usedTransferIds = new Set<number>();
  let created = 0;

  for (const importLog of unmatched) {
    const importOutput = jsonObject(importLog.outputJson);
    const importedItems = normalizeLines(importOutput.importedItems);
    const destinationLocationId = Number(jsonObject(importLog.inputJson).destinationLocationId);
    if (importedItems.length === 0 || !Number.isInteger(destinationLocationId)) continue;

    const candidates = transferRows
      .filter((transfer) => {
        if (usedTransferIds.has(transfer.transferId)) return false;
        if (transfer.destinationLocationId !== destinationLocationId) return false;
        const delta = transfer.createdAt.getTime() - importLog.createdAt.getTime();
        return delta >= -5 * 60 * 1000 && delta <= MATCH_WINDOW_MS;
      })
      .map((transfer) => {
        const actualItems = normalizeLines(itemsByTransfer.get(transfer.transferId) ?? []);
        const similarity = transferSimilarity(importedItems, actualItems);
        const minutesAfterImport = Math.abs(transfer.createdAt.getTime() - importLog.createdAt.getTime()) / 60000;
        const timeScore = clamp(100 - minutesAfterImport / 4, 0, 100);
        return { transfer, actualItems, similarity, combinedScore: similarity * 0.9 + timeScore * 0.1 };
      })
      .filter((candidate) => candidate.similarity >= 60)
      .sort((a, b) => b.combinedScore - a.combinedScore);

    const best = candidates[0];
    if (!best) continue;
    usedTransferIds.add(best.transfer.transferId);

    const previewLog = previewBySession.get(importLog.sessionId as string);
    const previewLines = normalizeLines(jsonObject(previewLog?.outputJson).lines);
    const comparison = compareLines(previewLines.length > 0 ? previewLines : importedItems, best.actualItems);
    const forecastByItem = new Map<number, number>();
    for (const line of previewLines) {
      forecastByItem.set(line.stockItemId, Math.max(forecastByItem.get(line.stockItemId) ?? 0, line.forecastDailyRate));
    }

    await db.insert(aiActionLog).values({
      companyId,
      userId: importLog.userId,
      sessionId: importLog.sessionId,
      actionType: "write",
      actionName: APPROVAL_ACTION,
      createdRecordId: best.transfer.voucherId,
      inputJson: {
        importLogId: importLog.id,
        matchedBy: "destination-item-source-quantity-time",
      },
      outputJson: {
        voucherId: best.transfer.voucherId,
        transferId: best.transfer.transferId,
        voucherDate: best.transfer.voucherDate,
        destinationLocationId: best.transfer.destinationLocationId,
        inventoryApplied: Boolean(best.transfer.inventoryApplied),
        optional: Boolean(best.transfer.optional),
        matchConfidencePct: roundNumber(best.similarity, 2),
        finalItems: best.actualItems,
        forecastByItem: Object.fromEntries(forecastByItem.entries()),
        comparison,
      },
      status: "success",
    });
    created += 1;
  }

  return created;
}

function weightedAverage(entries: Array<{ value: number; weight: number }>): number {
  const totalWeight = entries.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0);
  if (totalWeight <= 0) return 0;
  return entries.reduce((sum, entry) => sum + entry.value * Math.max(0, entry.weight), 0) / totalWeight;
}

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

export async function resetSmartTransferFeedback(params: { companyId: number; userId: string }): Promise<string> {
  const sessionId = `stf_reset_${randomUUID()}`;
  await db.insert(aiActionLog).values({
    companyId: params.companyId,
    userId: params.userId,
    sessionId,
    actionType: "write",
    actionName: RESET_ACTION,
    outputJson: { resetAt: new Date().toISOString() },
    status: "success",
  });
  return sessionId;
}

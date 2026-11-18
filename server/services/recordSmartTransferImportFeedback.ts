// Extracted from ./smartTransferFeedback.ts to keep that module under the source-size cap.
import { randomUUID } from "crypto";
import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { db } from "../db";
import { aiActionLog, stockTransferItems, stockTransferVouchers, vouchers } from "@shared/schema";
import { roundNumber } from "./smartTransferPerformance";
import {
  APPROVAL_ACTION,
  IMPORT_ACTION,
  MATCH_WINDOW_MS,
  PREVIEW_ACTION,
  clamp,
  compareLines,
  jsonObject,
  latestPreview,
  normalizeLines,
  wholeNonNegative,
  type CompactFeedbackLine,
  type FeedbackComparison,
} from "./createSmartTransferPreviewFeedback";

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

export async function reconcileApprovals(companyId: number, since: Date): Promise<number> {
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

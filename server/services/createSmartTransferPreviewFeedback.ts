// Extracted from ./smartTransferFeedback.ts to keep that module under the source-size cap.
import { randomUUID } from "crypto";
import { logger } from "../lib/logger";
import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "../db";
import { aiActionLog } from "@shared/schema";
import { roundNumber } from "./smartTransferPerformance";
import { parseMoneyInput } from "../lib/money";

export const PREVIEW_ACTION = "smart_transfer_preview_v4";

export const IMPORT_ACTION = "smart_transfer_import_v4";

export const APPROVAL_ACTION = "smart_transfer_approval_v4";

export const RESET_ACTION = "smart_transfer_feedback_reset_v4";

export const MATCH_WINDOW_MS = 48 * 60 * 60 * 1000;

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface CompactFeedbackLine {
  stockItemId: number;
  sourceLocationId: number;
  quantity: number;
  forecastDailyRate: number;
  itemScore: number;
}

export interface FeedbackComparison {
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

export function numberValue(value: unknown): number {
  const parsed = parseMoneyInput(String(value ?? "0"))?.toNumber() ?? NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function wholeNonNegative(value: unknown): number {
  const parsed = numberValue(value);
  return parsed > 0 ? Math.floor(parsed) : 0;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeLines(lines: unknown): CompactFeedbackLine[] {
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

export function compareLines(suggested: CompactFeedbackLine[], finalLines: CompactFeedbackLine[]): FeedbackComparison {
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

export function jsonObject(value: unknown): Record<string, unknown> {
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

export async function latestPreview(params: {
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

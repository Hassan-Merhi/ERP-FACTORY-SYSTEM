import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "../db";
import { inventory, salesItems, stockTransferItems, stockTransferVouchers, vouchers } from "@shared/schema";
import {
  buildSmartTransferForecastPreview,
  type SmartTransferForecastPreviewLine,
  type SmartTransferForecastPreviewResult,
} from "./smartTransferForecasting";
import type { SmartTransferPreviewOptions, SmartTransferSourceTotal } from "./smartTransferAllocation";
import { roundNumber } from "./smartTransferPerformance";
import { parseMoneyInput } from "../lib/money";

export interface SmartTransferSourceOptimizationFields {
  sourceForecastDailyRate: number;
  sourceReserveDays: number;
  sourceDynamicReserveQty: number;
  sourcePendingCommitmentQty: number;
  sourceCoverageDaysAfterCommitments: number | null;
  sourceHistoricalRouteCount: number;
  sourceHistoricalRouteQty: number;
  sourceCanCoverWholeItem: boolean;
  sourceSelectionScore: number;
  sourceRank: number;
  sourceSelectionReason: string;
}

export type SmartTransferSourceOptimizedLine = SmartTransferForecastPreviewLine & SmartTransferSourceOptimizationFields;

export interface SmartTransferSourceOptimizedResult extends Omit<SmartTransferForecastPreviewResult, "lines"> {
  sourceOptimizationVersion: 2;
  lines: SmartTransferSourceOptimizedLine[];
}

interface SourceSalesMetrics {
  sales7: number;
  sales30: number;
  sales90: number;
  rate7: number;
  rate30: number;
  rate90: number;
  forecastRate: number;
}

interface SourceCandidate {
  stockItemId: number;
  sourceLocationId: number;
  sourceLocationName: string;
  currentStock: number;
  averageRate: number;
  sales: SourceSalesMetrics;
  reserveDays: number;
  dynamicReserveQty: number;
  pendingCommitmentQty: number;
  availableQty: number;
  coverageDaysAfterCommitments: number | null;
  historicalRouteCount: number;
  historicalRouteQty: number;
  canCoverWholeItem: boolean;
  selectionScore: number;
  rank: number;
  selectionReason: string;
}

function parseQuantity(value: unknown): number {
  const parsed = parseMoneyInput(String(value ?? "0"))?.toNumber() ?? NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function wholeNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isoDaysAgo(asOfDate: string, daysAgo: number): string {
  const date = new Date(`${asOfDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - Math.max(0, daysAgo));
  return date.toISOString().slice(0, 10);
}

function calculateSourceSales(
  rows: Array<{ date: string; quantity: number }>,
  sevenDayStart: string,
  thirtyDayStart: string
): SourceSalesMetrics {
  const sales7 = rows.filter((row) => row.date >= sevenDayStart).reduce((sum, row) => sum + row.quantity, 0);
  const sales30 = rows.filter((row) => row.date >= thirtyDayStart).reduce((sum, row) => sum + row.quantity, 0);
  const sales90 = rows.reduce((sum, row) => sum + row.quantity, 0);
  const rate7 = sales7 / 7;
  const rate30 = sales30 / 30;
  const rate90 = sales90 / 90;

  let weight7 = 0.45;
  let weight30 = 0.35;
  let weight90 = 0.2;
  if (sales7 < 3) {
    weight7 = 0.25;
    weight30 = 0.45;
    weight90 = 0.3;
  }
  if (sales30 < 5) {
    weight7 = 0.15;
    weight30 = 0.35;
    weight90 = 0.5;
  }

  let forecastRate = rate7 * weight7 + rate30 * weight30 + rate90 * weight90;
  const prior23Rate = Math.max(0, sales30 - sales7) / 23;
  if (prior23Rate > 0.01) {
    const trendRatio = rate7 / prior23Rate;
    if (trendRatio >= 1.25) forecastRate *= 1.08;
    if (trendRatio <= 0.75) forecastRate *= 0.92;
  }

  return {
    sales7: roundNumber(sales7, 3),
    sales30: roundNumber(sales30, 3),
    sales90: roundNumber(sales90, 3),
    rate7: roundNumber(rate7, 3),
    rate30: roundNumber(rate30, 3),
    rate90: roundNumber(rate90, 3),
    forecastRate: roundNumber(Math.max(0, forecastRate), 3),
  };
}

function calculateReserveDays(sales: SourceSalesMetrics, targetCoverageDays: number): number {
  if (sales.forecastRate <= 0.02 && sales.sales90 < 2) return 0;
  if (sales.forecastRate >= 1 || sales.sales7 >= 7) {
    return Math.min(30, Math.max(14, Math.min(targetCoverageDays, 21)));
  }
  if (sales.forecastRate >= 0.25 || sales.sales30 >= 5) {
    return Math.min(21, Math.max(10, Math.ceil(targetCoverageDays * 0.67)));
  }
  return 7;
}

function calculateReserveQty(currentStock: number, sales: SourceSalesMetrics, reserveDays: number): number {
  if (currentStock <= 0 || reserveDays <= 0) return 0;
  const baseReserve = Math.ceil(sales.forecastRate * reserveDays);
  const accelerationBuffer = Math.ceil(Math.max(0, sales.rate7 - sales.rate30) * 7);
  const minimumFloor = sales.sales90 > 0 ? 1 : 0;
  return Math.min(currentStock, Math.max(minimumFloor, baseReserve + accelerationBuffer));
}

function calculateSourceScore(input: {
  currentStock: number;
  availableQty: number;
  pendingCommitmentQty: number;
  forecastRate: number;
  coverageDaysAfterCommitments: number | null;
  historicalRouteCount: number;
  historicalRouteQty: number;
  itemTotal: number;
}): number {
  const availableRatio = input.currentStock > 0 ? input.availableQty / input.currentStock : 0;
  let overstockScore = 0;
  if (availableRatio >= 0.6) overstockScore = 35;
  else if (availableRatio >= 0.4) overstockScore = 28;
  else if (availableRatio >= 0.25) overstockScore = 20;
  else if (availableRatio > 0) overstockScore = 10;

  let localProtectionScore = 0;
  if (input.forecastRate <= 0.02) localProtectionScore = 20;
  else if (input.coverageDaysAfterCommitments === null) localProtectionScore = 18;
  else if (input.coverageDaysAfterCommitments >= 60) localProtectionScore = 20;
  else if (input.coverageDaysAfterCommitments >= 30) localProtectionScore = 15;
  else if (input.coverageDaysAfterCommitments >= 21) localProtectionScore = 10;
  else if (input.coverageDaysAfterCommitments >= 14) localProtectionScore = 5;

  const routeScore = clamp(
    input.historicalRouteCount * 4 + Math.round(Math.log1p(input.historicalRouteQty) * 2),
    0,
    20
  );
  const wholeItemScore =
    input.availableQty >= input.itemTotal ? 15 : input.availableQty >= input.itemTotal * 0.5 ? 8 : 2;
  const pendingRatio = input.currentStock > 0 ? input.pendingCommitmentQty / input.currentStock : 0;
  const commitmentScore = pendingRatio <= 0 ? 10 : pendingRatio <= 0.1 ? 8 : pendingRatio <= 0.25 ? 5 : 1;

  return Math.round(
    clamp(overstockScore + localProtectionScore + routeScore + wholeItemScore + commitmentScore, 0, 100)
  );
}

function buildSourceReason(source: Omit<SourceCandidate, "rank" | "selectionReason">): string {
  const coverageText =
    source.coverageDaysAfterCommitments === null
      ? "no meaningful local sales rate"
      : `${roundNumber(source.coverageDaysAfterCommitments, 1)} local coverage days before reserve`;
  const routeText =
    source.historicalRouteCount > 0
      ? `${source.historicalRouteCount} completed route transfer(s), ${roundNumber(source.historicalRouteQty, 0)} unit(s)`
      : "no recent completed route history";
  return (
    [
      `source score ${source.selectionScore}/100`,
      `stock ${source.currentStock}`,
      `pending commitments ${source.pendingCommitmentQty}`,
      `dynamic reserve ${source.dynamicReserveQty} for ${source.reserveDays} day(s)`,
      `available ${source.availableQty}`,
      coverageText,
      routeText,
      source.canCoverWholeItem ? "can fulfill the whole item quantity" : "used only if a split is required",
    ].join("; ") + "."
  );
}

function allocateWithMinimumSplits(sources: SourceCandidate[], requested: number): Map<number, number> {
  const result = new Map<number, number>();
  const target = wholeNonNegative(requested);
  if (target <= 0) return result;

  const oneSource = sources.find((source) => source.availableQty >= target);
  if (oneSource) {
    result.set(oneSource.sourceLocationId, target);
    return result;
  }

  let remaining = target;
  for (const source of sources) {
    if (remaining <= 0) break;
    const quantity = Math.min(source.availableQty, remaining);
    if (quantity <= 0) continue;
    result.set(source.sourceLocationId, quantity);
    remaining -= quantity;
  }
  return result;
}

export async function buildSmartTransferSourceOptimizedPreview(
  companyId: number,
  sourceLocationIds: number[],
  destinationLocationId: number,
  targetQuantity: number,
  options: SmartTransferPreviewOptions = {}
): Promise<SmartTransferSourceOptimizedResult> {
  const base = await buildSmartTransferForecastPreview(
    companyId,
    sourceLocationIds,
    destinationLocationId,
    targetQuantity,
    options
  );

  if (base.lines.length === 0) {
    return {
      ...base,
      sourceOptimizationVersion: 2,
      lines: [],
      summary: `${base.summary} Phase 2 had no source allocations to optimize.`,
    };
  }

  const asOfDate = options.asOfDate ?? new Date().toISOString().slice(0, 10);
  const sevenDayStart = isoDaysAgo(asOfDate, 6);
  const thirtyDayStart = isoDaysAgo(asOfDate, 29);
  const ninetyDayStart = isoDaysAgo(asOfDate, 89);
  const routeStart = isoDaysAgo(asOfDate, 179);
  const selectedSourceIds = base.sourceLocationIds;
  const stockItemIds = Array.from(new Set(base.lines.map((line) => line.stockItemId)));
  const sourceNameById = new Map(
    base.sourceLocationIds.map((id, index) => [id, base.sourceLocationNames[index] ?? `Location #${id}`])
  );
  const resolvedSourceLocationId = sql<number>`COALESCE(${stockTransferItems.sourceLocationId}, ${stockTransferVouchers.sourceLocationId})`;

  const [sourceInventoryRows, sourceSalesRows, pendingRows, routeRows] = await Promise.all([
    db
      .select({
        stockItemId: inventory.stockItemId,
        locationId: inventory.locationId,
        quantity: inventory.quantity,
        averageRate: inventory.averageRate,
      })
      .from(inventory)
      .where(
        and(
          eq(inventory.companyId, companyId),
          inArray(inventory.stockItemId, stockItemIds),
          inArray(inventory.locationId, selectedSourceIds)
        )
      ),
    db
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
          inArray(vouchers.locationId, selectedSourceIds),
          inArray(salesItems.stockItemId, stockItemIds),
          gte(vouchers.voucherDate, ninetyDayStart),
          lte(vouchers.voucherDate, asOfDate)
        )
      ),
    db
      .select({
        stockItemId: stockTransferItems.stockItemId,
        sourceLocationId: resolvedSourceLocationId,
        quantity: stockTransferItems.quantity,
      })
      .from(stockTransferItems)
      .innerJoin(stockTransferVouchers, eq(stockTransferItems.transferId, stockTransferVouchers.id))
      .innerJoin(vouchers, eq(stockTransferVouchers.voucherId, vouchers.id))
      .where(
        and(
          eq(vouchers.companyId, companyId),
          inArray(vouchers.voucherType, ["Stock Transfer", "StockTransfer"]),
          isNull(vouchers.deletedAt),
          eq(stockTransferVouchers.inventoryApplied, false),
          inArray(stockTransferItems.stockItemId, stockItemIds),
          inArray(resolvedSourceLocationId, selectedSourceIds)
        )
      ),
    db
      .select({
        stockItemId: stockTransferItems.stockItemId,
        sourceLocationId: resolvedSourceLocationId,
        quantity: stockTransferItems.quantity,
        transferId: stockTransferVouchers.id,
      })
      .from(stockTransferItems)
      .innerJoin(stockTransferVouchers, eq(stockTransferItems.transferId, stockTransferVouchers.id))
      .innerJoin(vouchers, eq(stockTransferVouchers.voucherId, vouchers.id))
      .where(
        and(
          eq(vouchers.companyId, companyId),
          inArray(vouchers.voucherType, ["Stock Transfer", "StockTransfer"]),
          eq(vouchers.optional, false),
          isNull(vouchers.deletedAt),
          eq(stockTransferVouchers.inventoryApplied, true),
          eq(stockTransferVouchers.destinationLocationId, destinationLocationId),
          inArray(stockTransferItems.stockItemId, stockItemIds),
          inArray(resolvedSourceLocationId, selectedSourceIds),
          gte(vouchers.voucherDate, routeStart),
          lte(vouchers.voucherDate, asOfDate)
        )
      ),
  ]);

  const salesBySourceItem = new Map<string, Array<{ date: string; quantity: number }>>();
  for (const row of sourceSalesRows) {
    if (!row.locationId) continue;
    const key = `${row.stockItemId}:${row.locationId}`;
    const list = salesBySourceItem.get(key) ?? [];
    list.push({ date: row.voucherDate, quantity: parseQuantity(row.quantity) });
    salesBySourceItem.set(key, list);
  }

  const pendingBySourceItem = new Map<string, number>();
  for (const row of pendingRows) {
    const sourceLocationId = Number(row.sourceLocationId);
    if (!Number.isInteger(sourceLocationId)) continue;
    const key = `${row.stockItemId}:${sourceLocationId}`;
    pendingBySourceItem.set(key, (pendingBySourceItem.get(key) ?? 0) + parseQuantity(row.quantity));
  }

  const routeBySourceItem = new Map<string, { transferIds: Set<number>; quantity: number }>();
  for (const row of routeRows) {
    const sourceLocationId = Number(row.sourceLocationId);
    if (!Number.isInteger(sourceLocationId)) continue;
    const key = `${row.stockItemId}:${sourceLocationId}`;
    const current = routeBySourceItem.get(key) ?? { transferIds: new Set<number>(), quantity: 0 };
    current.transferIds.add(row.transferId);
    current.quantity += parseQuantity(row.quantity);
    routeBySourceItem.set(key, current);
  }

  const itemTotalById = new Map<number, number>();
  const representativeById = new Map<number, SmartTransferForecastPreviewLine>();
  for (const line of base.lines) {
    itemTotalById.set(line.stockItemId, (itemTotalById.get(line.stockItemId) ?? 0) + line.suggestedQuantity);
    if (!representativeById.has(line.stockItemId)) representativeById.set(line.stockItemId, line);
  }

  const sourceCandidatesByItem = new Map<number, SourceCandidate[]>();
  for (const row of sourceInventoryRows) {
    const itemTotal = itemTotalById.get(row.stockItemId) ?? 0;
    if (itemTotal <= 0) continue;
    const sourceLocationId = row.locationId;
    const key = `${row.stockItemId}:${sourceLocationId}`;
    const currentStock = wholeNonNegative(parseQuantity(row.quantity));
    if (currentStock <= 0) continue;
    const sales = calculateSourceSales(salesBySourceItem.get(key) ?? [], sevenDayStart, thirtyDayStart);
    const reserveDays = calculateReserveDays(sales, base.targetCoverageDays);
    const dynamicReserveQty = calculateReserveQty(currentStock, sales, reserveDays);
    const pendingCommitmentQty = wholeNonNegative(pendingBySourceItem.get(key) ?? 0);
    const stockAfterCommitments = Math.max(0, currentStock - pendingCommitmentQty);
    const availableQty = Math.max(0, stockAfterCommitments - dynamicReserveQty);
    if (availableQty <= 0) continue;
    const route = routeBySourceItem.get(key);
    const coverageDaysAfterCommitments = sales.forecastRate > 0 ? stockAfterCommitments / sales.forecastRate : null;
    const canCoverWholeItem = availableQty >= itemTotal;
    const selectionScore = calculateSourceScore({
      currentStock,
      availableQty,
      pendingCommitmentQty,
      forecastRate: sales.forecastRate,
      coverageDaysAfterCommitments,
      historicalRouteCount: route?.transferIds.size ?? 0,
      historicalRouteQty: route?.quantity ?? 0,
      itemTotal,
    });

    const candidateWithoutReason: Omit<SourceCandidate, "rank" | "selectionReason"> = {
      stockItemId: row.stockItemId,
      sourceLocationId,
      sourceLocationName: sourceNameById.get(sourceLocationId) ?? `Location #${sourceLocationId}`,
      currentStock,
      averageRate: roundNumber(parseQuantity(row.averageRate), 2),
      sales,
      reserveDays,
      dynamicReserveQty,
      pendingCommitmentQty,
      availableQty,
      coverageDaysAfterCommitments:
        coverageDaysAfterCommitments === null ? null : roundNumber(coverageDaysAfterCommitments, 1),
      historicalRouteCount: route?.transferIds.size ?? 0,
      historicalRouteQty: roundNumber(route?.quantity ?? 0, 3),
      canCoverWholeItem,
      selectionScore,
    };
    const list = sourceCandidatesByItem.get(row.stockItemId) ?? [];
    list.push({
      ...candidateWithoutReason,
      rank: 0,
      selectionReason: buildSourceReason(candidateWithoutReason),
    });
    sourceCandidatesByItem.set(row.stockItemId, list);
  }

  const lines: SmartTransferSourceOptimizedLine[] = [];
  let avoidedSplits = 0;
  const pendingKeysUsed = new Set<string>();

  for (const [stockItemId, itemTotal] of itemTotalById.entries()) {
    const representative = representativeById.get(stockItemId);
    if (!representative) continue;
    const sources = (sourceCandidatesByItem.get(stockItemId) ?? [])
      .sort(
        (a, b) =>
          b.selectionScore - a.selectionScore ||
          Number(b.canCoverWholeItem) - Number(a.canCoverWholeItem) ||
          b.availableQty - a.availableQty ||
          a.sourceLocationName.localeCompare(b.sourceLocationName)
      )
      .map((source, index) => ({ ...source, rank: index + 1 }));

    if (sources.length === 0) continue;
    const previousSplitCount = base.lines.filter((line) => line.stockItemId === stockItemId).length;
    const allocations = allocateWithMinimumSplits(sources, itemTotal);
    if (previousSplitCount > allocations.size) avoidedSplits += previousSplitCount - allocations.size;

    for (const source of sources) {
      const suggestedQuantity = allocations.get(source.sourceLocationId) ?? 0;
      if (suggestedQuantity <= 0) continue;
      pendingKeysUsed.add(`${stockItemId}:${source.sourceLocationId}`);
      lines.push({
        ...representative,
        sourceLocationId: source.sourceLocationId,
        sourceLocationName: source.sourceLocationName,
        availableAtSource: source.availableQty,
        sourceCurrentStock: source.currentStock,
        sourceReserveQty: source.dynamicReserveQty + source.pendingCommitmentQty,
        sourceAverageRate: source.averageRate,
        suggestedQuantity,
        itemSuggestedTotal: itemTotal,
        reason: `${representative.reason} Phase 2 source choice: ${source.selectionReason}`,
        sourceForecastDailyRate: source.sales.forecastRate,
        sourceReserveDays: source.reserveDays,
        sourceDynamicReserveQty: source.dynamicReserveQty,
        sourcePendingCommitmentQty: source.pendingCommitmentQty,
        sourceCoverageDaysAfterCommitments: source.coverageDaysAfterCommitments,
        sourceHistoricalRouteCount: source.historicalRouteCount,
        sourceHistoricalRouteQty: source.historicalRouteQty,
        sourceCanCoverWholeItem: source.canCoverWholeItem,
        sourceSelectionScore: source.selectionScore,
        sourceRank: source.rank,
        sourceSelectionReason: source.selectionReason,
      });
    }
  }

  lines.sort(
    (a, b) =>
      b.itemScore - a.itemScore ||
      b.sourceSelectionScore - a.sourceSelectionScore ||
      a.stockItemName.localeCompare(b.stockItemName) ||
      a.sourceRank - b.sourceRank
  );

  const achievedQuantity = lines.reduce((sum, line) => sum + line.suggestedQuantity, 0);
  const shortfallQuantity = Math.max(0, base.targetQuantity - achievedQuantity);
  const totalsMap = new Map<number, SmartTransferSourceTotal>();
  for (const line of lines) {
    const current = totalsMap.get(line.sourceLocationId) ?? {
      sourceLocationId: line.sourceLocationId,
      sourceLocationName: line.sourceLocationName,
      suggestedQuantity: 0,
      lineCount: 0,
    };
    current.suggestedQuantity += line.suggestedQuantity;
    current.lineCount += 1;
    totalsMap.set(line.sourceLocationId, current);
  }
  const totalsBySource = Array.from(totalsMap.values()).sort(
    (a, b) => b.suggestedQuantity - a.suggestedQuantity || a.sourceLocationName.localeCompare(b.sourceLocationName)
  );

  const pendingCommitmentTotal = Array.from(pendingKeysUsed).reduce(
    (sum, key) => sum + wholeNonNegative(pendingBySourceItem.get(key) ?? 0),
    0
  );
  const warnings = base.warnings.filter((warning) => !/source stock after reserve was insufficient/i.test(warning));
  if (shortfallQuantity > 0) {
    warnings.push(
      `Phase 2 is short by ${shortfallQuantity} whole unit(s) after dynamic local reserves and unposted transfer commitments were protected.`
    );
  }
  if (pendingCommitmentTotal > 0) {
    warnings.push(
      `${pendingCommitmentTotal} unposted committed unit(s) were deducted from the selected source/item balances before allocation.`
    );
  }
  if (avoidedSplits > 0) {
    warnings.push(
      `Phase 2 removed ${avoidedSplits} unnecessary source split(s) by preferring sources that could fulfill whole item quantities.`
    );
  }

  return {
    ...base,
    sourceOptimizationVersion: 2,
    achievedQuantity,
    shortfallQuantity,
    shortfall: shortfallQuantity > 0,
    lines,
    totalsBySource,
    warnings,
    summary: `Phase 2 optimized ${achievedQuantity} of ${base.targetQuantity} unit(s) using dynamic source reserves, pending commitments, overstock, route history and minimum-split source selection.`,
  };
}

// Extracted from ./stockTransferAnalysis.ts to keep that module under the source-size cap.
import { db } from "../db";
import { and, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import {
  inventory,
  locations,
  salesItems,
  stockItems,
  stockTransferItems,
  stockTransferVouchers,
  vouchers,
} from "@shared/schema";
import { plusMoney, toMoney } from "../lib/money";
import {
  buildOtwSummary,
  loadOtwStockByItem,
  safetyDays,
  type Aggressiveness,
  type StockTransferSuggestionContext,
  type StockTransferSuggestionItem,
} from "./loadOtwStockByItem";

/**
 * Build a fully DB-backed stock-transfer suggestion context between two
 * locations. All quantities/rates come from SQL; nothing here is guessed.
 */
export async function buildStockTransferSuggestionContext(
  companyId: number,
  fromLocationId: number,
  toLocationId: number,
  dateFrom: string,
  dateTo: string,
  options?: { aggressiveness?: Aggressiveness; itemLimit?: number }
): Promise<StockTransferSuggestionContext> {
  if (fromLocationId === toLocationId) {
    throw new Error("Source and destination locations must be different");
  }

  const aggressiveness: Aggressiveness = options?.aggressiveness || "normal";
  const { destDays, sourceProtectionDays } = safetyDays(aggressiveness);

  const [sourceLoc, destLoc] = await Promise.all([
    db
      .select({ id: locations.id, name: locations.name })
      .from(locations)
      .where(and(eq(locations.id, fromLocationId), eq(locations.companyId, companyId)))
      .limit(1),
    db
      .select({ id: locations.id, name: locations.name })
      .from(locations)
      .where(and(eq(locations.id, toLocationId), eq(locations.companyId, companyId)))
      .limit(1),
  ]);
  if (!sourceLoc[0]) throw new Error("Source location not found for this company");
  if (!destLoc[0]) throw new Error("Destination location not found for this company");

  const days = Math.max(
    1,
    Math.round((new Date(dateTo).getTime() - new Date(dateFrom).getTime()) / (1000 * 60 * 60 * 24)) + 1
  );

  // ── Current inventory at both locations ──────────────────────────────
  const invRows = await db
    .select({
      stockItemId: inventory.stockItemId,
      locationId: inventory.locationId,
      quantity: inventory.quantity,
    })
    .from(inventory)
    .where(and(eq(inventory.companyId, companyId), inArray(inventory.locationId, [fromLocationId, toLocationId])));

  // ── Recent sales by item/location (same source pattern used by POS/location sales reports) ──
  const salesRows = await db
    .select({
      stockItemId: salesItems.stockItemId,
      locationId: vouchers.locationId,
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
        inArray(vouchers.locationId, [fromLocationId, toLocationId]),
        gte(vouchers.voucherDate, dateFrom),
        lte(vouchers.voucherDate, dateTo)
      )
    );

  // ── Active stock items for this company (limit to a sane batch) ─────
  const itemLimit = options?.itemLimit ?? 200;
  const items = await db
    .select({ id: stockItems.id, name: stockItems.name, code: stockItems.code })
    .from(stockItems)
    .where(and(eq(stockItems.companyId, companyId), eq(stockItems.active, true), isNull(stockItems.deletedAt)))
    .limit(itemLimit);

  // ── Old transfers between these two exact locations (either direction) ──
  const oldTransferRows = await db
    .select({
      stockItemId: stockTransferItems.stockItemId,
      quantity: stockTransferItems.quantity,
      voucherDate: vouchers.voucherDate,
      sourceLocationId: stockTransferVouchers.sourceLocationId,
      destinationLocationId: stockTransferVouchers.destinationLocationId,
    })
    .from(stockTransferItems)
    .innerJoin(stockTransferVouchers, eq(stockTransferItems.transferId, stockTransferVouchers.id))
    .innerJoin(vouchers, eq(stockTransferVouchers.voucherId, vouchers.id))
    .where(
      and(
        eq(vouchers.companyId, companyId),
        isNull(vouchers.deletedAt),
        eq(stockTransferVouchers.sourceLocationId, fromLocationId),
        eq(stockTransferVouchers.destinationLocationId, toLocationId)
      )
    )
    .orderBy(desc(vouchers.voucherDate));

  // ── Build lookup maps ─────────────────────────────────────────────────
  const invMap = new Map<string, number>();
  for (const r of invRows) {
    invMap.set(`${r.locationId}:${r.stockItemId}`, toMoney(r.quantity).toNumber());
  }
  const salesMap = new Map<string, number>();
  for (const r of salesRows) {
    if (!r.locationId) continue;
    const key = `${r.locationId}:${r.stockItemId}`;
    salesMap.set(key, plusMoney(salesMap.get(key) || 0, r.quantity));
  }
  const oldTransferByItem = new Map<number, { qty: number; count: number; lastDate: string | null }>();
  for (const r of oldTransferRows) {
    const cur = oldTransferByItem.get(r.stockItemId) || { qty: 0, count: 0, lastDate: null };
    cur.qty = plusMoney(cur.qty, r.quantity);
    cur.count += 1;
    if (!cur.lastDate || r.voucherDate > cur.lastDate) cur.lastDate = r.voucherDate;
    oldTransferByItem.set(r.stockItemId, cur);
  }

  // ── Stock OTW (on-the-way) — same data source as client/src/pages/StockOTW.tsx ──
  const { otwQtyByItem, otwDetailsByItem } = await loadOtwStockByItem(companyId, toLocationId);
  const otwAvailable = otwDetailsByItem.size > 0;
  const otwSkippedReason = otwAvailable
    ? "Included Stock OTW from Inventory."
    : "No OTW found for these suggested items.";

  const suggestions: StockTransferSuggestionItem[] = [];

  for (const item of items) {
    const sourceQty = invMap.get(`${fromLocationId}:${item.id}`) || 0;
    const destQty = invMap.get(`${toLocationId}:${item.id}`) || 0;
    const sourceSalesQty = salesMap.get(`${fromLocationId}:${item.id}`) || 0;
    const destSalesQty = salesMap.get(`${toLocationId}:${item.id}`) || 0;

    const sourceRate = sourceSalesQty / days;
    const destRate = destSalesQty / days;

    if (sourceQty <= 0) continue;

    const sourceSafetyStock = Math.max(sourceRate * sourceProtectionDays, sourceSalesQty > 0 ? 1 : 0);
    const sourceSurplus = sourceQty - sourceSafetyStock;
    if (sourceSurplus <= 0) continue;

    const destTargetStock = destRate * destDays;
    const otwQty: number = otwQtyByItem.get(item.id) || 0;
    const otwDetails = otwDetailsByItem.get(item.id);
    const destNeed = destTargetStock - (destQty + otwQty);

    const destDemandHigher = destRate > sourceRate;
    const destStockoutRisk = destRate > 0 && destQty / Math.max(destRate, 0.0001) < destDays;

    if (!destDemandHigher && !destStockoutRisk) continue;
    // OTW already fully/partially covers the destination's projected need —
    // skip the item entirely if it's already covered, or reduce the suggested
    // qty below (destNeed already has otwQty subtracted out above).
    if (destNeed <= 0) continue;

    let suggestedQty = Math.floor(Math.min(sourceSurplus, destNeed));
    if (suggestedQty <= 0) continue;
    if (suggestedQty > sourceQty) suggestedQty = Math.floor(sourceQty);
    if (suggestedQty <= 0) continue;

    const oldTransfer = oldTransferByItem.get(item.id);
    let confidence = 0.55;
    let oldTransferSummary = "No previous transfers found between these locations for this item.";
    if (oldTransfer) {
      oldTransferSummary = `Transferred ${oldTransfer.count} time(s) before, ${oldTransfer.qty.toFixed(0)} total units, last on ${oldTransfer.lastDate}.`;
      if (destSalesQty > 0) {
        confidence += 0.2;
        oldTransferSummary += " Destination sold this item well after previous transfers.";
      } else {
        confidence -= 0.15;
        oldTransferSummary += " Destination sales stayed low after previous transfers.";
      }
    }
    confidence = Math.max(0.1, Math.min(0.95, confidence));

    // ── OTW-aware conservatism: if OTW covering this destination has a very
    // near ETA (<= 7 days out), trust it more and shave a bit more off the
    // suggested qty rather than over-transferring right before it lands.
    let etaSoon = false;
    if (otwQty > 0 && otwDetails) {
      const relevantEtas = otwDetails
        .filter((d) => d.matchType !== "other" && d.eta)
        .map((d) => new Date(d.eta as string).getTime())
        .filter((t) => !Number.isNaN(t));
      if (relevantEtas.length > 0) {
        const soonestEta = Math.min(...relevantEtas);
        const daysToEta = (soonestEta - Date.now()) / (1000 * 60 * 60 * 24);
        etaSoon = daysToEta >= 0 && daysToEta <= 7;
      }
    }
    if (etaSoon) {
      suggestedQty = Math.floor(suggestedQty * 0.8);
      if (suggestedQty <= 0) continue;
    }

    const otwSummary = buildOtwSummary(otwDetails, destLoc[0].name);

    const reasonParts: string[] = [];
    if (destDemandHigher) {
      reasonParts.push(
        `${item.name} sells faster in ${destLoc[0].name} (${destRate.toFixed(2)}/day) than in ${sourceLoc[0].name} (${sourceRate.toFixed(2)}/day)`
      );
    }
    if (destStockoutRisk) {
      reasonParts.push(`${destLoc[0].name} stock (${destQty}) covers less than ${destDays} days of sales`);
    }
    reasonParts.push(`${sourceLoc[0].name} has surplus of ${sourceSurplus.toFixed(0)} above its safety stock`);
    if (oldTransfer) reasonParts.push(oldTransferSummary);
    if (otwSummary) {
      reasonParts.push(otwSummary);
      if (etaSoon) reasonParts.push("OTW arriving soon, reduced suggested qty accordingly");
    }

    suggestions.push({
      stockItemId: item.id,
      stockItemName: item.name,
      stockItemCode: item.code,
      sourceQty,
      destinationQty: destQty,
      sourceSalesQty,
      destinationSalesQty: destSalesQty,
      sourceSalesRate: Math.round(sourceRate * 100) / 100,
      destinationSalesRate: Math.round(destRate * 100) / 100,
      otwQty,
      otwDetails,
      otwSummary,
      suggestedQty,
      reason: reasonParts.join("; "),
      confidence: Math.round(confidence * 100) / 100,
      previousTransferQty: oldTransfer?.qty || 0,
      previousTransferCount: oldTransfer?.count || 0,
      lastTransferDate: oldTransfer?.lastDate || null,
      oldTransferSummary,
    });
  }

  suggestions.sort((a, b) => b.confidence - a.confidence || b.suggestedQty - a.suggestedQty);

  const oldTransferTotalCount = oldTransferRows.length;
  const oldTransferSummaryOverall =
    oldTransferTotalCount > 0
      ? `${oldTransferTotalCount} previous transfer line(s) found from ${sourceLoc[0].name} to ${destLoc[0].name}.`
      : `No previous transfers found from ${sourceLoc[0].name} to ${destLoc[0].name}.`;

  const analysisSummary =
    suggestions.length > 0
      ? `Analyzed ${items.length} active item(s) over ${dateFrom} to ${dateTo} (${days} day(s), ${aggressiveness} mode). Found ${suggestions.length} item(s) worth transferring from ${sourceLoc[0].name} to ${destLoc[0].name}. ${oldTransferSummaryOverall} ${otwSkippedReason}`
      : `Analyzed ${items.length} active item(s) over ${dateFrom} to ${dateTo} (${days} day(s), ${aggressiveness} mode). No items currently qualify for transfer from ${sourceLoc[0].name} to ${destLoc[0].name} (no surplus, or destination demand does not justify a move, or Stock OTW already covers the need). ${oldTransferSummaryOverall} ${otwSkippedReason}`;

  return {
    sourceLocationId: fromLocationId,
    sourceLocationName: sourceLoc[0].name,
    destinationLocationId: toLocationId,
    destinationLocationName: destLoc[0].name,
    dateFrom,
    dateTo,
    days,
    aggressiveness,
    items: suggestions,
    analysisSummary,
    otwAvailable,
    otwSkippedReason,
    oldTransferSummary: oldTransferSummaryOverall,
  };
}

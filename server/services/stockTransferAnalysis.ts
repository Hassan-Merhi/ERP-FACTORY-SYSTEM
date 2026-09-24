/**
 * server/services/stockTransferAnalysis.ts
 *
 * Deterministic, DB-driven stock-transfer suggestion analysis used by the AI
 * chat assistant. This module never lets an LLM invent quantities — every
 * number returned here comes directly from SQL queries against the same
 * tables the rest of the app already uses (inventory, salesItems/vouchers,
 * stockTransferVouchers/Items). The LLM's only job is to pick which two
 * locations and which time window to analyze; this function does the math.
 *
 * IMPORTANT: this module is READ-ONLY. It never writes to the database and
 * never moves inventory. Creating an actual (optional) stock transfer still
 * goes through the existing /api/stock-transfers endpoint.
 */
import { db } from "../db";
import { normalizeSearchText } from "@shared/searchNormalization";
import { and, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import {
  locations,
  stockItems,
  stockGroups,
  inventory,
  salesItems,
  vouchers,
  stockTransferVouchers,
  stockTransferItems,
  containers,
  purchaseOrders,
  poLineItems,
  suppliers,
} from "@shared/schema";

export type Aggressiveness = "conservative" | "normal" | "aggressive";

export interface LocationCandidate {
  id: number;
  name: string;
  code: string;
}

export interface LocationMatchResult {
  matched: { id: number; name: string; code: string } | null;
  candidates: LocationCandidate[];
}

export interface OtwContainerDetail {
  containerNumber: string;
  quantity: number;
  eta: string | null;
  trackingStatus: string | null;
  currentLocation: string | null;
  shopName: string | null;
  supplierName: string | null;
  importDate: string | null;
  /** How this container's shop name relates to the destination location being analyzed. */
  matchType: "direct" | "unknown" | "other";
}

export interface OtwStockResult {
  /** OTW quantity per stockItemId that counts toward this destination's need (direct + unknown-shop). */
  otwQtyByItem: Map<number, number>;
  /** All OTW container details per stockItemId, including other-shop containers (for display/reason text). */
  otwDetailsByItem: Map<number, OtwContainerDetail[]>;
}

export interface StockTransferSuggestionItem {
  stockItemId: number;
  stockItemName: string;
  stockItemCode: string;
  sourceQty: number;
  destinationQty: number;
  sourceSalesQty: number;
  destinationSalesQty: number;
  sourceSalesRate: number; // units/day
  destinationSalesRate: number; // units/day
  otwQty: number | null;
  otwDetails?: OtwContainerDetail[];
  otwSummary?: string;
  suggestedQty: number;
  reason: string;
  confidence: number; // 0-1
  previousTransferQty: number;
  previousTransferCount: number;
  lastTransferDate: string | null;
  oldTransferSummary: string;
}

export interface StockTransferSuggestionContext {
  sourceLocationId: number;
  sourceLocationName: string;
  destinationLocationId: number;
  destinationLocationName: string;
  dateFrom: string;
  dateTo: string;
  days: number;
  aggressiveness: Aggressiveness;
  items: StockTransferSuggestionItem[];
  analysisSummary: string;
  otwAvailable: boolean;
  otwSkippedReason: string | null;
  oldTransferSummary: string;
}

/**
 * Fuzzy-match a user-provided location name/code against the company's
 * `locations` table. Never silently picks between multiple plausible
 * matches — callers must check `candidates.length > 1` and ask the user.
 */
export async function matchLocationByName(
  companyId: number,
  rawName: string,
  opts?: { strict?: boolean }
): Promise<LocationMatchResult> {
  const needle = normalizeSearchText(rawName);
  if (!needle) return { matched: null, candidates: [] };

  const rows = await db
    .select({ id: locations.id, name: locations.name, code: locations.code })
    .from(locations)
    .where(and(eq(locations.companyId, companyId), isNull(locations.deletedAt)));

  const exact = rows.filter(
    (r) => normalizeSearchText(r.name) === needle || normalizeSearchText(r.code) === needle
  );
  if (exact.length === 1) return { matched: exact[0], candidates: [] };
  if (exact.length > 1) return { matched: null, candidates: exact };

  // In strict mode (used for destination matching), never silently auto-pick via
  // substring matching — "Kolwezi" must never silently resolve to "Kolwezi 2".
  // Any lookalikes are surfaced as candidates so the caller can ask the user.
  if (opts?.strict) {
    const lookalikes = rows.filter((r) => {
      const name = normalizeSearchText(r.name);
      const code = normalizeSearchText(r.code);
      return name.includes(needle) || needle.includes(name) || code.includes(needle) || needle.includes(code);
    });
    return { matched: null, candidates: lookalikes };
  }

  const partial = rows.filter((r) => {
    const name = normalizeSearchText(r.name);
    const code = normalizeSearchText(r.code);
    return name.includes(needle) || needle.includes(name) || code.includes(needle) || needle.includes(code);
  });
  if (partial.length === 1) return { matched: partial[0], candidates: [] };
  if (partial.length > 1) return { matched: null, candidates: partial };

  return { matched: null, candidates: [] };
}

/** Normalize a free-text shop/location name for safe equality comparisons only
 *  (never substring/fuzzy — "Kolwezi" and "Kolwezi 2" must never be conflated). */
function normalizeShopName(name: string | null | undefined): string {
  return (name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Load real "on the way" (OTW) stock quantities/details for a company, reusing
 * the exact same data flow as `client/src/pages/StockOTW.tsx` and
 * `/api/containers` / `/api/containers/:id`: containers with status "OTW",
 * their POs, and each PO's line items.
 *
 * This is READ-ONLY and never calls external tracking providers — ETA/status/
 * location are read from already-saved columns on `containers` (populated by
 * `containerTrackingService.ts` on its own schedule), so this never spams
 * tracking APIs and never blocks on a slow/failing external lookup.
 *
 * When `destinationLocationId` is provided, each container's `shopName` is
 * compared (exact, normalized match only) against that location's name/code to
 * decide whether the OTW quantity should count toward that specific
 * destination's need (`matchType: "direct"`), is ambiguous because the shop
 * name is missing (`matchType: "unknown"`, still counted but always disclosed
 * as "shop unknown"), or clearly belongs to a different shop and must NOT
 * reduce this destination's need (`matchType: "other"`).
 */
export async function loadOtwStockByItem(companyId: number, destinationLocationId?: number): Promise<OtwStockResult> {
  const otwQtyByItem = new Map<number, number>();
  const otwDetailsByItem = new Map<number, OtwContainerDetail[]>();

  const otwContainers = await db
    .select({
      id: containers.id,
      containerNumber: containers.containerNumber,
      supplierId: containers.supplierId,
      importDate: containers.importDate,
      shopName: containers.shopName,
      eta: containers.eta,
      trackingLastStatus: containers.trackingLastStatus,
      trackingLastLocation: containers.trackingLastLocation,
      trackingLocation: containers.trackingLocation,
    })
    .from(containers)
    .where(and(eq(containers.companyId, companyId), eq(containers.status, "OTW")));

  if (otwContainers.length === 0) {
    return { otwQtyByItem, otwDetailsByItem };
  }

  let destLocationNeedles: string[] = [];
  if (destinationLocationId) {
    const [destLoc] = await db
      .select({ name: locations.name, code: locations.code })
      .from(locations)
      .where(and(eq(locations.id, destinationLocationId), eq(locations.companyId, companyId)))
      .limit(1);
    if (destLoc) {
      destLocationNeedles = [normalizeShopName(destLoc.name), normalizeShopName(destLoc.code)].filter(Boolean);
    }
  }

  const [supplierRows, allPos] = await Promise.all([
    db
      .select({ id: suppliers.id, legalName: suppliers.legalName })
      .from(suppliers)
      .where(
        inArray(
          suppliers.id,
          otwContainers.map((c) => c.supplierId)
        )
      ),
    db
      .select({ id: purchaseOrders.id, containerId: purchaseOrders.containerId })
      .from(purchaseOrders)
      .where(
        inArray(
          purchaseOrders.containerId,
          otwContainers.map((c) => c.id)
        )
      ),
  ]);
  const supplierNameById = new Map(supplierRows.map((s) => [s.id, s.legalName]));
  const posByContainer = new Map<number, number[]>();
  for (const po of allPos) {
    const arr = posByContainer.get(po.containerId) || [];
    arr.push(po.id);
    posByContainer.set(po.containerId, arr);
  }

  const allPoIds = allPos.map((p) => p.id);
  const lineItems =
    allPoIds.length === 0
      ? []
      : await db
          .select({
            poId: poLineItems.poId,
            stockItemId: poLineItems.stockItemId,
            stockItemCode: stockItems.code,
            itemName: poLineItems.itemName,
            quantity: poLineItems.quantity,
          })
          .from(poLineItems)
          .leftJoin(stockItems, eq(poLineItems.stockItemId, stockItems.id))
          .where(inArray(poLineItems.poId, allPoIds));

  // Resolve stock item matches the same conservative way the spec requires:
  // prefer stockItemId, else exact code match, else exact normalized name match.
  // Never guess — an unmatched line item is simply excluded from OTW totals.
  const companyStockItems = await db
    .select({ id: stockItems.id, code: stockItems.code, name: stockItems.name })
    .from(stockItems)
    .where(and(eq(stockItems.companyId, companyId), isNull(stockItems.deletedAt)));
  const byCode = new Map(
    companyStockItems
      .map((s) => [(s.code || "").trim().toLowerCase(), s.id] as const)
      .filter(([code]) => code.length > 0)
  );
  const byName = new Map(companyStockItems.map((s) => [normalizeShopName(s.name), s.id]));

  const lineItemsByPo = new Map<number, typeof lineItems>();
  for (const li of lineItems) {
    const arr = lineItemsByPo.get(li.poId) || [];
    arr.push(li);
    lineItemsByPo.set(li.poId, arr);
  }

  for (const c of otwContainers) {
    const poIds = posByContainer.get(c.id) || [];
    const shopNorm = normalizeShopName(c.shopName);
    // Without a destination to compare against, every OTW container counts
    // (there is nothing to exclude it from) — only classify direct/other once
    // an actual destination location was given.
    let matchType: "direct" | "unknown" | "other" = "unknown";
    if (destinationLocationId && shopNorm) {
      matchType = destLocationNeedles.includes(shopNorm) ? "direct" : "other";
    }

    for (const poId of poIds) {
      const items = lineItemsByPo.get(poId) || [];
      for (const li of items) {
        let stockItemId: number | null = li.stockItemId || null;
        if (!stockItemId && li.stockItemCode) {
          stockItemId = byCode.get(li.stockItemCode.trim().toLowerCase()) ?? null;
        }
        if (!stockItemId && li.itemName) {
          stockItemId = byName.get(normalizeShopName(li.itemName)) ?? null;
        }
        if (!stockItemId) continue; // do not guess unsafe matches

        const qty = parseFloat(li.quantity) || 0;
        if (qty <= 0) continue;

        // Only "direct" (matches destination) and "unknown" (shop not recorded,
        // disclosed as such) count toward this destination's OTW need.
        if (matchType !== "other") {
          otwQtyByItem.set(stockItemId, (otwQtyByItem.get(stockItemId) || 0) + qty);
        }

        const detail: OtwContainerDetail = {
          containerNumber: c.containerNumber,
          quantity: qty,
          eta: c.eta || null,
          trackingStatus: c.trackingLastStatus || null,
          currentLocation: c.trackingLastLocation || c.trackingLocation || null,
          shopName: c.shopName || null,
          supplierName: supplierNameById.get(c.supplierId) || null,
          importDate: c.importDate || null,
          matchType,
        };
        const list = otwDetailsByItem.get(stockItemId) || [];
        list.push(detail);
        otwDetailsByItem.set(stockItemId, list);
      }
    }
  }

  return { otwQtyByItem, otwDetailsByItem };
}

/** Build the compact human-readable OTW reason text described in the spec, e.g.
 *  "OTW 12 in container MSKU1234567 for Kolwezi, ETA 2026-07-20" or
 *  "OTW 12 in container MSKU1234567, shop unknown" or
 *  "OTW exists but assigned to another shop, not counted for this destination". */
function buildOtwSummary(details: OtwContainerDetail[] | undefined, destLocationName: string): string | undefined {
  if (!details || details.length === 0) return undefined;

  const counted = details.filter((d) => d.matchType !== "other");
  const other = details.filter((d) => d.matchType === "other");
  const parts: string[] = [];

  if (counted.length === 1) {
    const d = counted[0];
    const etaText = d.eta ? `, ETA ${d.eta}` : "";
    if (d.matchType === "direct") {
      parts.push(`OTW ${d.quantity.toFixed(0)} in container ${d.containerNumber} for ${destLocationName}${etaText}`);
    } else {
      parts.push(`OTW ${d.quantity.toFixed(0)} in container ${d.containerNumber}, shop unknown${etaText}`);
    }
  } else if (counted.length > 1) {
    const total = counted.reduce((s, d) => s + d.quantity, 0);
    const anyUnknown = counted.some((d) => d.matchType === "unknown");
    parts.push(
      `OTW ${total.toFixed(0)} across ${counted.length} containers` + (anyUnknown ? " (some shop unknown)" : "")
    );
  }

  if (other.length > 0) {
    parts.push("OTW exists but assigned to another shop, not counted for this destination");
  }

  return parts.length > 0 ? parts.join("; ") : undefined;
}

function safetyDays(aggressiveness: Aggressiveness): { destDays: number; sourceProtectionDays: number } {
  switch (aggressiveness) {
    case "conservative":
      return { destDays: 14, sourceProtectionDays: 21 };
    case "aggressive":
      return { destDays: 30, sourceProtectionDays: 7 };
    case "normal":
    default:
      return { destDays: 21, sourceProtectionDays: 14 };
  }
}

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

  const _startOfDay = `${dateFrom} 00:00:00`;
  const _endOfDay = `${dateTo} 23:59:59`;
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
    invMap.set(`${r.locationId}:${r.stockItemId}`, parseFloat(r.quantity) || 0);
  }
  const salesMap = new Map<string, number>();
  for (const r of salesRows) {
    if (!r.locationId) continue;
    const key = `${r.locationId}:${r.stockItemId}`;
    salesMap.set(key, (salesMap.get(key) || 0) + (parseFloat(r.quantity) || 0));
  }
  const oldTransferByItem = new Map<number, { qty: number; count: number; lastDate: string | null }>();
  for (const r of oldTransferRows) {
    const cur = oldTransferByItem.get(r.stockItemId) || { qty: 0, count: 0, lastDate: null };
    cur.qty += parseFloat(r.quantity) || 0;
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

// ─────────────────────────────────────────────────────────────────────────
// Multi-source, target-quantity stock transfer draft builder
// ─────────────────────────────────────────────────────────────────────────

export interface TargetQtyDraftItem {
  stockItemId: number;
  stockItemName: string;
  stockItemCode: string;
  quantity: number;
  currentStock: number;
  destinationQty: number;
  stockGroupId: number | null;
  stockGroupName: string | null;
  reason: string;
}

export interface TargetQtySourceDraft {
  sourceLocationId: number;
  sourceLocationName: string;
  destinationLocationId: number;
  destinationLocationName: string;
  items: TargetQtyDraftItem[];
  totalQty: number;
}

export interface TargetQtyResult {
  destinationLocationId: number;
  destinationLocationName: string;
  targetQty: number;
  achievedQty: number;
  shortfall: boolean;
  noEligibleStock: boolean;
  eligibleStockGroupCount: number;
  drafts: TargetQtySourceDraft[];
}

/**
 * Build one or more deterministic, DB-backed stock-transfer drafts that pull
 * whole-unit quantities from MULTIPLE source locations toward a single
 * destination location, up to a target total quantity — e.g. "410 bales to
 * Kolwezi from Hadi 1,2,3,4, only using stock groups Kolwezi already has".
 *
 * Every item/quantity returned here comes directly from SQL (`inventory` +
 * `stockItems`/`stockGroups`); nothing is invented by an LLM. Callers must
 * only relay `stockTransferDraft`/`stockTransferDrafts` back to the user when
 * this function actually returned non-empty items — never claim a draft was
 * prepared otherwise.
 */
export async function buildStockTransferByTargetQuantityContext(
  companyId: number,
  sourceLocationIds: number[],
  destinationLocationId: number,
  targetQty: number,
  options?: { onlyDestinationStockGroups?: boolean }
): Promise<TargetQtyResult> {
  const uniqueSourceIds = Array.from(new Set(sourceLocationIds.filter((id) => id !== destinationLocationId)));
  if (uniqueSourceIds.length === 0) throw new Error("No valid source locations provided");
  const onlyDestinationStockGroups = options?.onlyDestinationStockGroups !== false;

  const allLocationIds = [...uniqueSourceIds, destinationLocationId];
  const locRows = await db
    .select({ id: locations.id, name: locations.name })
    .from(locations)
    .where(and(eq(locations.companyId, companyId), inArray(locations.id, allLocationIds)));
  const locNameById = new Map(locRows.map((l) => [l.id, l.name]));
  const destinationLocationName = locNameById.get(destinationLocationId) || `Location #${destinationLocationId}`;

  // ── Inventory (with stock group) at all involved locations ────────────
  const invRows = await db
    .select({
      stockItemId: inventory.stockItemId,
      locationId: inventory.locationId,
      quantity: inventory.quantity,
      stockItemName: stockItems.name,
      stockItemCode: stockItems.code,
      stockGroupId: stockItems.stockGroupId,
    })
    .from(inventory)
    .innerJoin(stockItems, eq(inventory.stockItemId, stockItems.id))
    .where(
      and(
        eq(inventory.companyId, companyId),
        inArray(inventory.locationId, allLocationIds),
        eq(stockItems.active, true),
        isNull(stockItems.deletedAt)
      )
    );

  const stockGroupIds = Array.from(new Set(invRows.map((r) => r.stockGroupId).filter((id): id is number => !!id)));
  const groupRows = stockGroupIds.length
    ? await db
        .select({ id: stockGroups.id, name: stockGroups.name })
        .from(stockGroups)
        .where(inArray(stockGroups.id, stockGroupIds))
    : [];
  const groupNameById = new Map(groupRows.map((g) => [g.id, g.name]));

  // ── Stock groups already present (qty > 0) at the destination ─────────
  const destGroupIds = new Set<number>();
  const destQtyByItem = new Map<number, number>();
  for (const r of invRows) {
    if (r.locationId !== destinationLocationId) continue;
    const qty = parseFloat(r.quantity) || 0;
    if (qty > 0 && r.stockGroupId) destGroupIds.add(r.stockGroupId);
    destQtyByItem.set(r.stockItemId, (destQtyByItem.get(r.stockItemId) || 0) + qty);
  }

  // ── Per-source eligible items, sorted by lowest destination stock first
  //    (i.e. items the destination needs most get filled first) ─────────
  const drafts: TargetQtySourceDraft[] = [];
  let remaining = Math.max(0, Math.floor(targetQty));
  const achievedTotal = { qty: 0 };

  for (const sourceLocationId of uniqueSourceIds) {
    if (remaining <= 0) break;
    const sourceLocationName = locNameById.get(sourceLocationId) || `Location #${sourceLocationId}`;

    let candidates = invRows.filter((r) => r.locationId === sourceLocationId && (parseFloat(r.quantity) || 0) > 0);
    if (onlyDestinationStockGroups) {
      candidates = candidates.filter((r) => r.stockGroupId && destGroupIds.has(r.stockGroupId));
    }

    // Prioritize items the destination currently holds least of (or doesn't have at all).
    candidates = candidates
      .slice()
      .sort((a, b) => (destQtyByItem.get(a.stockItemId) || 0) - (destQtyByItem.get(b.stockItemId) || 0));

    const items: TargetQtyDraftItem[] = [];
    let sourceTotal = 0;
    for (const c of candidates) {
      if (remaining <= 0) break;
      const available = Math.floor(parseFloat(c.quantity) || 0);
      if (available <= 0) continue;
      const take = Math.min(available, remaining);
      if (take <= 0) continue;
      const groupName = c.stockGroupId ? groupNameById.get(c.stockGroupId) || null : null;
      items.push({
        stockItemId: c.stockItemId,
        stockItemName: c.stockItemName,
        stockItemCode: c.stockItemCode,
        quantity: take,
        currentStock: available,
        destinationQty: destQtyByItem.get(c.stockItemId) || 0,
        stockGroupId: c.stockGroupId,
        stockGroupName: groupName,
        reason: onlyDestinationStockGroups
          ? `Stock group "${groupName || "Unassigned"}" already carried at ${destinationLocationName}; destination currently holds ${destQtyByItem.get(c.stockItemId) || 0}.`
          : `Available at ${sourceLocationName}; destination currently holds ${destQtyByItem.get(c.stockItemId) || 0}.`,
      });
      remaining -= take;
      sourceTotal += take;
    }

    if (items.length > 0) {
      drafts.push({
        sourceLocationId,
        sourceLocationName,
        destinationLocationId,
        destinationLocationName,
        items,
        totalQty: sourceTotal,
      });
      achievedTotal.qty += sourceTotal;
    }
  }

  return {
    destinationLocationId,
    destinationLocationName,
    targetQty: Math.max(0, Math.floor(targetQty)),
    achievedQty: achievedTotal.qty,
    shortfall: achievedTotal.qty < Math.max(0, Math.floor(targetQty)),
    noEligibleStock: achievedTotal.qty === 0,
    eligibleStockGroupCount: destGroupIds.size,
    drafts,
  };
}

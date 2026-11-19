// Extracted from ./stockTransferAnalysis.ts to keep that module under the source-size cap.
import { db } from "../db";
import { normalizeSearchText } from "@shared/searchNormalization";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { containers, locations, poLineItems, purchaseOrders, stockItems, suppliers } from "@shared/schema";
import { toMoney } from "../lib/money";

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

  const exact = rows.filter((r) => normalizeSearchText(r.name) === needle || normalizeSearchText(r.code) === needle);
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

        const qty = toMoney(li.quantity).toNumber();
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
export function buildOtwSummary(
  details: OtwContainerDetail[] | undefined,
  destLocationName: string
): string | undefined {
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

export function safetyDays(aggressiveness: Aggressiveness): { destDays: number; sourceProtectionDays: number } {
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

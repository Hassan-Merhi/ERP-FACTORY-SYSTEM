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
import { and, eq, inArray, isNull } from "drizzle-orm";
import { locations, stockItems, stockGroups, inventory } from "@shared/schema";
import { toMoney } from "../lib/money";
export { loadOtwStockByItem, matchLocationByName } from "./loadOtwStockByItem";
export type {
  Aggressiveness,
  LocationCandidate,
  LocationMatchResult,
  OtwContainerDetail,
  OtwStockResult,
  StockTransferSuggestionContext,
  StockTransferSuggestionItem,
} from "./loadOtwStockByItem";
export { buildStockTransferSuggestionContext } from "./buildStockTransferSuggestionContext";

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
    const qty = toMoney(r.quantity).toNumber();
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

    let candidates = invRows.filter((r) => r.locationId === sourceLocationId && toMoney(r.quantity).toNumber() > 0);
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
      const available = Math.floor(toMoney(c.quantity).toNumber());
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

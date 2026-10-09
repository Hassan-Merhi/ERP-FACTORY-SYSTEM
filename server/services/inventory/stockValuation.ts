/**
 * The one ERP stock valuation reader (2026-10 accounting audit, wave 11).
 *
 * Owner decision: stock value is `inventory.total_value`, everywhere. The
 * stored `average_rate` is display precision and cost memory; it never
 * regenerates value (quantity × average_rate drifts from the stored value by
 * the rounding of every issue).
 *
 * Valuation policy, used by every reader built on this module:
 *   - Scope: every non-deleted location of the company (`locations.company_id`),
 *     active or inactive. Stock at an inactive location is still the company's
 *     asset and is still on the INVENTORY account, so it is counted in the
 *     total and reported separately (`inactiveLocationValue`) rather than
 *     dropped. Stock left at a soft-deleted location is not counted and is
 *     reported in `excluded.deletedLocationValue`.
 *   - Row value: `total_value` of a row with a positive quantity, never below
 *     zero. Negative stock does not subtract from the stock value (`total`).
 *     Under the negative-stock policy (inventoryHelper.ts) a short row holds
 *     the provisional value its shortage was issued at, as a negative
 *     total_value; that is reported as `excluded.shortageValue`. A row that
 *     breaks the policy (value on a zero row, a positive value on a short row,
 *     or a negative value on a row with stock) is not counted and is reported
 *     in `excluded` too, so nothing silently drops.
 *   - `subLedgerTotal` is the signed sum of every in-scope row's total_value
 *     (`total` + shortage + anomalies): what the perpetual INVENTORY account
 *     holds when the ledger moves with every sub-ledger movement. The
 *     perpetual reconciliation and the opening journal use it; reports of the
 *     stock value use `total`.
 *   - ERP bale-mirror stock items (UOM BALE whose code is a factory bale
 *     product's code or article code) are left out, as the perpetual INVENTORY
 *     account leaves them out: the factory values those bales. Their value is
 *     reported in `excluded.baleMirrorValue`. The predicate is the one
 *     `factoryBaleMirrorStockItemIds` uses.
 *
 * The as-of variant replays the movements after the date backwards from the
 * stored `total_value` (calculateHistoricalLocationInventory) and applies the
 * same policy to the replayed rows. Movements that leave no document line are
 * replayed from their dated evidence (inventory_value_movements, wave 15); an
 * evidenced movement that names no stock item (a transfer's settlement
 * residual, a reversal difference, a pre-cut-over container movement) cannot
 * be placed on a row, so it is reversed from `subLedgerTotal` and reported as
 * `excluded.unitemizedMovementValue`.
 *
 * Stock on rows whose location no longer exists (orphaned locations) is in no
 * total; the readiness resolution (inventoryReadinessResolution.ts) lists it
 * and restores or writes it off.
 *
 * All amounts are decimal text at 2dp (server/lib/money.ts arithmetic).
 */
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import type { DatabaseOrTransaction } from "../../db";
import { MoneyDecimal, toMoney } from "../../lib/money";
import {
  calculateHistoricalLocationInventory,
  unitemizedInventoryMovementsAfter,
} from "../../routes/helpers/inventoryHistoryHelpers";
import { factoryBaleMirrorStockItemIds } from "../accounting/perpetualInventory/factoryValuation";

export const STOCK_VALUATION_LOCATION_SCOPE = "ALL_NON_DELETED_LOCATIONS" as const;

export interface LocationStockValue {
  locationId: number;
  locationName: string;
  active: boolean;
  /** Counted value of the location (policy above), 2dp. */
  value: string;
}

export interface StockValuationExclusions {
  /** Value of bale-mirror stock items (valued by the factory, not the ERP). */
  baleMirrorValue: string;
  /** Value left on soft-deleted locations of the company. */
  deletedLocationValue: string;
  /**
   * Provisional value of negative stock (negative): the value short issues
   * relieved at the cost memory, held on short rows until a receipt settles
   * them. Policy, not an anomaly; not counted in `total`.
   */
  shortageValue: string;
  /** Value stored on zero rows, or a positive value on a short row (not counted). */
  shortRowValue: string;
  /** Negative values stored on rows with a positive quantity (not counted). */
  negativeValue: string;
  /** Number of rows behind shortRowValue and negativeValue (shortage rows are not anomalous). */
  anomalousRows: number;
  /**
   * As of a past date only ("0.00" live): the value of evidenced movements
   * after the date that name no stock item, reversed (wave 15). Part of
   * `subLedgerTotal`, not of `total`.
   */
  unitemizedMovementValue: string;
}

export interface CompanyStockValuation {
  companyId: number;
  /** null for the live valuation, else the YYYY-MM-DD date it is as of. */
  asOf: string | null;
  scope: typeof STOCK_VALUATION_LOCATION_SCOPE;
  /** The stock value: active + inactive locations, negative stock not subtracting. */
  total: string;
  /**
   * Signed sub-ledger value (total + shortage + anomalies, deleted locations
   * and the bale mirror left out): what the perpetual INVENTORY account holds.
   */
  subLedgerTotal: string;
  activeLocationValue: string;
  inactiveLocationValue: string;
  /** Non-deleted locations, ordered by id. */
  locations: LocationStockValue[];
  excluded: StockValuationExclusions;
}

type Accumulator = {
  total: Decimal;
  active: Decimal;
  inactive: Decimal;
  mirror: Decimal;
  deleted: Decimal;
  shortage: Decimal;
  shortRow: Decimal;
  negative: Decimal;
  anomalousRows: number;
  unitemized: Decimal;
};

function emptyAccumulator(): Accumulator {
  const zero = new MoneyDecimal(0);
  return {
    total: zero,
    active: zero,
    inactive: zero,
    mirror: zero,
    deleted: zero,
    shortage: zero,
    shortRow: zero,
    negative: zero,
    anomalousRows: 0,
    unitemized: zero,
  };
}

const money = (value: Decimal) => value.toDecimalPlaces(2).toFixed(2);

function finish(
  companyId: number,
  asOf: string | null,
  acc: Accumulator,
  locations: LocationStockValue[]
): CompanyStockValuation {
  return {
    companyId,
    asOf,
    scope: STOCK_VALUATION_LOCATION_SCOPE,
    total: money(acc.total),
    subLedgerTotal: money(acc.total.plus(acc.shortage).plus(acc.shortRow).plus(acc.negative).plus(acc.unitemized)),
    activeLocationValue: money(acc.active),
    inactiveLocationValue: money(acc.inactive),
    locations,
    excluded: {
      baleMirrorValue: money(acc.mirror),
      deletedLocationValue: money(acc.deleted),
      shortageValue: money(acc.shortage),
      shortRowValue: money(acc.shortRow),
      negativeValue: money(acc.negative),
      anomalousRows: acc.anomalousRows,
      unitemizedMovementValue: money(acc.unitemized),
    },
  };
}

/** The counted value of one row under the policy, and how much of it is reported as an anomaly. */
function classifyRow(
  quantity: Decimal,
  totalValue: Decimal
): { counted: Decimal; shortage: Decimal; shortRow: Decimal; negative: Decimal } {
  const zero = new MoneyDecimal(0);
  const none = { counted: zero, shortage: zero, shortRow: zero, negative: zero };
  if (quantity.isNegative() && totalValue.isNegative()) return { ...none, shortage: totalValue };
  if (!quantity.gt(0)) return { ...none, shortRow: totalValue };
  if (totalValue.isNegative()) return { ...none, negative: totalValue };
  return { ...none, counted: totalValue };
}

/**
 * The value one inventory row counts for in a stock-value report (the policy
 * above): its total_value when it holds stock and a non-negative value, else
 * zero. Per-item reports use it so their totals add up to `total`.
 */
export function countedStockRowValue(
  quantity: string | number | null | undefined,
  totalValue: string | number | null | undefined
): Decimal {
  return classifyRow(toMoney(quantity), toMoney(totalValue)).counted;
}

type LiveRow = {
  location_id: number;
  location_name: string;
  active: boolean;
  deleted: boolean;
  mirror: boolean;
  counted: string;
  shortage: string;
  short_row: string;
  negative: string;
  anomalous_rows: number;
};

async function liveRows(
  executor: DatabaseOrTransaction,
  companyId: number,
  locationId: number | null
): Promise<LiveRow[]> {
  // The mirror predicate is factoryBaleMirrorStockItemIds' predicate, per row.
  const result = await executor.execute(sql`
    SELECT l.id AS location_id, l.name AS location_name, l.active, (l.deleted_at IS NOT NULL) AS deleted,
           COALESCE(m.mirror, false) AS mirror,
           COALESCE(SUM(i.total_value) FILTER (WHERE i.quantity > 0 AND i.total_value > 0), 0)::text AS counted,
           COALESCE(SUM(i.total_value) FILTER (WHERE i.quantity < 0 AND i.total_value < 0), 0)::text AS shortage,
           COALESCE(SUM(i.total_value) FILTER (WHERE i.quantity <= 0 AND NOT (i.quantity < 0 AND i.total_value < 0)), 0)::text
             AS short_row,
           COALESCE(SUM(i.total_value) FILTER (WHERE i.quantity > 0 AND i.total_value < 0), 0)::text AS negative,
           (COUNT(i.id) FILTER (WHERE (i.quantity <= 0 AND i.total_value <> 0 AND NOT (i.quantity < 0 AND i.total_value < 0))
                                   OR (i.quantity > 0 AND i.total_value < 0)))::int AS anomalous_rows
      FROM locations l
      LEFT JOIN inventory i ON i.location_id = l.id
      LEFT JOIN LATERAL (
        SELECT EXISTS (
          SELECT 1 FROM stock_items si
           WHERE si.id = i.stock_item_id AND si.company_id = ${companyId}
             AND UPPER(COALESCE(si.uom, '')) = 'BALE'
             AND EXISTS (
               SELECT 1 FROM factory_bale_products p
                WHERE p.company_id = ${companyId} AND si.code IN (p.code, p.article_code)
             )
        ) AS mirror
      ) m ON i.id IS NOT NULL
     WHERE l.company_id = ${companyId} ${locationId === null ? sql`` : sql`AND l.id = ${locationId}`}
     GROUP BY l.id, l.name, l.active, l.deleted_at, COALESCE(m.mirror, false)
     ORDER BY l.id
  `);
  return result.rows as unknown as LiveRow[];
}

function accumulateLive(rows: LiveRow[]): { acc: Accumulator; locations: LocationStockValue[] } {
  const acc = emptyAccumulator();
  const byLocation = new Map<number, { row: LiveRow; value: Decimal }>();
  for (const row of rows) {
    const counted = toMoney(row.counted);
    if (row.deleted) {
      acc.deleted = acc.deleted.plus(counted);
      continue;
    }
    const entry = byLocation.get(row.location_id) ?? { row, value: new MoneyDecimal(0) };
    byLocation.set(row.location_id, entry);
    if (row.mirror) {
      acc.mirror = acc.mirror.plus(counted);
      continue;
    }
    entry.value = entry.value.plus(counted);
    acc.shortage = acc.shortage.plus(toMoney(row.shortage));
    acc.shortRow = acc.shortRow.plus(toMoney(row.short_row));
    acc.negative = acc.negative.plus(toMoney(row.negative));
    acc.anomalousRows += Number(row.anomalous_rows);
  }
  const locations: LocationStockValue[] = [];
  for (const { row, value } of byLocation.values()) {
    acc.total = acc.total.plus(value);
    if (row.active) acc.active = acc.active.plus(value);
    else acc.inactive = acc.inactive.plus(value);
    locations.push({
      locationId: row.location_id,
      locationName: row.location_name,
      active: row.active,
      value: money(value),
    });
  }
  locations.sort((a, b) => a.locationId - b.locationId);
  return { acc, locations };
}

/** The company's ERP stock value now (policy in the module comment). */
export async function companyStockValuation(
  executor: DatabaseOrTransaction,
  companyId: number
): Promise<CompanyStockValuation> {
  const { acc, locations } = accumulateLive(await liveRows(executor, companyId, null));
  return finish(companyId, null, acc, locations);
}

/**
 * One location's ERP stock value now, or null when the location is not the
 * company's or is deleted. Bale-mirror items are left out, as in the company total.
 */
export async function locationStockValuation(
  executor: DatabaseOrTransaction,
  companyId: number,
  locationId: number
): Promise<LocationStockValue | null> {
  const { locations } = accumulateLive(await liveRows(executor, companyId, locationId));
  return locations[0] ?? null;
}

/**
 * The company's ERP stock value at the end of `asOf` (YYYY-MM-DD), replayed
 * backwards from the stored total_value, on the given executor (a
 * transaction gets one consistent snapshot). Locations deleted now are not
 * replayed.
 */
export async function companyStockValuationAsOf(
  executor: DatabaseOrTransaction,
  companyId: number,
  asOf: string
): Promise<CompanyStockValuation> {
  const mirror = await factoryBaleMirrorStockItemIds(executor, companyId);
  const locationRows = (
    await executor.execute(sql`
      SELECT id, name, active, (deleted_at IS NOT NULL) AS deleted
        FROM locations WHERE company_id = ${companyId} ORDER BY id
    `)
  ).rows as unknown as { id: number; name: string; active: boolean; deleted: boolean }[];

  const acc = emptyAccumulator();
  const locations: LocationStockValue[] = [];
  const liveLocationIds = new Set(locationRows.filter((row) => !row.deleted).map((row) => row.id));
  for (const [locationId, value] of await unitemizedInventoryMovementsAfter(executor, companyId, asOf)) {
    // Reversed: the sub-ledger as of the date did not hold what moved after it.
    if (locationId === null || liveLocationIds.has(locationId)) acc.unitemized = acc.unitemized.minus(value);
  }
  for (const location of locationRows) {
    if (location.deleted) continue;
    let value: Decimal = new MoneyDecimal(0);
    for (const item of await calculateHistoricalLocationInventory(location.id, companyId, asOf, executor)) {
      const row = classifyRow(toMoney(item.quantity), toMoney(item.totalValue));
      if (mirror.has(item.stockItemId)) {
        acc.mirror = acc.mirror.plus(row.counted);
        continue;
      }
      value = value.plus(row.counted);
      acc.shortage = acc.shortage.plus(row.shortage);
      if (!row.shortRow.isZero() || !row.negative.isZero()) acc.anomalousRows += 1;
      acc.shortRow = acc.shortRow.plus(row.shortRow);
      acc.negative = acc.negative.plus(row.negative);
    }
    acc.total = acc.total.plus(value);
    if (location.active) acc.active = acc.active.plus(value);
    else acc.inactive = acc.inactive.plus(value);
    locations.push({
      locationId: location.id,
      locationName: location.name,
      active: location.active,
      value: money(value),
    });
  }
  return finish(companyId, asOf, acc, locations);
}

/**
 * The company's stock value (`total`, negative stock not subtracting): live
 * when `asOf` is empty, else at the end of `asOf` (YYYY-MM-DD). The one figure
 * every stock-value report reads (wave 11).
 */
export async function companyStockValue(
  executor: DatabaseOrTransaction,
  companyId: number,
  asOf?: string | null
): Promise<string> {
  const valuation = asOf
    ? await companyStockValuationAsOf(executor, companyId, asOf)
    : await companyStockValuation(executor, companyId);
  return valuation.total;
}

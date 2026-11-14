/**
 * Perpetual-inventory readiness resolution (2026-10 accounting audit, wave 15).
 *
 * Owner decisions 1 and 2 (2026-10-09): before a company's cut-over, the stock
 * the valuation cannot count is resolved through one reviewed, Owner-applied
 * plan, never by a silent repair.
 *
 *   Orphaned-location stock: inventory rows of the company whose location row
 *   no longer exists. stockValuation reads stock through the locations, so this
 *   stock is in no total, no report and not in the opening journal. Per missing
 *   location the Owner chooses:
 *     restore   the location is recreated with the same id, as an inactive
 *               archived location of the company (code ARCHIVED-LOC-{id}, name
 *               "Archived location #{id}"), so the stock is counted again (the
 *               valuation counts inactive locations). Nothing else changes.
 *     writeOff  the location is recreated the same way (so the evidence can
 *               name it) and every row is taken to zero quantity and zero value
 *               through the inventory helper (reverseInventoryByExactValue),
 *               with a canonical stock movement per row that moved quantity.
 *   Anomalous values (the rows stockValuation reports outside its policy):
 *     VALUE_AT_ZERO_QUANTITY        value on a row with no quantity;
 *     POSITIVE_VALUE_ON_SHORT_ROW   a positive value on a short row (negative
 *                                   stock holds its provisional value as a
 *                                   negative value; a positive one is wrong);
 *     NEGATIVE_VALUE_ON_STOCK       a negative value on a row holding stock.
 *   With `writeOffAnomalies` each such value is written off to zero; the
 *   quantity is kept (the count is physical, the value is the anomaly). An
 *   anomalous row on an orphaned location is written off only when that
 *   location is restored (a written-off location is zeroed whole).
 *
 * Ledger side, decided by whether the ledger holds the stock:
 *   - Before the company's cut-over the ledger holds no inventory. Orphaned
 *     stock is in no valuation either, so a restore or a write-off of it posts
 *     nothing and records no value evidence (the opening journal, valued as of
 *     the eve, then sees the restored stock and not the written-off stock).
 *     An anomaly write-off changes the sub-ledger total, so it records its
 *     dated evidence (inventory_value_movements) through
 *     postInventoryMovementJournalTx, which posts no journal before the
 *     cut-over.
 *   - After the cut-over (the cut-over apply refuses while any orphaned stock
 *     or anomaly is left, so orphaned stock then was posted while its location
 *     existed and the ledger holds it): a restore posts nothing (the valuation
 *     comes back to the ledger); a write-off and an anomaly write-off post an
 *     INV-MOVE journal against INVENTORY_ADJUSTMENT for the value removed.
 *
 * A missing location id that other companies' rows also reference is listed
 * and cannot be resolved here (recreating it for one company would leave the
 * other company's rows at a foreign location).
 *
 * The preview is read-only. The apply recomputes the plan in one transaction
 * under an advisory lock and applies it only when its hash equals the reviewed
 * one; it is refused in a closed accounting period (today) and recorded in
 * the audit log with every row before and after, in the same transaction.
 */
import crypto from "node:crypto";
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { db, type DbTransaction } from "../../db";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { isPerpetualInventoryActive } from "../accounting/perpetualInventory/cutover";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";

export type InventoryAnomalyKind = "VALUE_AT_ZERO_QUANTITY" | "POSITIVE_VALUE_ON_SHORT_ROW" | "NEGATIVE_VALUE_ON_STOCK";

export interface ReadinessInventoryRow {
  inventoryId: number;
  locationId: number;
  stockItemId: number;
  stockItemCode: string;
  quantity: string;
  totalValue: string;
  /** Set when the row's value is outside the valuation policy. */
  anomaly: InventoryAnomalyKind | null;
}

export interface OrphanedLocation {
  locationId: number;
  items: number;
  quantity: string;
  value: string;
  /** Other companies' rows reference the same missing id: not resolvable here. */
  sharedWithOtherCompanies: boolean;
  rows: ReadinessInventoryRow[];
}

export interface ReadinessResolutionPlan {
  companyId: number;
  /** The date an apply is recorded at (today). */
  date: string;
  /** Whether the company's cut-over covers today (journals are posted). */
  perpetual: boolean;
  orphanedLocations: OrphanedLocation[];
  /** Anomalous rows on existing, non-deleted locations of the company (bale mirror left out). */
  anomalies: ReadinessInventoryRow[];
  totals: {
    orphanedLocations: number;
    orphanedRows: number;
    orphanedValue: string;
    anomalousRows: number;
    /** Signed sum of the anomalous values on existing locations. */
    anomalousValue: string;
  };
  planHash: string;
}

export type ReadinessAction = { locationId: number; action: "restore" | "writeOff" };

export interface ReadinessResolutionResult {
  plan: ReadinessResolutionPlan;
  restored: number[];
  writtenOff: number[];
  anomaliesWrittenOff: number;
  journals: string[];
}

export class ReadinessResolutionRefusal extends Error {
  constructor(
    readonly code: "PLAN_CHANGED" | "INVALID_ACTIONS" | "NOTHING_TO_APPLY" | "LOCATION_SHARED",
    message: string
  ) {
    super(message);
    this.name = "ReadinessResolutionRefusal";
  }
}

export const READINESS_PLAN_CHANGED_MESSAGE =
  "The inventory readiness plan changed since it was reviewed; review the preview again";
export const READINESS_NOTHING_MESSAGE = "Nothing to apply: choose a location action or the anomaly write-off";
export const READINESS_INVALID_ACTIONS_MESSAGE =
  "Each action must name an orphaned location of the plan once, with the action restore or writeOff";
export const READINESS_LOCATION_SHARED_MESSAGE =
  "Another company's stock also references this missing location; it cannot be resolved for one company";

export const READINESS_ROW_MISSING_MESSAGE = "An inventory row of the plan is missing";

/** The placeholder code and name of a recreated location. */
export const archivedLocationCode = (locationId: number) => `ARCHIVED-LOC-${locationId}`;
export const archivedLocationName = (locationId: number) => `Archived location #${locationId}`;



export async function rows<T>(executor: Pick<DbTransaction, "execute">, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await executor.execute(query)).rows as unknown as T[];
}

function anomalyKind(quantity: Decimal, value: Decimal): InventoryAnomalyKind | null {
  if (value.isZero()) return null;
  if (quantity.isZero()) return "VALUE_AT_ZERO_QUANTITY";
  if (quantity.isNegative() && value.isPositive()) return "POSITIVE_VALUE_ON_SHORT_ROW";
  if (quantity.isPositive() && value.isNegative()) return "NEGATIVE_VALUE_ON_STOCK";
  return null;
}

type RawRow = {
  inventory_id: number;
  location_id: number;
  stock_item_id: number;
  code: string | null;
  quantity: string;
  total_value: string;
};

function toRow(row: RawRow): ReadinessInventoryRow {
  const quantity = toMoney(row.quantity);
  const value = toMoney(row.total_value).toDecimalPlaces(2);
  return {
    inventoryId: Number(row.inventory_id),
    locationId: Number(row.location_id),
    stockItemId: Number(row.stock_item_id),
    stockItemCode: row.code ?? "",
    quantity: quantity.toFixed(3),
    totalValue: value.toFixed(2),
    anomaly: anomalyKind(quantity, value),
  };
}

/** The plan on the given transaction (read-only). */
export async function planReadinessResolutionTx(
  tx: DbTransaction,
  companyId: number
): Promise<ReadinessResolutionPlan> {
  const date = new Date().toISOString().slice(0, 10);
  const orphanRows = await rows<RawRow & { shared: boolean }>(
    tx,
    sql`
      SELECT i.id AS inventory_id, i.location_id, i.stock_item_id, si.code,
             i.quantity::text AS quantity, i.total_value::text AS total_value,
             EXISTS (
               SELECT 1 FROM inventory o WHERE o.location_id = i.location_id AND o.company_id <> i.company_id
             ) AS shared
        FROM inventory i
        LEFT JOIN stock_items si ON si.id = i.stock_item_id
       WHERE i.company_id = ${companyId}
         AND NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = i.location_id)
         AND (i.quantity <> 0 OR i.total_value <> 0)
       ORDER BY i.location_id, i.stock_item_id
    `
  );
  const byLocation = new Map<number, OrphanedLocation>();
  for (const raw of orphanRows) {
    const row = toRow(raw);
    const entry = byLocation.get(row.locationId) ?? {
      locationId: row.locationId,
      items: 0,
      quantity: "0.000",
      value: "0.00",
      sharedWithOtherCompanies: false,
      rows: [],
    };
    entry.items += 1;
    entry.quantity = toMoney(entry.quantity).plus(row.quantity).toFixed(3);
    entry.value = toMoney(entry.value).plus(row.totalValue).toFixed(2);
    entry.sharedWithOtherCompanies = entry.sharedWithOtherCompanies || raw.shared === true;
    entry.rows.push(row);
    byLocation.set(row.locationId, entry);
  }
  const orphanedLocations = [...byLocation.values()];

  // The anomalies stockValuation reports (its predicates): rows on the
  // company's non-deleted locations, bale-mirror items left out.
  const anomalyRows = await rows<RawRow>(
    tx,
    sql`
      SELECT i.id AS inventory_id, i.location_id, i.stock_item_id, si.code,
             i.quantity::text AS quantity, i.total_value::text AS total_value
        FROM locations l
        JOIN inventory i ON i.location_id = l.id
        LEFT JOIN stock_items si ON si.id = i.stock_item_id
       WHERE l.company_id = ${companyId} AND l.deleted_at IS NULL
         AND (
           (i.quantity <= 0 AND i.total_value <> 0 AND NOT (i.quantity < 0 AND i.total_value < 0))
           OR (i.quantity > 0 AND i.total_value < 0)
         )
         AND NOT EXISTS (
           SELECT 1 FROM stock_items m
            WHERE m.id = i.stock_item_id AND m.company_id = ${companyId}
              AND UPPER(COALESCE(m.uom, '')) = 'BALE'
              AND EXISTS (
                SELECT 1 FROM factory_bale_products p
                 WHERE p.company_id = ${companyId} AND m.code IN (p.code, p.article_code)
              )
         )
       ORDER BY i.location_id, i.stock_item_id
    `
  );
  const anomalies = anomalyRows.map(toRow);

  const orphanedValue = orphanedLocations.reduce((sum, entry) => sum.plus(entry.value), new MoneyDecimal(0));
  const anomalousValue = anomalies.reduce((sum, row) => sum.plus(row.totalValue), new MoneyDecimal(0));
  const totals = {
    orphanedLocations: orphanedLocations.length,
    orphanedRows: orphanRows.length,
    orphanedValue: orphanedValue.toFixed(2),
    anomalousRows: anomalies.length,
    anomalousValue: anomalousValue.toFixed(2),
  };
  const planHash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ companyId, orphanedLocations, anomalies }))
    .digest("hex");
  return {
    companyId,
    date,
    perpetual: await isPerpetualInventoryActive(tx, companyId, date),
    orphanedLocations,
    anomalies,
    totals,
    planHash,
  };
}

/** Read-only preview, on one snapshot. */
export function planReadinessResolution(companyId: number): Promise<ReadinessResolutionPlan> {
  return db.transaction(async (tx) => {
    await assertTransactionCompanyScope(tx, companyId);
    return planReadinessResolutionTx(tx, companyId);
  });
}

/** Recreates a missing location as an inactive archived placeholder of the company, with the same id. */

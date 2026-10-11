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

import { auditLog } from "@shared/schema";

import { db, type DbTransaction } from "../../db";
import { reverseInventoryByExactValue } from "../../inventoryHelper";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { isPerpetualInventoryActive } from "../accounting/perpetualInventory/cutover";
import {
  postInventoryMovementJournalTx,
  type InventoryMovementLine,
} from "../accounting/perpetualInventory/inventoryMovementJournal";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { createDatabaseStockMovementAdapter } from "./databaseStockMovementAdapter";
import { postStockMovementTx } from "./stockMovementIntegrityService";

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

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

const todayUtc = () => new Date().toISOString().slice(0, 10);

async function rows<T>(executor: Pick<DbTransaction, "execute">, query: ReturnType<typeof sql>): Promise<T[]> {
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
  const date = todayUtc();
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
async function recreateArchivedLocationTx(tx: DbTransaction, companyId: number, locationId: number): Promise<string> {
  let code = archivedLocationCode(locationId);
  const taken = await rows<{ id: number }>(tx, sql`SELECT id FROM locations WHERE code = ${code}`);
  if (taken.length > 0) code = `${code}-${companyId}`;
  await tx.execute(sql`
    INSERT INTO locations (id, company_id, code, name, active)
    VALUES (${locationId}, ${companyId}, ${code}, ${archivedLocationName(locationId)}, false)
  `);
  // An explicit id can be at or beyond the sequence: move the sequence past it
  // so the next location never collides with the recreated one.
  await tx.execute(sql`
    SELECT setval(pg_get_serial_sequence('locations', 'id'),
                  GREATEST((SELECT MAX(id) FROM locations), 1), true)
  `);
  return code;
}

interface RowOutcome {
  inventoryId: number;
  locationId: number;
  stockItemId: number;
  before: { quantity: string; totalValue: string };
  after: { quantity: string; totalValue: string };
}

/** Takes a row to zero quantity and zero value, with its canonical movement. */
async function zeroRowTx(
  tx: DbTransaction,
  companyId: number,
  row: ReadinessInventoryRow,
  runRef: string,
  actor: { userId: string; username: string }
): Promise<{ outcome: RowOutcome; valueDelta: string; quantityDelta: string }> {
  const quantity = toMoney(row.quantity);
  const value = toMoney(row.totalValue);
  const reversed = await reverseInventoryByExactValue(
    tx,
    row.locationId,
    row.stockItemId,
    quantity.toNumber(),
    value.toFixed(2),
    companyId,
    `inventory-readiness-write-off:${runRef}`
  );
  if (!reversed) throw new Error(READINESS_ROW_MISSING_MESSAGE);
  if (!quantity.isZero()) {
    // The shortage the row carried is written off with it.
    if (quantity.isNegative()) {
      await tx.execute(sql`
        DELETE FROM inventory_negative_layers
         WHERE company_id = ${companyId} AND location_id = ${row.locationId} AND stock_item_id = ${row.stockItemId}
      `);
    }
    const unitCost = value.abs().dividedBy(quantity.abs()).toDecimalPlaces(6);
    await postStockMovementTx(
      tx,
      {
        companyId,
        stockItemId: row.stockItemId,
        kind: "adjustment",
        quantity: quantity.abs().toFixed(3),
        unitCost: unitCost.toString(),
        fromLocationId: quantity.isPositive() ? row.locationId : undefined,
        toLocationId: quantity.isNegative() ? row.locationId : undefined,
        occurredAt: new Date().toISOString(),
        source: {
          sourceType: "inventory_readiness_write_off",
          sourceId: runRef,
          idempotencyKey: `inventory-readiness-write-off:${companyId}:${runRef}:${row.inventoryId}`,
        },
        actor: { username: actor.username, reason: "Perpetual inventory readiness write-off" },
        allowNegativeStock: true,
      },
      canonicalStockMovementAdapter
    );
  }
  return {
    outcome: {
      inventoryId: row.inventoryId,
      locationId: row.locationId,
      stockItemId: row.stockItemId,
      before: { quantity: row.quantity, totalValue: row.totalValue },
      after: {
        quantity: toMoney(reversed.newQuantity).toFixed(3),
        totalValue: toMoney(reversed.newTotalValue).toFixed(2),
      },
    },
    valueDelta: reversed.valueDelta,
    quantityDelta: toMoney(reversed.newQuantity).minus(quantity).toFixed(3),
  };
}

/** Writes an anomalous value off to zero; the quantity is kept. */
async function zeroValueTx(
  tx: DbTransaction,
  companyId: number,
  row: ReadinessInventoryRow,
  runRef: string
): Promise<{ outcome: RowOutcome; valueDelta: string }> {
  const reversed = await reverseInventoryByExactValue(
    tx,
    row.locationId,
    row.stockItemId,
    0,
    row.totalValue,
    companyId,
    `inventory-readiness-anomaly:${runRef}`
  );
  if (!reversed) throw new Error(READINESS_ROW_MISSING_MESSAGE);
  return {
    outcome: {
      inventoryId: row.inventoryId,
      locationId: row.locationId,
      stockItemId: row.stockItemId,
      before: { quantity: row.quantity, totalValue: row.totalValue },
      after: {
        quantity: toMoney(reversed.newQuantity).toFixed(3),
        totalValue: toMoney(reversed.newTotalValue).toFixed(2),
      },
    },
    valueDelta: reversed.valueDelta,
  };
}

/** One side of a row outcome, flat, for the audit row. */
const rowState = (side: "before" | "after") => (row: RowOutcome) => ({
  inventoryId: row.inventoryId,
  locationId: row.locationId,
  stockItemId: row.stockItemId,
  ...row[side],
});

function validateActions(plan: ReadinessResolutionPlan, actions: readonly ReadinessAction[]): void {
  const orphaned = new Map(plan.orphanedLocations.map((entry) => [entry.locationId, entry]));
  const seen = new Set<number>();
  for (const action of actions) {
    const entry = orphaned.get(action.locationId);
    if (!entry || seen.has(action.locationId) || (action.action !== "restore" && action.action !== "writeOff")) {
      throw new ReadinessResolutionRefusal("INVALID_ACTIONS", READINESS_INVALID_ACTIONS_MESSAGE);
    }
    if (entry.sharedWithOtherCompanies) {
      throw new ReadinessResolutionRefusal("LOCATION_SHARED", READINESS_LOCATION_SHARED_MESSAGE);
    }
    seen.add(action.locationId);
  }
}

/**
 * Applies the reviewed plan (see the module comment). Throws
 * ReadinessResolutionRefusal when the plan changed, the actions do not match
 * it, or there is nothing to apply, and the closed-period error when today is
 * in a closed accounting period.
 */
export async function applyReadinessResolution(
  companyId: number,
  params: {
    planHash: string;
    actions: readonly ReadinessAction[];
    writeOffAnomalies: boolean;
    actor: { userId: string; username: string };
  }
): Promise<ReadinessResolutionResult> {
  return db.transaction(async (tx) => {
    await assertTransactionCompanyScope(tx, companyId);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('inventory_readiness_resolution'), ${companyId})`);
    const date = todayUtc();
    // Recorded today: refused in a closed period, journal or not.
    await tx.execute(sql`SELECT erp_assert_accounting_date_open(${companyId}, ${date}::date)`);
    const plan = await planReadinessResolutionTx(tx, companyId);
    if (plan.planHash !== params.planHash) {
      throw new ReadinessResolutionRefusal("PLAN_CHANGED", READINESS_PLAN_CHANGED_MESSAGE);
    }
    validateActions(plan, params.actions);
    const restoreIds = new Set(params.actions.filter((a) => a.action === "restore").map((a) => a.locationId));
    const writeOffIds = new Set(params.actions.filter((a) => a.action === "writeOff").map((a) => a.locationId));
    // Anomalies written off: those on existing locations, and those on the locations restored now.
    const anomalyRows = params.writeOffAnomalies
      ? [
          ...plan.anomalies,
          ...plan.orphanedLocations
            .filter((entry) => restoreIds.has(entry.locationId))
            .flatMap((entry) => entry.rows.filter((row) => row.anomaly !== null)),
        ]
      : [];
    if (params.actions.length === 0 && anomalyRows.length === 0) {
      throw new ReadinessResolutionRefusal("NOTHING_TO_APPLY", READINESS_NOTHING_MESSAGE);
    }

    const runRef = `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
    const recreated: Array<{ locationId: number; code: string; action: string }> = [];
    const rowsWrittenOff: RowOutcome[] = [];
    const writeOffLines: InventoryMovementLine[] = [];
    for (const entry of plan.orphanedLocations) {
      if (!restoreIds.has(entry.locationId) && !writeOffIds.has(entry.locationId)) continue;
      const code = await recreateArchivedLocationTx(tx, companyId, entry.locationId);
      recreated.push({
        locationId: entry.locationId,
        code,
        action: restoreIds.has(entry.locationId) ? "restore" : "writeOff",
      });
      if (!writeOffIds.has(entry.locationId)) continue;
      for (const row of entry.rows) {
        const zeroed = await zeroRowTx(tx, companyId, row, runRef, params.actor);
        rowsWrittenOff.push(zeroed.outcome);
        writeOffLines.push({
          stockItemId: row.stockItemId,
          locationId: row.locationId,
          valueDelta: zeroed.valueDelta,
          quantityDelta: zeroed.quantityDelta,
        });
      }
    }

    const anomaliesWrittenOff: RowOutcome[] = [];
    const anomalyLines: InventoryMovementLine[] = [];
    for (const row of anomalyRows) {
      const zeroed = await zeroValueTx(tx, companyId, row, runRef);
      anomaliesWrittenOff.push(zeroed.outcome);
      anomalyLines.push({
        stockItemId: row.stockItemId,
        locationId: row.locationId,
        valueDelta: zeroed.valueDelta,
        quantityDelta: "0",
      });
    }

    const journals: string[] = [];
    // Orphaned stock is in the ledger only after the cut-over (see the module
    // comment): before it, its write-off is neither journalled nor evidenced.
    if (writeOffLines.length > 0 && plan.perpetual) {
      const posted = await postInventoryMovementJournalTx(tx, {
        companyId,
        sourceType: "readiness-write-off",
        sourceId: runRef,
        date,
        reference: `Orphaned locations ${[...writeOffIds].join(", ")}`,
        lines: writeOffLines,
        offsetAccountCode: "INVENTORY_ADJUSTMENT",
        narration: "Orphaned-location stock written off",
        actor: params.actor,
      });
      if (posted) journals.push(posted.voucherNumber);
    }
    if (anomalyLines.length > 0) {
      const posted = await postInventoryMovementJournalTx(tx, {
        companyId,
        sourceType: "readiness-anomaly",
        sourceId: runRef,
        date,
        reference: `${anomalyLines.length} anomalous stock values`,
        lines: anomalyLines,
        offsetAccountCode: "INVENTORY_ADJUSTMENT",
        narration: "Anomalous stock values written off",
        actor: params.actor,
      });
      if (posted) journals.push(posted.voucherNumber);
    }

    await tx.insert(auditLog).values({
      userId: params.actor.userId,
      username: params.actor.username,
      companyId,
      action: "update",
      tableName: "inventory",
      recordIdentifier: `inventory-readiness-resolution:${runRef}`,
      changes: {
        planHash: { new: plan.planHash },
        perpetual: { new: plan.perpetual },
        locations: {
          old: recreated.map((entry) => ({ locationId: entry.locationId, exists: false })),
          new: recreated.map((entry) => ({
            locationId: entry.locationId,
            code: entry.code,
            name: archivedLocationName(entry.locationId),
            active: false,
            action: entry.action,
          })),
        },
        restoredStock: {
          new: plan.orphanedLocations
            .filter((entry) => restoreIds.has(entry.locationId))
            .map((entry) => ({ locationId: entry.locationId, rows: entry.rows })),
        },
        writtenOffRows: { old: rowsWrittenOff.map(rowState("before")), new: rowsWrittenOff.map(rowState("after")) },
        anomalies: {
          old: anomaliesWrittenOff.map(rowState("before")),
          new: anomaliesWrittenOff.map(rowState("after")),
        },
        journals: { new: journals },
      },
    });

    return {
      plan,
      restored: [...restoreIds],
      writtenOff: [...writeOffIds],
      anomaliesWrittenOff: anomaliesWrittenOff.length,
      journals,
    };
  });
}

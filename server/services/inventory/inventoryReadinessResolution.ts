/** Inventory-readiness reviewed application; preserves one transaction and locks. */
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { auditLog } from "@shared/schema";
import { db, type DbTransaction } from "../../db";
import { reverseInventoryByExactValue } from "../../inventoryHelper";
import { toMoney } from "../../lib/money";
import {
  postInventoryMovementJournalTx,
  type InventoryMovementLine,
} from "../accounting/perpetualInventory/inventoryMovementJournal";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { createDatabaseStockMovementAdapter } from "./databaseStockMovementAdapter";
import { postStockMovementTx } from "./stockMovementIntegrityService";
import {
  rows,
  planReadinessResolutionTx,
  ReadinessResolutionRefusal,
  READINESS_PLAN_CHANGED_MESSAGE,
  READINESS_NOTHING_MESSAGE,
  READINESS_INVALID_ACTIONS_MESSAGE,
  READINESS_LOCATION_SHARED_MESSAGE,
  READINESS_ROW_MISSING_MESSAGE,
  archivedLocationCode,
  archivedLocationName,
  type ReadinessInventoryRow,
  type ReadinessResolutionPlan,
  type ReadinessAction,
  type ReadinessResolutionResult,
} from "./inventoryReadinessPlan";

export * from "./inventoryReadinessPlan";
const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();
const todayUtc = () => new Date().toISOString().slice(0, 10);

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

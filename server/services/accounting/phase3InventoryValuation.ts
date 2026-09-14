import Decimal from "decimal.js";
import type { Pool, PoolClient } from "pg";
import type { db } from "../../db";
import { sql } from "drizzle-orm";
import { resultRows } from "../../lib/queryResult";
import { Phase3AccountingAuditError, type StockAccountingAuditSnapshot } from "./phase3AccountingAudit";

type DrizzleTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type BaselineRow = {
  stock_item_id: number;
  location_id: number;
  quantity: string;
  average_rate: string;
  total_value: string;
};
type MovementRow = {
  id: number;
  stock_item_id: number;
  location_id: number;
  quantity_delta: string;
  unit_cost: string;
};
type CutoverRow = { movement_cutoff_id: string };
type OperationalRow = { operational_value: string };

type ValuationState = {
  quantity: Decimal;
  averageRate: Decimal;
  totalValue: Decimal;
};

const ZERO = new Decimal(0);

function money(value: Decimal): Decimal {
  return new Decimal(value.toFixed(2));
}
function quantity(value: Decimal): Decimal {
  return new Decimal(value.toFixed(3));
}
function rate(value: Decimal): Decimal {
  return new Decimal(value.toFixed(2));
}
function decimal(value: unknown, field: string): Decimal {
  try {
    const parsed = new Decimal(String(value ?? "0"));
    if (!parsed.isFinite()) throw new Error("not finite");
    return parsed;
  } catch {
    throw new Phase3AccountingAuditError("PHASE3_STOCK_VALUATION_INVALID", `${field} is not a finite decimal`);
  }
}
function key(locationId: number, stockItemId: number): string {
  return `${locationId}:${stockItemId}`;
}

/**
 * Apply one canonical stock movement to a valuation state using the same rules
 * as inventoryHelper: positive stock carries value, negative stock carries zero
 * asset value but retains cost memory, and receipts first settle a shortage.
 */
export function applyPhase3InventoryMovement(
  state: ValuationState,
  input: { quantityDelta: Decimal.Value; unitCost: Decimal.Value }
): ValuationState {
  const delta = decimal(input.quantityDelta, "quantityDelta");
  const movementCost = Decimal.max(decimal(input.unitCost, "unitCost"), ZERO);
  const previousQty = quantity(state.quantity);
  const previousValue = money(Decimal.max(state.totalValue, ZERO));
  const previousRate = rate(Decimal.max(state.averageRate, ZERO));
  const newQty = quantity(previousQty.plus(delta));

  if (delta.gt(ZERO)) {
    const remaining = previousQty.isNegative() ? Decimal.max(delta.minus(previousQty.abs()), ZERO) : delta;
    let newValue = money(Decimal.max(previousValue.plus(remaining.times(movementCost)), ZERO));
    let newRate: Decimal;
    if (newQty.gt(ZERO)) {
      newRate = rate(newValue.dividedBy(newQty));
    } else {
      newValue = ZERO;
      newRate = rate(movementCost);
    }
    return { quantity: newQty, averageRate: newRate, totalValue: newValue };
  }

  if (delta.lt(ZERO)) {
    const effectiveRate = previousRate;
    let newValue: Decimal;
    let newRate: Decimal;
    if (newQty.gt(ZERO)) {
      newValue = money(Decimal.max(previousValue.minus(delta.abs().times(effectiveRate)), ZERO));
      newRate = rate(newValue.dividedBy(newQty));
    } else {
      newValue = ZERO;
      newRate = effectiveRate;
    }
    return { quantity: newQty, averageRate: newRate, totalValue: newValue };
  }

  return { quantity: previousQty, averageRate: previousRate, totalValue: previousValue };
}

async function scopeCompany(client: PoolClient, companyId: number): Promise<void> {
  await client.query("SELECT set_config('app.current_company_id', $1, true)", [String(companyId)]);
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`phase3-stock-cutover:${companyId}`]);
}

/**
 * Create the one-time Phase 3 valuation baseline. We lock the inventory and
 * canonical movement tables while taking the cutoff so no concurrent posting
 * can land between the snapshot and its movement boundary.
 */
async function ensureCompanyBaseline(client: PoolClient, companyId: number): Promise<boolean> {
  await scopeCompany(client, companyId);
  const existing = await client.query(`SELECT 1 FROM phase3_inventory_valuation_cutovers WHERE company_id=$1 LIMIT 1`, [
    companyId,
  ]);
  if (existing.rows.length > 0) return false;

  await client.query("LOCK TABLE canonical_stock_movements IN SHARE ROW EXCLUSIVE MODE");
  await client.query("LOCK TABLE inventory IN SHARE ROW EXCLUSIVE MODE");

  const cutoff = await client.query<{ cutoff: string }>(
    `SELECT COALESCE(MAX(id),0)::text AS cutoff FROM canonical_stock_movements WHERE company_id=$1`,
    [companyId]
  );
  const cutoffId = cutoff.rows[0]?.cutoff ?? "0";

  await client.query(
    `INSERT INTO phase3_inventory_valuation_baselines
       (company_id,stock_item_id,location_id,quantity,average_rate,total_value)
     SELECT i.company_id,i.stock_item_id,i.location_id,i.quantity,i.average_rate,i.total_value
       FROM inventory i
       JOIN locations l ON l.id=i.location_id
      WHERE i.company_id=$1 AND l.deleted_at IS NULL
     ON CONFLICT (company_id,stock_item_id,location_id) DO NOTHING`,
    [companyId]
  );
  await client.query(
    `INSERT INTO phase3_inventory_valuation_cutovers (company_id,movement_cutoff_id)
     VALUES ($1,$2::bigint)
     ON CONFLICT (company_id) DO NOTHING`,
    [companyId, cutoffId]
  );
  return true;
}

/** Ensure every company has an immutable stock-valuation cutover. */
export async function ensurePhase3InventoryValuationBaselines(pool: Pool): Promise<number> {
  const companies = await pool.query<{ id: number }>("SELECT id FROM companies ORDER BY id");
  let created = 0;
  for (const company of companies.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      if (await ensureCompanyBaseline(client, Number(company.id))) created += 1;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  return created;
}

/**
 * Independently reconstruct current stock value from the immutable Phase 3
 * baseline plus append-only canonical movements, then compare with live stock.
 */
export async function loadPhase3InventoryValuationSnapshot(input: {
  tx: DrizzleTransaction;
  companyId: number;
}): Promise<StockAccountingAuditSnapshot> {
  const { tx, companyId } = input;
  const cutoverResult = await tx.execute(sql`
    SELECT movement_cutoff_id::text
    FROM phase3_inventory_valuation_cutovers
    WHERE company_id=${companyId}
    LIMIT 1
  `);
  const cutover = resultRows<CutoverRow>(cutoverResult)[0];
  if (!cutover) {
    throw new Phase3AccountingAuditError(
      "PHASE3_STOCK_BASELINE_MISSING",
      `Company ${companyId} has no Phase 3 inventory valuation cutover`
    );
  }
  const cutoffId = Number(cutover.movement_cutoff_id);
  if (!Number.isSafeInteger(cutoffId) || cutoffId < 0) {
    throw new Phase3AccountingAuditError("PHASE3_STOCK_BASELINE_INVALID", `Company ${companyId} cutoff is invalid`);
  }

  const baselineResult = await tx.execute(sql`
    SELECT b.stock_item_id,b.location_id,b.quantity::text,b.average_rate::text,b.total_value::text
    FROM phase3_inventory_valuation_baselines b
    JOIN locations l ON l.id=b.location_id
    WHERE b.company_id=${companyId} AND l.deleted_at IS NULL
    ORDER BY b.location_id,b.stock_item_id
  `);
  const states = new Map<string, ValuationState>();
  for (const row of resultRows<BaselineRow>(baselineResult)) {
    states.set(key(Number(row.location_id), Number(row.stock_item_id)), {
      quantity: quantity(decimal(row.quantity, "baseline.quantity")),
      averageRate: rate(decimal(row.average_rate, "baseline.averageRate")),
      totalValue: money(Decimal.max(decimal(row.total_value, "baseline.totalValue"), ZERO)),
    });
  }

  const movementResult = await tx.execute(sql`
    SELECT csm.id,csm.stock_item_id,csm.location_id,
           csm.quantity_delta::text,csm.unit_cost::text
    FROM canonical_stock_movements csm
    JOIN locations l ON l.id=csm.location_id
    WHERE csm.company_id=${companyId}
      AND csm.id>${cutoffId}
      AND l.deleted_at IS NULL
    ORDER BY csm.id
  `);
  const movementRows = resultRows<MovementRow>(movementResult);
  for (const movement of movementRows) {
    const stateKey = key(Number(movement.location_id), Number(movement.stock_item_id));
    const current = states.get(stateKey) ?? { quantity: ZERO, averageRate: ZERO, totalValue: ZERO };
    states.set(
      stateKey,
      applyPhase3InventoryMovement(current, {
        quantityDelta: movement.quantity_delta,
        unitCost: movement.unit_cost,
      })
    );
  }

  let reconstructed = ZERO;
  for (const state of states.values()) reconstructed = reconstructed.plus(Decimal.max(state.totalValue, ZERO));
  reconstructed = money(reconstructed);

  const operationalResult = await tx.execute(sql`
    SELECT COALESCE(SUM(i.total_value),0)::text AS operational_value
    FROM inventory i
    JOIN locations l ON l.id=i.location_id
    WHERE i.company_id=${companyId} AND l.deleted_at IS NULL
  `);
  const operational = resultRows<OperationalRow>(operationalResult)[0]?.operational_value ?? "0";

  return {
    companyId,
    operationalInventoryValue: operational,
    accountingInventoryValue: reconstructed.toFixed(2),
    accountingInventoryAccountCount: 1,
  };
}

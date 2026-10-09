/**
 * Perpetual-inventory cut-over (2026-10 accounting audit, wave 8).
 *
 * The ledger has carried inventory periodically: purchases expensed, no COGS,
 * stock only in the sub-ledgers. Wave 8 moves each company to perpetual
 * inventory from a cut-over date. The switch is per company and is recorded in
 * `gl_inventory_cutovers` when an Owner applies the opening inventory journal;
 * until then every posting path keeps its current behaviour.
 *
 * Posting paths ask `isPerpetualInventoryActive(executor, companyId, date)`.
 * It is true only for a company with an ACTIVE cut-over and a document dated on
 * or after the cut-over date, so documents of earlier periods are never
 * reposted under the new rules.
 *
 * The switch cannot be turned on while PERPETUAL_INVENTORY_POSTING_READY is
 * false: enabling it with only some posting paths converted would leave books
 * that are half periodic and half perpetual. The final wave-8 phase sets it.
 */
import type { Pool } from "pg";
import { sql } from "drizzle-orm";

import { db, type DbTransaction } from "../../../db";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";

/** Set to true by the last wave-8 phase, once every posting path is converted. */
export const PERPETUAL_INVENTORY_POSTING_READY = false;

/** The cut-over date chosen for wave 8 (first day of the month after the audit). */
export const DEFAULT_PERPETUAL_INVENTORY_FROM = "2026-11-01";

type Executor = typeof db | DbTransaction;

// Same columns and constraint names as glInventoryCutovers in shared/schema, so
// a schema push and this boot DDL agree about the table.
export const INVENTORY_CUTOVER_DDL = `
  CREATE TABLE IF NOT EXISTS gl_inventory_cutovers (
    company_id integer PRIMARY KEY
      CONSTRAINT gl_inventory_cutovers_company_id_companies_id_fk REFERENCES companies(id) ON DELETE RESTRICT,
    effective_from date NOT NULL,
    status text NOT NULL DEFAULT 'ACTIVE',
    opening_voucher_id integer
      CONSTRAINT gl_inventory_cutovers_opening_voucher_id_vouchers_id_fk REFERENCES vouchers(id) ON DELETE RESTRICT,
    opening_plan jsonb NOT NULL,
    applied_by text,
    applied_at timestamp NOT NULL DEFAULT now()
  )`;

/**
 * Dated evidence of the stock sub-ledger movements that leave no document line
 * (wave 15, M1): every postInventoryMovementJournalTx call records its lines
 * here, before and after the cut-over, so the as-of stock valuation can replay
 * quick adjustments, archive/restore, location imports, cost corrections and
 * the other INV-MOVE sources by their movement date. Same columns and index
 * names as inventoryValueMovements in shared/schema. No foreign keys: the
 * table must be creatable on a fresh schema and never blocks a fixture delete.
 */
export const INVENTORY_VALUE_MOVEMENTS_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS inventory_value_movements (
     id bigserial PRIMARY KEY,
     company_id integer NOT NULL,
     source_number text NOT NULL,
     source_type text NOT NULL,
     source_id text NOT NULL,
     movement_date date NOT NULL,
     stock_item_id integer,
     location_id integer,
     quantity_delta numeric(18,3),
     value_delta numeric(20,2) NOT NULL,
     created_at timestamp NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS inventory_value_movements_company_date_idx
     ON inventory_value_movements (company_id, movement_date)`,
  `CREATE INDEX IF NOT EXISTS inventory_value_movements_company_source_idx
     ON inventory_value_movements (company_id, source_number)`,
];

/**
 * Creates the cut-over table and the movement evidence table. Runs on every
 * boot (production skips startup-schema); a failure is logged and reported
 * (false), never fatal.
 */
export async function ensureInventoryCutoverSchema(pool: Pool): Promise<boolean> {
  try {
    await pool.query(INVENTORY_CUTOVER_DDL);
    for (const statement of INVENTORY_VALUE_MOVEMENTS_DDL) await pool.query(statement);
    return true;
  } catch (error) {
    logger.error("[startup] ✗ Inventory cut-over table could not be ensured", { error: getErrorMessage(error) });
    return false;
  }
}

export interface InventoryCutover {
  companyId: number;
  effectiveFrom: string;
  status: "ACTIVE";
  openingVoucherId: number | null;
}

export async function getInventoryCutover(executor: Executor, companyId: number): Promise<InventoryCutover | null> {
  const result = await executor.execute<Record<string, unknown>>(sql`
    SELECT company_id, effective_from::text AS effective_from, status, opening_voucher_id
      FROM gl_inventory_cutovers WHERE company_id = ${companyId}
  `);
  const row = result.rows[0] as
    { company_id: number; effective_from: string; status: "ACTIVE"; opening_voucher_id: number | null } | undefined;
  if (!row) return null;
  return {
    companyId: row.company_id,
    effectiveFrom: row.effective_from,
    status: row.status,
    openingVoucherId: row.opening_voucher_id,
  };
}

/** Whether a document of this company dated `date` (YYYY-MM-DD) posts under perpetual inventory. */
export async function isPerpetualInventoryActive(
  executor: Executor,
  companyId: number,
  date: string
): Promise<boolean> {
  const cutover = await getInventoryCutover(executor, companyId);
  return cutover !== null && cutover.status === "ACTIVE" && date >= cutover.effectiveFrom;
}

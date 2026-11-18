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
 *
 * gl_inventory_cutovers and inventory_value_movements (the dated evidence of
 * stock sub-ledger movements, wave 15 M1) are defined by the schema migrations.
 */
import { sql } from "drizzle-orm";

import { db, type DbTransaction } from "../../../db";

/** Set to true by the last wave-8 phase, once every posting path is converted. */
export const PERPETUAL_INVENTORY_POSTING_READY = false;

/** The cut-over date chosen for wave 8 (first day of the month after the audit). */
export const DEFAULT_PERPETUAL_INVENTORY_FROM = "2026-11-01";

type Executor = typeof db | DbTransaction;

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

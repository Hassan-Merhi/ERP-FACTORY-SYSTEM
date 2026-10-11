/**
 * Opening raw-stock usage recalculation (accounting audit phase 29; the
 * phase 19 C leftover).
 *
 * Opening-balance raw stock (containers with status OPENING_BALANCE) carries
 * no receipt history, so its used kg is derived: per supplier, the kg its mix
 * sources consumed, allocated FIFO over the supplier's opening rows (by
 * offload date, then id), each row capped at its received kg. The allocation
 * is idempotent (every opening row starts from 0).
 *
 * Before: `POST /api/factory/raw-stock/recalc-opening` did this for any
 * signed-in user, in floats, statement by statement with no transaction, no
 * audit and no cut-over check, although used kg is what the factory raw
 * material valuation (and so the ledger, after the cut-over) reads.
 *
 * Now: Admin/Owner; one transaction that takes the company's cut-over lock
 * (the stock import lock, so it runs after any import or cut-over apply) and
 * is refused once the cut-over is applied (409
 * FACTORY_OPENING_RECALC_AFTER_CUTOVER: the opening journal valued those kg,
 * and a rewrite would move factory stock with no posting); Decimal kg at 3
 * places; one audit row with every changed row's used kg before and after,
 * in the same transaction.
 */
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import type { DbTransaction } from "../../db";
import { HttpError } from "../../lib/httpHandlers";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { writeAuditEvent } from "../audit";
import { getInventoryCutover } from "../accounting/perpetualInventory/cutover";
import { lockInventoryCutoverTx } from "./stockImportPolicy";

export const FACTORY_OPENING_RECALC_AFTER_CUTOVER = "FACTORY_OPENING_RECALC_AFTER_CUTOVER" as const;
export const FACTORY_OPENING_RECALC_AFTER_CUTOVER_MESSAGE =
  "Perpetual inventory applies: the opening raw-stock usage can no longer be recalculated, because the opening journal valued it.";

export class FactoryOpeningRecalcAfterCutoverError extends HttpError {
  readonly code = FACTORY_OPENING_RECALC_AFTER_CUTOVER;
  constructor(readonly effectiveFrom: string) {
    super(409, FACTORY_OPENING_RECALC_AFTER_CUTOVER_MESSAGE);
    this.name = "FactoryOpeningRecalcAfterCutoverError";
  }
  get body() {
    return { code: this.code, message: this.message, effectiveFrom: this.effectiveFrom };
  }
}

export interface OpeningRecalcStats {
  suppliersProcessed: number;
  totalAllocatedKg: string;
  unmatchedKg: string;
  changedRows: number;
}

async function rows<T>(tx: DbTransaction, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await tx.execute(query)).rows as unknown as T[];
}

/**
 * Recalculates the opening rows' used kg inside `tx` (see the module comment).
 * `audit` names the actor; omitted only by a caller that audits the whole
 * operation itself (the opening raw-stock import).
 */
export async function recalcOpeningRawStockUsageTx(
  tx: DbTransaction,
  companyId: number,
  options: { actor?: { userId: string; username: string }; checkCutover?: boolean } = {}
): Promise<OpeningRecalcStats> {
  if (options.checkCutover !== false) {
    await lockInventoryCutoverTx(tx, companyId);
    const cutover = await getInventoryCutover(tx, companyId);
    if (cutover && cutover.status === "ACTIVE") throw new FactoryOpeningRecalcAfterCutoverError(cutover.effectiveFrom);
  }
  const opening = await rows<{ id: number; received_kg: string; used_kg: string; supplier_id: number | null }>(
    tx,
    sql`
      SELECT frs.id, frs.received_kg::text AS received_kg, COALESCE(frs.used_kg, 0)::text AS used_kg, fc.supplier_id
        FROM factory_raw_stock frs
        JOIN factory_containers fc ON fc.id = frs.container_id
       WHERE frs.company_id = ${companyId} AND fc.status = 'OPENING_BALANCE'
       ORDER BY frs.offloaded_at, frs.id
       FOR UPDATE OF frs
    `
  );
  const zero = () => new MoneyDecimal(0);
  if (opening.length === 0) {
    return { suppliersProcessed: 0, totalAllocatedKg: "0.000", unmatchedKg: "0.000", changedRows: 0 };
  }
  const consumed = await rows<{ supplier_id: number; kg: string }>(
    tx,
    sql`
      SELECT s.supplier_id, COALESCE(SUM(s.weight_kg), 0)::text AS kg
        FROM factory_mix_batch_sources s
        JOIN factory_mix_batches m ON m.id = s.mix_batch_id AND m.company_id = ${companyId}
       WHERE s.supplier_id IS NOT NULL
       GROUP BY s.supplier_id
    `
  );
  const next = new Map<number, Decimal>(opening.map((row) => [Number(row.id), zero()]));
  const bySupplier = new Map<number, typeof opening>();
  for (const row of opening) {
    if (row.supplier_id == null) continue;
    const list = bySupplier.get(Number(row.supplier_id)) ?? [];
    list.push(row);
    bySupplier.set(Number(row.supplier_id), list);
  }
  let allocated = zero();
  let unmatched = zero();
  for (const supplier of consumed) {
    let remaining = toMoney(supplier.kg);
    for (const row of bySupplier.get(Number(supplier.supplier_id)) ?? []) {
      if (!remaining.gt(0)) break;
      const take = MoneyDecimal.min(remaining, toMoney(row.received_kg)).toDecimalPlaces(3);
      next.set(Number(row.id), take);
      remaining = remaining.minus(take);
      allocated = allocated.plus(take);
    }
    if (remaining.gt("0.001")) unmatched = unmatched.plus(remaining);
  }
  const changed = opening
    .map((row) => ({
      id: Number(row.id),
      old: toMoney(row.used_kg).toFixed(3),
      new: next.get(Number(row.id))!.toFixed(3),
    }))
    .filter((row) => row.old !== row.new);
  for (const row of changed) {
    await tx.execute(
      sql`UPDATE factory_raw_stock SET used_kg = ${row.new} WHERE id = ${row.id} AND company_id = ${companyId}`
    );
  }
  const stats: OpeningRecalcStats = {
    suppliersProcessed: consumed.length,
    totalAllocatedKg: allocated.toFixed(3),
    unmatchedKg: unmatched.toFixed(3),
    changedRows: changed.length,
  };
  if (options.actor && changed.length > 0) {
    await writeAuditEvent(
      {
        userId: options.actor.userId,
        username: options.actor.username,
        companyId,
        action: "update",
        tableName: "factory_raw_stock",
        recordId: companyId,
        recordIdentifier: "opening-raw-stock-usage-recalc",
        changes: {
          usedKg: {
            old: changed.map((row) => ({ id: row.id, usedKg: row.old })),
            new: changed.map((row) => ({ id: row.id, usedKg: row.new })),
          },
          stats: { old: null, new: stats },
        },
      },
      tx
    );
  }
  return stats;
}

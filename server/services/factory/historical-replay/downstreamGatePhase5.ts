/**
 * Phase 5 mandatory safety gate for every historical replay apply.
 *
 * Verified batches with downstream stock must have traceable production output,
 * protected sold / invoiced bales must never be cost-mutated, and a perpetual
 * ledger may not be changed by an unposted cost-only migration.
 *
 * This guards the internal transaction itself, not just the HTTP route. It
 * cannot be bypassed with a previously issued signed scope/confirmation token.
 */
import type { ReplayQueryExecutor, ReplayWriteScope } from "./types";

export interface Phase5ReplaySafety {
  companyId: number;
  safeToApply: boolean;
  missingLineageBatchIds: number[];
  protectedBaleIds: number[];
  excludedFinalizedBaleIds: number[];
  perpetualCutoverActive: boolean;
  blockers: string[];
}

export class Phase5ReplayDownstreamBlockedError extends Error {
  readonly code = "HISTORICAL_REPLAY_DOWNSTREAM_UNRECONCILED";
  readonly status = 409;
  readonly statusCode = 409;
  constructor(message: string) { super(message); this.name = "Phase5ReplayDownstreamBlockedError"; }
}

export function evaluatePhase5ReplaySafety(input: {
  companyId: number;
  missingLineageBatchIds?: number[];
  protectedBaleIds?: number[];
  finalizedBaleIds?: number[];
  perpetualCutoverActive?: boolean;
  proposedValueRows: number;
}): Phase5ReplaySafety {
  const missingLineageBatchIds = [...new Set(input.missingLineageBatchIds ?? [])].sort((a,b) => a-b);
  const protectedBaleIds = [...new Set(input.protectedBaleIds ?? [])].sort((a,b) => a-b);
  const finalizedBaleIds = [...new Set(input.finalizedBaleIds ?? [])].sort((a,b) => a-b);
  const blockers: string[] = [];
  if (missingLineageBatchIds.length) {
    blockers.push(
      `${missingLineageBatchIds.length} consumed mix batch(es) have no directly linked bale output. ` +
      "Pressing or daily usage alone does not prove which bales carry the historical mix cost."
    );
  }
  if (finalizedBaleIds.length || protectedBaleIds.length) {
    blockers.push(
      "The proposed scope contains finalized, sold, dispatched, invoiced, POS-sold or order-posted bales. " +
      "Preserve their recorded cost and COGS until a separately approved accounting correction is available."
    );
  }
  if (input.perpetualCutoverActive && input.proposedValueRows > 0) {
    blockers.push(
      "An active perpetual-inventory cutover exists. Historical cost-only replay has no matching atomic GL revaluation. " +
      "Use the reviewed, journal-posting bale recost workflow or an approved GL migration."
    );
  }
  return {
    companyId: input.companyId,
    safeToApply: blockers.length === 0,
    missingLineageBatchIds,
    protectedBaleIds,
    excludedFinalizedBaleIds: finalizedBaleIds,
    perpetualCutoverActive: !!input.perpetualCutoverActive,
    blockers,
  };
}

export async function inspectPhase5ReplayScopeSafety(
  executor: ReplayQueryExecutor,
  companyId: number,
  scope: ReplayWriteScope,
): Promise<Phase5ReplaySafety> {
  const ids = [...new Set(scope.batchIdsToUpdate)];
  const baleIds = [...new Set(scope.availableBaleIdsToUpdate)];
  const [mixRows, saleRows, cutover] = await Promise.all([
    ids.length ? executor.query<{ id: number }>(
      `SELECT m.id
         FROM factory_mix_batches m
        WHERE m.company_id=$1 AND m.deleted_at IS NULL AND m.id=ANY($2)
          AND m.used_kg>0
          AND NOT EXISTS (
            SELECT 1 FROM factory_bales b WHERE b.company_id=m.company_id
              AND b.mix_batch_id=m.id AND b.deleted_at IS NULL
              AND b.status NOT IN ('DELETED','REMOVED')
          )
        ORDER BY m.id`, [companyId, ids],
    ) : Promise.resolve({ rows: [] as Array<{id:number}> }),
    baleIds.length ? executor.query<{ id: number }>(
      `SELECT b.id
         FROM factory_bales b
        WHERE b.company_id=$1 AND b.id=ANY($2)
          AND (b.deleted_at IS NOT NULL
           OR b.status IN ('SOLD','DISPATCHED','REMOVED','DELETED','REPACKED')
           OR EXISTS (
              SELECT 1 FROM factory_invoice_loading_bales fil
               WHERE fil.company_id=b.company_id AND fil.bale_id=b.id
           )
           OR EXISTS (
              SELECT 1 FROM factory_pos_sale_bales ps
               WHERE ps.company_id=b.company_id AND ps.bale_id=b.id
           )
           OR EXISTS (
              SELECT 1 FROM customer_order_bales cob
                JOIN customer_orders co ON co.id=cob.order_id AND co.company_id=b.company_id
               WHERE cob.bale_id=b.id AND co.deleted_at IS NULL
                 AND (co.status IN ('FINALIZED','DISPATCHED','SOLD','INVOICED','COMPLETED')
                   OR co.invoice_number IS NOT NULL OR co.finalized_at IS NOT NULL
                   OR EXISTS (
                      SELECT 1 FROM factory_invoice_document_snapshots ds
                       WHERE ds.company_id=b.company_id AND ds.order_id=co.id
                   )
                   OR EXISTS (
                      SELECT 1 FROM customer_balances cb
                       WHERE cb.company_id=b.company_id
                         AND cb.reference_type='INVOICE'
                         AND cb.reference_id=co.id
                         AND cb.transaction_type='SALE'
                   ))
           )
          )
        ORDER BY b.id`, [companyId, baleIds],
    ) : Promise.resolve({ rows: [] as Array<{id:number}> }),
    executor.query<{ active: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM gl_inventory_cutovers
          WHERE company_id=$1 AND status='ACTIVE'
            AND effective_from <= CURRENT_DATE
       ) AS active`, [companyId],
    ),
  ]);
  const proposedValueRows =
    scope.containerIdsToUpdate.length + scope.rawStockIdsToUpdate.length +
    scope.sourceIdsToUpdate.length + scope.batchIdsToUpdate.length +
    scope.availableBaleIdsToUpdate.length + scope.supplierIds.length;
  return evaluatePhase5ReplaySafety({
    companyId,
    missingLineageBatchIds: mixRows.rows.map(row => row.id),
    protectedBaleIds: saleRows.rows.map(row => row.id),
    finalizedBaleIds: scope.finalizedBaleIdsToUpdate,
    perpetualCutoverActive: !!cutover.rows[0]?.active,
    proposedValueRows,
  });
}

export async function assertPhase5ReplayScopeSafe(
  executor: ReplayQueryExecutor,
  companyId: number,
  scope: ReplayWriteScope,
): Promise<void> {
  const safety = await inspectPhase5ReplayScopeSafety(executor, companyId, scope);
  if (!safety.safeToApply) {
    throw new Phase5ReplayDownstreamBlockedError(safety.blockers.join(" "));
  }
}

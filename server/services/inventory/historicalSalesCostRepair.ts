import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import type { PoolClient } from "pg";

import { pool } from "../../db";
import { logger } from "../../lib/logger";
import { ensureHistoricalSalesCostRepairSchema } from "./ensureHistoricalSalesCostRepairSchema";
import {
  HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION,
  historicalInventoryKey,
  repairMoney,
  type HistoricalSalesRepairProposal,
} from "./historicalSalesCostRepairEngine";
import {
  RepairCheck,
  blockerForProposal,
  buildRepairBlockerIndex,
  distinctBlockedItemLocations,
  hscrError,
} from "./historicalSalesCostRepairTypes";
import { companyIdsForRun, enableMaintenanceScope } from "./historicalSalesCostRepairLoaders";
import {
  assertSalesItemsUpdateHasNoSideEffectTriggers,
  inventoryEvidenceFingerprint,
  recomputeHistoricalSalesCompanyEvidenceHash,
} from "./historicalSalesCostRepairEvidence";
import { dryRunCompany } from "./historicalSalesCostRepairDryRun";

export { hscrError } from "./historicalSalesCostRepairTypes";
export { enableMaintenanceScope } from "./historicalSalesCostRepairLoaders";
export {
  activeCanonicalSaleEvidence,
  assertSalesItemsUpdateHasNoSideEffectTriggers,
  canonicalMovementNumericId,
  droppedPosLineMovements,
  inventoryEvidenceFingerprint,
  recomputeHistoricalSalesCompanyEvidenceHash,
} from "./historicalSalesCostRepairEvidence";

function proposalHashSource(
  proposal: HistoricalSalesRepairProposal,
  status: string,
  blockerCode?: string | null
): string {
  return [
    proposal.salesItemId,
    proposal.voucherId,
    proposal.companyId,
    proposal.locationId,
    proposal.stockItemId,
    proposal.occurredAt,
    proposal.originalCostPrice,
    proposal.originalTotalCost,
    proposal.originalProfit,
    proposal.proposedCostPrice,
    proposal.proposedTotalCost,
    proposal.proposedProfit,
    status,
    blockerCode ?? "",
  ].join("|");
}

async function persistProposalRows(
  client: PoolClient,
  runId: number,
  proposals: HistoricalSalesRepairProposal[],
  checks: RepairCheck[]
): Promise<void> {
  const blockers = buildRepairBlockerIndex(checks);

  const batchSize = 300;
  for (let offset = 0; offset < proposals.length; offset += batchSize) {
    const batch = proposals.slice(offset, offset + batchSize);
    const values: unknown[] = [];
    const placeholders = batch.map((proposal, index) => {
      const blocked = blockerForProposal(blockers, proposal);
      const status = blocked ? "blocked" : proposal.changed ? "ready" : "unchanged";
      const base = index * 20;
      values.push(
        runId,
        proposal.companyId,
        proposal.locationId,
        proposal.stockItemId,
        proposal.voucherId,
        proposal.salesItemId,
        proposal.occurredAt,
        proposal.evidence,
        proposal.sourceType,
        proposal.sourceId,
        proposal.originalCostPrice,
        proposal.originalTotalCost,
        proposal.originalProfit,
        proposal.proposedCostPrice,
        proposal.proposedTotalCost,
        proposal.proposedProfit,
        proposal.changed,
        status,
        blocked?.code ?? null,
        blocked?.detail ?? null
      );
      const p = Array.from({ length: 20 }, (_, i) => "$" + (base + i + 1));
      return `(${p.join(",")})`;
    });
    await client.query(
      `INSERT INTO historical_sales_cost_repair_rows
       (run_id,company_id,location_id,stock_item_id,voucher_id,sales_item_id,occurred_at,
        evidence,source_type,source_id,original_cost_price,original_total_cost,original_profit,
        proposed_cost_price,proposed_total_cost,proposed_profit,changed,status,blocker_code,
        blocker_detail)
       VALUES ${placeholders.join(",")}
       ON CONFLICT (run_id,sales_item_id) DO NOTHING`,
      values
    );
  }
}

async function persistChecks(client: PoolClient, runId: number, checks: RepairCheck[]): Promise<void> {
  const batchSize = 400;
  for (let offset = 0; offset < checks.length; offset += batchSize) {
    const batch = checks.slice(offset, offset + batchSize);
    const values: unknown[] = [];
    const placeholders = batch.map((check, index) => {
      const base = index * 9;
      values.push(
        runId,
        check.companyId,
        check.locationId,
        check.stockItemId,
        check.code,
        check.status,
        check.expected ?? null,
        check.actual ?? null,
        check.detail ?? null
      );
      return `(${Array.from({ length: 9 }, (_, i) => `$${base + i + 1}`).join(",")})`;
    });
    await client.query(
      `INSERT INTO historical_sales_cost_repair_checks
       (run_id,company_id,location_id,stock_item_id,check_code,status,expected_value,actual_value,detail)
       VALUES ${placeholders.join(",")}`,
      values
    );
  }
}

export type HistoricalSalesCostDryRunResult = {
  runId: number;
  status: "blocked" | "ready";
  auditHash: string;
  sourceCutoff: string;
  totalSalesRows: number;
  changedRows: number;
  blockedRows: number;
  blockedItemLocations: number;
  originalTotalCost: string;
  proposedTotalCost: string;
  originalTotalProfit: string;
  proposedTotalProfit: string;
  companies: Record<string, unknown>[];
};

export async function buildHistoricalSalesCostRepairDryRun(input: {
  createdBy: string;
  companyIds?: number[];
}): Promise<HistoricalSalesCostDryRunResult> {
  await ensureHistoricalSalesCostRepairSchema(pool);
  const client = await pool.connect();
  let runId = 0;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await enableMaintenanceScope(client);
    await client.query("SELECT pg_advisory_xact_lock(hashtext('historical-sales-cost-repair-dry-run'))");

    // A proven-rows-only partial apply rewrites sale costs that this engine
    // reads as historical evidence. Until a dry-run can restore that evidence
    // from the apply log, refuse to build on top of an active partial apply.
    const activePartial = await client.query<{ run_id: number }>(
      `SELECT run_id FROM historical_sales_cost_repair_partial_applies WHERE status='applied' ORDER BY run_id`
    );
    if (activePartial.rows.length > 0) {
      throw hscrError(
        `HSCR_DRY_RUN_REFUSED_ACTIVE_PARTIAL_APPLY:${activePartial.rows.map((row) => row.run_id).join(",")}`
      );
    }

    const cutoffResult = await client.query<{ cutoff: Date }>("SELECT clock_timestamp() AS cutoff");
    const sourceCutoff = cutoffResult.rows[0].cutoff;
    const companyIds = await companyIdsForRun(client, input.companyIds);

    const created = await client.query<{ id: number }>(
      `INSERT INTO historical_sales_cost_repair_runs
       (algorithm_version,status,source_cutoff_at,requested_company_ids,created_by)
       VALUES ($1,'building',$2,$3,$4)
       RETURNING id`,
      [HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION, sourceCutoff, companyIds, input.createdBy]
    );
    runId = Number(created.rows[0].id);

    const companyReports: Record<string, unknown>[] = [];
    const allProposals: HistoricalSalesRepairProposal[] = [];
    const allChecks: RepairCheck[] = [];
    for (const companyId of companyIds) {
      const result = await dryRunCompany(client, companyId, sourceCutoff);
      companyReports.push(result.report);
      allProposals.push(...result.proposals);
      allChecks.push(...result.checks);
    }

    await persistChecks(client, runId, allChecks);
    await persistProposalRows(client, runId, allProposals, allChecks);

    const blockers = buildRepairBlockerIndex(allChecks);
    const blockedRows = allProposals.filter((proposal) => blockerForProposal(blockers, proposal)).length;
    const changedRows = allProposals.filter(
      (proposal) => proposal.changed && !blockerForProposal(blockers, proposal)
    ).length;

    // V34: run totals describe what apply would actually write. A blocked row
    // keeps its original values, so only unblocked proposals contribute their
    // proposed cost/profit. The rejected candidates of blocked rows are still
    // reported separately for diagnostics, but never mixed into the headline
    // totals (run #36 showed 3.2B "proposed" that lived entirely in blocked rows).
    const sumMoney = (
      proposals: HistoricalSalesRepairProposal[],
      field: "originalTotalCost" | "proposedTotalCost" | "originalProfit" | "proposedProfit"
    ) => repairMoney(proposals.reduce((sum, proposal) => sum.plus(proposal[field]), new Decimal(0)));
    const blockedProposals = allProposals.filter((proposal) => blockerForProposal(blockers, proposal));
    const applicableProposals = allProposals.filter((proposal) => !blockerForProposal(blockers, proposal));
    const originalTotalCost = sumMoney(allProposals, "originalTotalCost");
    const proposedTotalCost = repairMoney(
      sumMoney(applicableProposals, "proposedTotalCost").plus(sumMoney(blockedProposals, "originalTotalCost"))
    );
    const originalTotalProfit = sumMoney(allProposals, "originalProfit");
    const proposedTotalProfit = repairMoney(
      sumMoney(applicableProposals, "proposedProfit").plus(sumMoney(blockedProposals, "originalProfit"))
    );

    const hash = createHash("sha256");
    hash.update(HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION);
    hash.update("|");
    hash.update(sourceCutoff.toISOString());
    for (const proposal of [...allProposals].sort((a, b) => a.salesItemId - b.salesItemId)) {
      const blocked = blockerForProposal(blockers, proposal);
      hash.update("\n");
      hash.update(
        proposalHashSource(proposal, blocked ? "blocked" : proposal.changed ? "ready" : "unchanged", blocked?.code)
      );
    }
    for (const check of [...allChecks].sort((a, b) =>
      [a.companyId, a.locationId ?? 0, a.stockItemId ?? 0, a.salesItemId ?? 0, a.code]
        .join(":")
        .localeCompare([b.companyId, b.locationId ?? 0, b.stockItemId ?? 0, b.salesItemId ?? 0, b.code].join(":"))
    )) {
      hash.update("\ncheck|");
      hash.update(JSON.stringify(check));
    }
    const auditHash = hash.digest("hex");
    const status: "blocked" | "ready" = allChecks.some((check) => check.status === "block") ? "blocked" : "ready";

    const report = {
      algorithmVersion: HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION,
      sourceCutoff: sourceCutoff.toISOString(),
      companies: companyReports,
      totals: {
        basis: "apply-effective: unblocked rows at proposed values, blocked rows at original values",
        applicableRows: applicableProposals.length,
        applicableOriginalTotalCost: sumMoney(applicableProposals, "originalTotalCost").toFixed(2),
        applicableProposedTotalCost: sumMoney(applicableProposals, "proposedTotalCost").toFixed(2),
        blockedRows: blockedProposals.length,
        blockedOriginalTotalCost: sumMoney(blockedProposals, "originalTotalCost").toFixed(2),
        blockedRejectedCandidateTotalCost: sumMoney(blockedProposals, "proposedTotalCost").toFixed(2),
      },
      checks: {
        total: allChecks.length,
        pass: allChecks.filter((check) => check.status === "pass").length,
        warning: allChecks.filter((check) => check.status === "warning").length,
        block: allChecks.filter((check) => check.status === "block").length,
      },
    };

    await client.query(
      `UPDATE historical_sales_cost_repair_runs
          SET status=$2,
              completed_at=NOW(),
              audit_hash=$3,
              total_sales_rows=$4,
              changed_rows=$5,
              blocked_rows=$6,
              blocked_item_locations=$7,
              original_total_cost=$8,
              proposed_total_cost=$9,
              original_total_profit=$10,
              proposed_total_profit=$11,
              report=$12::jsonb
        WHERE id=$1`,
      [
        runId,
        status,
        auditHash,
        allProposals.length,
        changedRows,
        blockedRows,
        distinctBlockedItemLocations(allChecks),
        originalTotalCost.toFixed(2),
        proposedTotalCost.toFixed(2),
        originalTotalProfit.toFixed(2),
        proposedTotalProfit.toFixed(2),
        JSON.stringify(report),
      ]
    );

    await client.query("COMMIT");

    logger.info("Historical sales cost repair dry-run complete", {
      module: "historical-sales-cost-repair",
      action: "dry-run",
      runId,
      status,
      auditHash,
      companies: companyIds.length,
      totalSalesRows: allProposals.length,
      changedRows,
      blockedRows,
    });

    return {
      runId,
      status,
      auditHash,
      sourceCutoff: sourceCutoff.toISOString(),
      totalSalesRows: allProposals.length,
      changedRows,
      blockedRows,
      blockedItemLocations: distinctBlockedItemLocations(allChecks),
      originalTotalCost: originalTotalCost.toFixed(2),
      proposedTotalCost: proposedTotalCost.toFixed(2),
      originalTotalProfit: originalTotalProfit.toFixed(2),
      proposedTotalProfit: proposedTotalProfit.toFixed(2),
      companies: companyReports,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (runId) {
      await pool
        .query(
          `UPDATE historical_sales_cost_repair_runs
            SET status='failed',completed_at=NOW(),error=$2
          WHERE id=$1 AND status='building'`,
          [runId, error instanceof Error ? error.message : String(error)]
        )
        .catch(() => undefined);
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Read-only diagnosis of one company/location/item group: runs the company
 * dry-run inside a READ ONLY transaction that is always rolled back, persists
 * nothing, and returns the group's checks (including the full rewind timeline)
 * and proposals.
 */
export async function diagnoseHistoricalSalesCostKey(input: {
  companyId: number;
  locationId: number;
  stockItemId: number;
}): Promise<{ checks: RepairCheck[]; proposals: HistoricalSalesRepairProposal[]; report: Record<string, unknown> }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await enableMaintenanceScope(client);
    const cutoffResult = await client.query<{ cutoff: Date }>("SELECT clock_timestamp() AS cutoff");
    const key = historicalInventoryKey(input.companyId, input.locationId, input.stockItemId);
    const result = await dryRunCompany(client, input.companyId, cutoffResult.rows[0].cutoff, {
      diagnoseKeys: new Set([key]),
    });
    return {
      checks: result.checks.filter(
        (check) => check.locationId === input.locationId && check.stockItemId === input.stockItemId
      ),
      proposals: result.proposals.filter(
        (proposal) => proposal.locationId === input.locationId && proposal.stockItemId === input.stockItemId
      ),
      report: result.report,
    };
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

export async function getHistoricalSalesCostRepairRun(runId: number): Promise<Record<string, unknown> | null> {
  await ensureHistoricalSalesCostRepairSchema(pool);
  const run = await pool.query(
    `SELECT id,algorithm_version,status,source_cutoff_at,requested_company_ids,created_by,created_at,
            completed_at,applied_by,applied_at,audit_hash,total_sales_rows,changed_rows,blocked_rows,
            blocked_item_locations,original_total_cost,proposed_total_cost,original_total_profit,
            proposed_total_profit,report,error
       FROM historical_sales_cost_repair_runs
      WHERE id=$1`,
    [runId]
  );
  if (!run.rows[0]) return null;

  const [blockers, monthly, rowStatus] = await Promise.all([
    pool.query(
      `SELECT company_id,location_id,stock_item_id,check_code,status,expected_value,actual_value,detail
         FROM historical_sales_cost_repair_checks
        WHERE run_id=$1 AND status IN ('block','warning')
        ORDER BY company_id,stock_item_id,location_id NULLS FIRST,check_code
        LIMIT 500`,
      [runId]
    ),
    pool.query(
      `SELECT company_id,
              to_char(date_trunc('month',occurred_at),'YYYY-MM') AS month,
              COUNT(*)::int AS sale_lines,
              COUNT(*) FILTER (WHERE changed)::int AS changed_lines,
              SUM(original_total_cost)::text AS original_cogs,
              SUM(proposed_total_cost)::text AS proposed_cogs,
              SUM(original_profit)::text AS original_profit,
              SUM(proposed_profit)::text AS proposed_profit
         FROM historical_sales_cost_repair_rows
        WHERE run_id=$1
        GROUP BY company_id,date_trunc('month',occurred_at)
        ORDER BY company_id,month`,
      [runId]
    ),
    pool.query(
      `SELECT status,COUNT(*)::int AS rows
         FROM historical_sales_cost_repair_rows
        WHERE run_id=$1
        GROUP BY status
        ORDER BY status`,
      [runId]
    ),
  ]);
  return {
    ...run.rows[0],
    blockers: blockers.rows,
    monthlyReconciliation: monthly.rows,
    rowStatus: rowStatus.rows,
  };
}

/**
 * Fails when historical source evidence was back-dated or edited after the
 * dry-run cutoff. Normal new stock activity after the cutoff is allowed.
 * Shared by the full apply and the proven-rows-only partial apply.
 */
export async function assertNoHistoricalSourceEditsAfterCutoff(
  client: PoolClient,
  targetCompanyIds: number[],
  sourceCutoff: Date
): Promise<void> {
  const sourceDrift = await client.query<{
    kind: string;
    evidence_id: string;
  }>(
    `SELECT 'backdated-canonical'::text AS kind,id::text AS evidence_id
       FROM canonical_stock_movements
      WHERE company_id = ANY($1::int[])
        AND created_at > $2
        AND occurred_at <= $2
      UNION ALL
     SELECT 'historical-voucher-edit'::text AS kind,a.id::text AS evidence_id
       FROM audit_log a
       JOIN vouchers v
         ON a.table_name='vouchers'
        AND a.record_id=v.id
        AND v.company_id=a.company_id
      WHERE a.company_id = ANY($1::int[])
        AND a.created_at > $2
        AND v.created_at <= $2
      UNION ALL
     SELECT 'historical-container-edit'::text AS kind,a.id::text AS evidence_id
       FROM audit_log a
       JOIN containers c
         ON a.table_name='containers'
        AND a.record_id=c.id
        AND c.company_id=a.company_id
      WHERE a.company_id = ANY($1::int[])
        AND a.created_at > $2
        AND c.created_at <= $2
      ORDER BY kind,evidence_id
      LIMIT 25`,
    [targetCompanyIds, sourceCutoff]
  );
  if (sourceDrift.rows.length > 0) {
    throw new Error(
      `Historical sales cost repair source evidence changed after dry run: ${sourceDrift.rows
        .map((row) => `${row.kind}#${row.evidence_id}`)
        .join(", ")}. Build and review a new dry run.`
    );
  }
}

export async function applyHistoricalSalesCostRepair(input: {
  runId: number;
  auditHash: string;
  appliedBy: string;
}): Promise<{ runId: number; appliedRows: number; auditHash: string }> {
  await ensureHistoricalSalesCostRepairSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await enableMaintenanceScope(client);
    await client.query("SELECT pg_advisory_xact_lock(hashtext('historical-sales-cost-repair-apply'))");

    const runResult = await client.query<{
      id: number;
      status: string;
      audit_hash: string;
      algorithm_version: string;
      blocked_rows: number;
      source_cutoff_at: Date;
      requested_company_ids: number[] | null;
    }>(
      `SELECT id,status,audit_hash,algorithm_version,blocked_rows,source_cutoff_at,requested_company_ids
         FROM historical_sales_cost_repair_runs
        WHERE id=$1
        FOR UPDATE`,
      [input.runId]
    );
    const run = runResult.rows[0];
    if (!run) throw hscrError("HSCR_RUN_NOT_FOUND");
    if (run.algorithm_version !== HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION) {
      throw hscrError("HSCR_ALGORITHM_VERSION_MISMATCH");
    }
    if (run.status !== "ready") {
      throw hscrError(`HSCR_RUN_NOT_READY:${input.runId}:${run.status}`);
    }
    if (!run.audit_hash || run.audit_hash !== input.auditHash) {
      throw hscrError("HSCR_AUDIT_HASH_MISMATCH");
    }
    const partial = await client.query("SELECT id FROM historical_sales_cost_repair_partial_applies WHERE run_id=$1", [
      input.runId,
    ]);
    if (partial.rows.length > 0) {
      throw hscrError("HSCR_RUN_PARTIALLY_APPLIED");
    }

    const blockerCount = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM historical_sales_cost_repair_checks
        WHERE run_id=$1 AND status='block'`,
      [input.runId]
    );
    if (Number(blockerCount.rows[0]?.count ?? 0) !== 0) {
      throw hscrError("HSCR_RUN_HAS_BLOCKERS");
    }

    const targetCompanyIds = (run.requested_company_ids ?? []).map(Number);
    if (targetCompanyIds.length === 0) {
      throw hscrError("HSCR_RUN_SCOPE_EMPTY");
    }

    // Recompute the exact V2 evidence bundle that was reviewed during dry-run.
    // This pins the immutable checkpoint/cutoff, canonical + legacy movements,
    // merge aliases/source openings, and every target sale original.
    const evidenceChecks = await client.query<{ company_id: number; expected_value: string }>(
      `SELECT company_id,expected_value
         FROM historical_sales_cost_repair_checks
        WHERE run_id=$1
          AND check_code='V2_SOURCE_EVIDENCE_HASH'
          AND status='pass'
        ORDER BY company_id`,
      [input.runId]
    );
    const expectedEvidenceByCompany = new Map(
      evidenceChecks.rows.map((row) => [Number(row.company_id), String(row.expected_value)])
    );
    if (expectedEvidenceByCompany.size !== targetCompanyIds.length) {
      throw hscrError("HSCR_V2_EVIDENCE_HASH_SCOPE_MISMATCH");
    }
    for (const companyId of targetCompanyIds) {
      const expected = expectedEvidenceByCompany.get(companyId);
      if (!expected) throw hscrError(`HSCR_V2_EVIDENCE_HASH_MISSING:${companyId}`);
      const actual = await recomputeHistoricalSalesCompanyEvidenceHash(client, companyId, run.source_cutoff_at);
      if (actual !== expected) {
        throw hscrError(`HSCR_V2_SOURCE_EVIDENCE_DRIFT:${companyId}`);
      }
    }

    await assertSalesItemsUpdateHasNoSideEffectTriggers(client);
    const inventoryBeforeApply = await inventoryEvidenceFingerprint(client, targetCompanyIds);

    // Keep targeted "changed-after-cutoff" checks as a second line of defense.
    // Normal new stock activity after the source cutoff is allowed.
    await assertNoHistoricalSourceEditsAfterCutoff(client, targetCompanyIds, run.source_cutoff_at);

    const drift = await client.query<{ sales_item_id: number }>(
      `SELECT r.sales_item_id
         FROM historical_sales_cost_repair_rows r
         LEFT JOIN sales_items si ON si.id=r.sales_item_id
        WHERE r.run_id=$1
          AND r.status='ready'
          AND (
            si.id IS NULL
            OR si.cost_price IS DISTINCT FROM r.original_cost_price
            OR si.total_cost IS DISTINCT FROM r.original_total_cost
            OR si.profit IS DISTINCT FROM r.original_profit
          )
        ORDER BY r.sales_item_id
        LIMIT 25`,
      [input.runId]
    );
    if (drift.rows.length > 0) {
      throw new Error(
        `Historical sales cost repair refused because target sale rows changed after dry run: ${drift.rows
          .map((row) => row.sales_item_id)
          .join(", ")}`
      );
    }

    await client.query(
      `UPDATE historical_sales_cost_repair_runs
          SET status='applying',applied_by=$2
        WHERE id=$1`,
      [input.runId, input.appliedBy]
    );

    await client.query(
      `INSERT INTO historical_sales_cost_repair_apply_log
       (run_id,company_id,sales_item_id,before_cost_price,before_total_cost,before_profit,
        after_cost_price,after_total_cost,after_profit,applied_by)
       SELECT r.run_id,r.company_id,r.sales_item_id,
              r.original_cost_price,r.original_total_cost,r.original_profit,
              r.proposed_cost_price,r.proposed_total_cost,r.proposed_profit,$2
         FROM historical_sales_cost_repair_rows r
        WHERE r.run_id=$1 AND r.status='ready'
       ON CONFLICT (run_id,sales_item_id) DO NOTHING`,
      [input.runId, input.appliedBy]
    );

    const updated = await client.query(
      `UPDATE sales_items si
          SET cost_price=r.proposed_cost_price,
              total_cost=r.proposed_total_cost,
              profit=r.proposed_profit
         FROM historical_sales_cost_repair_rows r
        WHERE r.run_id=$1
          AND r.status='ready'
          AND r.sales_item_id=si.id
        RETURNING si.id`,
      [input.runId]
    );

    await client.query(
      `UPDATE historical_sales_cost_repair_rows
          SET status='applied',applied_at=NOW()
        WHERE run_id=$1 AND status='ready'`,
      [input.runId]
    );

    const verify = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM historical_sales_cost_repair_rows r
         JOIN sales_items si ON si.id=r.sales_item_id
        WHERE r.run_id=$1
          AND r.status='applied'
          AND (
            si.cost_price IS DISTINCT FROM r.proposed_cost_price
            OR si.total_cost IS DISTINCT FROM r.proposed_total_cost
            OR si.profit IS DISTINCT FROM r.proposed_profit
          )`,
      [input.runId]
    );
    if (Number(verify.rows[0]?.count ?? 0) !== 0) {
      throw hscrError("HSCR_POST_APPLY_VERIFY_FAILED");
    }

    const inventoryAfterApply = await inventoryEvidenceFingerprint(client, targetCompanyIds);
    if (
      inventoryAfterApply.hash !== inventoryBeforeApply.hash ||
      inventoryAfterApply.rowCount !== inventoryBeforeApply.rowCount
    ) {
      throw hscrError("HSCR_INVENTORY_CHANGED_DURING_APPLY");
    }

    await client.query(
      `UPDATE historical_sales_cost_repair_runs
          SET status='applied',
              applied_at=NOW(),
              completed_at=NOW(),
              report=COALESCE(report,'{}'::jsonb) || jsonb_build_object(
                'applyInventorySnapshot',
                jsonb_build_object(
                  'beforeHash',$2::text,
                  'afterHash',$3::text,
                  'rowCount',$4::int,
                  'unchanged',true
                )
              )
        WHERE id=$1`,
      [input.runId, inventoryBeforeApply.hash, inventoryAfterApply.hash, inventoryAfterApply.rowCount]
    );

    await client.query("COMMIT");

    logger.info("Historical sales cost repair applied", {
      module: "historical-sales-cost-repair",
      action: "apply",
      runId: input.runId,
      auditHash: input.auditHash,
      appliedRows: updated.rowCount ?? 0,
      appliedBy: input.appliedBy,
    });

    return {
      runId: input.runId,
      appliedRows: updated.rowCount ?? 0,
      auditHash: input.auditHash,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

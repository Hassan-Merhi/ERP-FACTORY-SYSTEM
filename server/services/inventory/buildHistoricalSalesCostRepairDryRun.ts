// Extracted from ./historicalSalesCostRepair.ts to keep that module under the source-size cap.
import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { pool } from "../../db";
import { logger } from "../../lib/logger";
import {
  HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION,
  historicalInventoryKey,
  type HistoricalSalesRepairProposal,
  repairMoney,
} from "./historicalSalesCostRepairEngine";
import {
  blockerForProposal,
  buildRepairBlockerIndex,
  distinctBlockedItemLocations,
  hscrError,
  RepairCheck,
} from "./historicalSalesCostRepairTypes";
import { companyIdsForRun, enableMaintenanceScope } from "./historicalSalesCostRepairLoaders";
import { dryRunCompany } from "./historicalSalesCostRepairDryRun";
import {
  persistChecks,
  persistProposalRows,
  proposalHashSource,
  type HistoricalSalesCostDryRunResult,
} from "./historicalSalesCostRepairPersistProposalRows";

export async function buildHistoricalSalesCostRepairDryRun(input: {
  createdBy: string;
  companyIds?: number[];
}): Promise<HistoricalSalesCostDryRunResult> {
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

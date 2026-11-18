// Extracted from ./historicalSalesCostRepair.ts to keep that module under the source-size cap.
import type { PoolClient } from "pg";
import type { HistoricalSalesRepairProposal } from "./historicalSalesCostRepairEngine";
import { blockerForProposal, buildRepairBlockerIndex, RepairCheck } from "./historicalSalesCostRepairTypes";

export function proposalHashSource(
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

export async function persistProposalRows(
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

export async function persistChecks(client: PoolClient, runId: number, checks: RepairCheck[]): Promise<void> {
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

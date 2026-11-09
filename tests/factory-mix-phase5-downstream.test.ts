import { beforeEach, describe, expect, it, vi } from "vitest";
const stub = vi.hoisted(() => ({
  queries: [] as string[],
  released: false,
  fail: false,
}));
vi.mock("../server/db", () => ({
  pool: { connect: async () => ({
    query: async (query: string) => {
      stub.queries.push(query);
      if (stub.fail && query.includes("FROM factory_mix_batches m")) throw new Error("snapshot failed");
      if (query.includes("FROM factory_mix_batches m")) return { rows: [{
        id: 231, batch_code: "FMB-2026-0231", batch_date: "2026-11-07",
        status: "COMPLETED", deleted_at: null, total_weight_kg: "15353",
        used_kg: "15353", total_cost: "8698.5852", cost_per_kg: "0.5665723",
        linked_bales: "0", linked_bale_cost_usd: "0",
        linked_pressing_batches: "0", linked_daily_usages: "0", mismatch_bales: "0",
      }] };
      if (query.includes("FROM factory_bales b LEFT JOIN")) return { rows: [{
        total: "47452", active_rows: "47452", linked_to_mix: "0", linked_via_pressing: "0",
        missing_mix_link: "47452", sold: "40116", dispatched: "353", in_stock: "4880",
        finished_stock_value_usd: "208887.0000000",
        linked_cost_mismatch: "0", linked_total_abs_difference_usd: "0",
      }] };
      if (query.includes("FROM factory_recalc_undo_log")) return { rows: [{
        effective_from: null, status: null, opening_voucher_id: null,
        replay_undo_runs: "2", prior_recost_runs: "2",
        prior_recost_linked_vouchers: "0", factory_stock_value_events: "0",
      }] };
      if (query.includes("FROM customer_order_bales cob")) return { rows: [{
        ordered_bales: "42664", invoiced_loading_bales: "2", pos_sale_bales: "0",
      }] };
      return { rows: [] };
    },
    release: () => { stub.released = true; },
  }) },
}));
import {
  classifyDownstreamMixLine,
  getPhase5MixDownstreamReconciliation,
  phase5MixDownstreamCsv,
  summarizePhase5MixDownstream,
} from "../server/services/factory/mixPhase5DownstreamAudit";
import {
  Phase5ReplayDownstreamBlockedError,
  assertPhase5ReplayScopeSafe,
  evaluatePhase5ReplaySafety,
  inspectPhase5ReplayScopeSafety,
} from "../server/services/factory/historical-replay/downstreamGatePhase5";

const batch = (x: Record<string, unknown> = {}) => ({
  id: 231, batch_code: "FMB-2026-0231", batch_date: "2026-11-07",
  status: "COMPLETED", deleted_at: null,
  total_weight_kg: "15353.000", used_kg: "15353.000",
  total_cost: "8698.5852000", cost_per_kg: "0.5665723",
  linked_bales: "0", linked_bale_cost_usd: "0",
  linked_pressing_batches: "0", linked_daily_usages: "0", mismatch_bales: "0",
  ...x,
});
const totals = {
  total: "47876", active_rows: "47452", linked_to_mix: "0", linked_via_pressing: "0",
  missing_mix_link: "47452", sold: "40116", dispatched: "353", in_stock: "4880",
  finished_stock_value_usd: "208887.0000000",
  linked_cost_mismatch: "0", linked_total_abs_difference_usd: "0",
};
const ledger = {
  effective_from: null, status: null, opening_voucher_id: null,
  replay_undo_runs: "2", prior_recost_runs: "2",
  prior_recost_linked_vouchers: "0", factory_stock_value_events: "0",
};
const sales = { ordered_bales: "42664", invoiced_loading_bales: "2", pos_sale_bales: "0" };
const scope = {
  supplierIds: [37], containerIdsToUpdate: [], rawStockIdsToUpdate: [],
  sourceIdsToUpdate: [10], batchIdsToUpdate: [231],
  availableBaleIdsToUpdate: [], finalizedBaleIdsToUpdate: [], blockedBatches: [],
};

describe("Phase 5 mixed-batch downstream lineage audit", () => {
  it("does not call 0 linked bales a reconciled production cost", () => {
    const row = classifyDownstreamMixLine(batch());
    expect(row.classification).toBe("NO_RECORDED_PRODUCTION_LINEAGE");
    expect(row.correctionDecision).toBe("BLOCK_HISTORICAL_REPRICE");
    expect(row.mismatchedLinkedBales).toBe(0);
    expect(row.recordedUsd).toBe("8698.5852000");
  });

  it("distinguishes deleted history, unused mixes, and linked costing discrepancies", () => {
    expect(classifyDownstreamMixLine(batch({ deleted_at: "2026-11-09" })).classification)
      .toBe("DELETED_HISTORY");
    expect(classifyDownstreamMixLine(batch({ used_kg: "0", linked_bales: "0" })).classification)
      .toBe("NOT_YET_CONSUMED");
    expect(classifyDownstreamMixLine(batch({ linked_bales: "4", mismatch_bales: "1" })).classification)
      .toBe("LINKED_BALE_COST_MISMATCH");
    expect(classifyDownstreamMixLine(batch({ linked_pressing_batches: "1" })).classification)
      .toBe("LINKED_PRODUCTION_EVIDENCE");
  });

  it("reports sale exposure separately from stock and does not invent a COGS delta", () => {
    const report = summarizePhase5MixDownstream(12, [batch()], totals, ledger, sales);
    expect(report.readOnly).toBe(true);
    expect(report.summary.consumedMixesWithoutLineage).toBe(1);
    expect(report.summary.totalUsedMixKgWithoutLineage).toBe("15353.000");
    expect(report.summary.unlinkedBaleRows).toBe(47452);
    expect(report.summary.soldBales).toBe(40116);
    expect(report.summary.finishedGoodsSavedValueUsd).toBe("208887.0000000");
    expect(report.summary.inventoryCutoverActive).toBe(false);
    expect(report.summary.historicalBaleRecostRuns).toBe(2);
    expect(report.summary.baleCostMismatchRows).toBe(0);
  });

  it("escapes spreadsheet formula-like batch codes", () => {
    const report = summarizePhase5MixDownstream(12, [batch({ batch_code: "=1+2" })], totals, ledger, sales);
    const csv = phase5MixDownstreamCsv(report);
    expect(csv).toContain("'=1+2");
    expect(csv).toContain("BLOCK_HISTORICAL_REPRICE");
  });
});

describe("Phase 5 mandatory historical replay safety", () => {
  it("blocks unlinked consumed batches, finalized/sold bales and unjournaled cutover changes", () => {
    const result = evaluatePhase5ReplaySafety({
      companyId: 12, missingLineageBatchIds: [231],
      protectedBaleIds: [100], finalizedBaleIds: [101],
      perpetualCutoverActive: true, proposedValueRows: 3,
    });
    expect(result.safeToApply).toBe(false);
    expect(result.blockers).toHaveLength(3);
    expect(result.missingLineageBatchIds).toEqual([231]);
  });

  it("does not mistake a pressing-finalized in-stock bale for an invoiced sale", () => {
    const result = evaluatePhase5ReplaySafety({ companyId: 12, proposedValueRows: 1 });
    expect(result.safeToApply).toBe(true);
  });

  it("returns an explicit 409 safety violation before any replay cost write", async () => {
    const q = {
      query: async (sql: string) => {
        if (sql.includes("FROM factory_mix_batches m")) return { rows: [{ id: 231 }] };
        if (sql.includes("FROM gl_inventory_cutovers")) return { rows: [{ active: false }] };
        return { rows: [] };
      },
    };
    const inspection = await inspectPhase5ReplayScopeSafety(q as never, 12, scope);
    expect(inspection.safeToApply).toBe(false);
    await expect(assertPhase5ReplayScopeSafe(q as never, 12, scope))
      .rejects.toMatchObject({ code: "HISTORICAL_REPLAY_DOWNSTREAM_UNRECONCILED", statusCode: 409 });
  });

  it("refuses perpetual GL changes until an atomic approved journal workflow exists", () => {
    const x = evaluatePhase5ReplaySafety({
      companyId: 12, perpetualCutoverActive: true, proposedValueRows: 1,
    });
    expect(x.safeToApply).toBe(false);
    expect(x.blockers.join(" ")).toContain("atomic GL revaluation");
  });

  it("still permits an empty, non-finalized, fully traced scope before cutover", () => {
    const x = evaluatePhase5ReplaySafety({
      companyId: 12, perpetualCutoverActive: false, proposedValueRows: 0,
    });
    expect(x.safeToApply).toBe(true);
  });
});

describe("Phase 5 read-only production snapshot", () => {
  beforeEach(() => { stub.queries = []; stub.released = false; stub.fail = false; });

  it("uses a repeatable-read read-only transaction, never an inventory or GL write", async () => {
    const report = await getPhase5MixDownstreamReconciliation(12);
    expect(report.summary.consumedMixesWithoutLineage).toBe(1);
    expect(report.summary.inventoryCutoverActive).toBe(false);
    expect(stub.queries[0]).toContain("REPEATABLE READ READ ONLY");
    expect(stub.queries.some(s => s.includes("app.current_company_id"))).toBe(true);
    expect(stub.queries.some(s => /^\s*(INSERT|UPDATE|DELETE)\b/.test(s))).toBe(false);
    expect(stub.queries.at(-1)).toBe("COMMIT");
    expect(stub.released).toBe(true);
  });

  it("rolls back and releases connection on a query error", async () => {
    stub.fail = true;
    await expect(getPhase5MixDownstreamReconciliation(12)).rejects.toThrow("snapshot failed");
    expect(stub.queries.at(-1)).toBe("ROLLBACK");
    expect(stub.released).toBe(true);
  });
});

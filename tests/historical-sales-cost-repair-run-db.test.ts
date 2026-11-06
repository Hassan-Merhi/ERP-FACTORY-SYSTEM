/**
 * The historical sales cost repair run lifecycle against a real database:
 * building a dry run for a company, reading the run report back, diagnosing
 * one item/location, and applying a ready run. The pool is routed into one
 * rolled-back transaction per case, so applying a run writes nothing that
 * outlives the test.
 */
import {
  applyHistoricalSalesCostRepair,
  buildHistoricalSalesCostRepairDryRun,
  diagnoseHistoricalSalesCostKey,
  getHistoricalSalesCostRepairRun,
} from "../server/services/inventory/historicalSalesCostRepair";
import { HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION } from "../server/services/inventory/historicalSalesCostRepairEngine";
import { HscrFixture } from "./helpers/historicalSalesCostRepairDbFixture";

const CHECKPOINT = "2026-02-01T00:00:00Z";

let fixture: HscrFixture;
let unroute: () => void;
let ids: { l: number; i: number; sale: number; voucher: number };

beforeEach(async () => {
  fixture = await HscrFixture.open();
  const l = await fixture.location();
  const i = await fixture.item();
  const sale = await fixture.sale("2026-01-05T10:00:00Z", l, i, 2, 99);
  await fixture.checkpoint(CHECKPOINT, [{ locationId: l, stockItemId: i, quantity: 8, rate: 10 }]);
  await fixture.inventory(l, i, 8, 10);
  ids = { l, i, sale: sale.salesItemId, voucher: sale.voucherId };
  unroute = fixture.routePool();
});

afterEach(async () => {
  unroute();
  await fixture.close();
});

const build = () => buildHistoricalSalesCostRepairDryRun({ createdBy: "tester", companyIds: [fixture.companyId] });

async function saleRow() {
  const result = await fixture.client.query(
    "SELECT cost_price::text,total_cost::text,profit::text FROM sales_items WHERE id=$1",
    [ids.sale]
  );
  return result.rows[0];
}

describe("historical sales cost repair runs", () => {
  it("builds a ready run with apply-effective totals and a stable audit hash", async () => {
    const run = await build();

    expect(run).toMatchObject({
      status: "ready",
      totalSalesRows: 1,
      changedRows: 1,
      blockedRows: 0,
      originalTotalCost: "198.00",
      proposedTotalCost: "20.00",
      originalTotalProfit: "-168.00",
      proposedTotalProfit: "10.00",
    });
    expect(run.auditHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("reads the run back with its row status and monthly reconciliation", async () => {
    const { runId } = await build();

    const stored = await getHistoricalSalesCostRepairRun(runId);

    expect(stored).toMatchObject({ id: String(runId), status: "ready", created_by: "tester" });
    expect(Number(stored?.total_sales_rows)).toBe(1);
    expect(stored?.rowStatus).toEqual([{ status: "ready", rows: 1 }]);
    expect(stored?.monthlyReconciliation).toEqual([
      expect.objectContaining({ month: "2026-01", sale_lines: 1, changed_lines: 1 }),
    ]);
    expect(await getHistoricalSalesCostRepairRun(999_999_999)).toBeNull();
  });

  it("refuses a company that does not exist", async () => {
    await expect(
      buildHistoricalSalesCostRepairDryRun({ createdBy: "tester", companyIds: [fixture.companyId, 999_999_999] })
    ).rejects.toThrow("HSCR_REQUESTED_COMPANY_NOT_FOUND");
  });

  it("marks a run blocked when any check blocks, and counts blocked rows at their original cost", async () => {
    // A priced receipt at the sale's exact timestamp makes its cost order ambiguous.
    await fixture.adjustment("2026-01-05T10:00:00Z", ids.l, ids.i, 4, 30);

    const run = await build();
    const stored = await getHistoricalSalesCostRepairRun(run.runId);
    const rejected = (stored?.report as { totals: { blockedRejectedCandidateTotalCost: string } }).totals;

    expect(run).toMatchObject({ status: "blocked", blockedRows: 1, proposedTotalCost: "198.00" });
    // The rejected candidate is reported, but never counted in the run totals.
    expect(rejected.blockedRejectedCandidateTotalCost).not.toBe("198.00");
    expect(stored?.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ check_code: "SAME_TIMESTAMP_COST_ORDER_AMBIGUOUS" })])
    );
    await expect(
      applyHistoricalSalesCostRepair({ runId: run.runId, auditHash: run.auditHash, appliedBy: "tester" })
    ).rejects.toThrow(`HSCR_RUN_NOT_READY:${run.runId}:blocked`);
  });

  it("blocks every sale of a company without a valuation checkpoint", async () => {
    await fixture.client.query("DELETE FROM phase3_inventory_valuation_cutovers WHERE company_id=$1", [
      fixture.companyId,
    ]);

    expect(await build()).toMatchObject({ status: "blocked", blockedRows: 1, changedRows: 0 });
  });

  it("diagnoses one item at one location without persisting a run", async () => {
    const before = await fixture.client.query("SELECT COUNT(*)::int AS n FROM historical_sales_cost_repair_runs");

    const diagnosis = await diagnoseHistoricalSalesCostKey({
      companyId: fixture.companyId,
      locationId: ids.l,
      stockItemId: ids.i,
    });

    expect(diagnosis.proposals.map((proposal) => proposal.proposedCostPrice)).toEqual(["10.00"]);
    expect(diagnosis.checks.every((check) => check.locationId === ids.l && check.stockItemId === ids.i)).toBe(true);
    const after = await fixture.client.query("SELECT COUNT(*)::int AS n FROM historical_sales_cost_repair_runs");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("applies a ready run to the sale rows and logs the before and after values", async () => {
    const run = await build();

    const applied = await applyHistoricalSalesCostRepair({
      runId: run.runId,
      auditHash: run.auditHash,
      appliedBy: "tester",
    });

    expect(applied).toEqual({ runId: run.runId, appliedRows: 1, auditHash: run.auditHash });
    expect(await saleRow()).toEqual({ cost_price: "10.00", total_cost: "20.00", profit: "10.00" });
    const log = await fixture.client.query(
      "SELECT before_cost_price::text,after_cost_price::text FROM historical_sales_cost_repair_apply_log WHERE run_id=$1",
      [run.runId]
    );
    expect(log.rows).toEqual([{ before_cost_price: "99.00", after_cost_price: "10.00" }]);
    expect(await getHistoricalSalesCostRepairRun(run.runId)).toMatchObject({ status: "applied", applied_by: "tester" });

    await expect(
      applyHistoricalSalesCostRepair({ runId: run.runId, auditHash: run.auditHash, appliedBy: "tester" })
    ).rejects.toThrow(`HSCR_RUN_NOT_READY:${run.runId}:applied`);
  });

  it("refuses a wrong audit hash or an unknown run", async () => {
    const run = await build();

    await expect(
      applyHistoricalSalesCostRepair({ runId: run.runId, auditHash: "f".repeat(64), appliedBy: "tester" })
    ).rejects.toThrow("HSCR_AUDIT_HASH_MISMATCH");
    await expect(
      applyHistoricalSalesCostRepair({ runId: 999_999_999, auditHash: run.auditHash, appliedBy: "tester" })
    ).rejects.toThrow("HSCR_RUN_NOT_FOUND");
    expect(await saleRow()).toMatchObject({ cost_price: "99.00" });
  });

  it("refuses to apply when the reviewed evidence changed after the dry run", async () => {
    const run = await build();
    await fixture.client.query("UPDATE sales_items SET cost_price=98, total_cost=196, profit=-166 WHERE id=$1", [
      ids.sale,
    ]);

    await expect(
      applyHistoricalSalesCostRepair({ runId: run.runId, auditHash: run.auditHash, appliedBy: "tester" })
    ).rejects.toThrow("HSCR_V2_SOURCE_EVIDENCE_DRIFT");
    expect(await saleRow()).toMatchObject({ cost_price: "98.00" });
  });

  it("refuses to apply over a partial apply, and to build a dry run while one is active", async () => {
    const run = await build();
    await fixture.client.query(
      `INSERT INTO historical_sales_cost_repair_partial_applies
         (run_id,status,audit_hash,algorithm_version,target_hash,target_rows,applied_by)
       VALUES($1,'applied',$2,$3,$2,1,'tester')`,
      [run.runId, run.auditHash, HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION]
    );

    await expect(
      applyHistoricalSalesCostRepair({ runId: run.runId, auditHash: run.auditHash, appliedBy: "tester" })
    ).rejects.toThrow("HSCR_RUN_PARTIALLY_APPLIED");
    await expect(build()).rejects.toThrow(`HSCR_DRY_RUN_REFUSED_ACTIVE_PARTIAL_APPLY`);
  });
});

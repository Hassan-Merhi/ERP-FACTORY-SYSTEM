/**
 * The proven-rows-only partial apply on the real schema. A dry run over two
 * items gives one ready row (cleanly rewound from the checkpoint) and one
 * blocked row (its sale shares a timestamp with a priced receipt). The partial
 * apply must write the ready row only, snapshot it, verify, and roll back to
 * the original values; each step refuses a wrong confirmation, hash or state.
 * The pool is routed into one rolled-back transaction per case.
 */
import { buildHistoricalSalesCostRepairDryRun } from "../server/services/inventory/historicalSalesCostRepair";
import {
  HISTORICAL_SALES_COST_PARTIAL_APPLY_MODE,
  applyHistoricalSalesCostPartial,
  previewHistoricalSalesCostPartialApply,
  rollbackHistoricalSalesCostPartial,
  verifyHistoricalSalesCostPartialApply,
} from "../server/services/inventory/historicalSalesCostPartialApply";
import {
  partialApplyConfirmation,
  partialRollbackConfirmation,
} from "../server/services/inventory/historicalSalesCostPartialApplyGuards";
import { HscrFixture } from "./helpers/historicalSalesCostRepairDbFixture";

const CHECKPOINT = "2026-02-01T00:00:00Z";

let fixture: HscrFixture;
let unroute: () => void;
let ready = 0;
let blocked = 0;
let run: { runId: number; auditHash: string };

beforeEach(async () => {
  fixture = await HscrFixture.open();
  const l = await fixture.location();
  const clean = await fixture.item();
  const tied = await fixture.item();
  ready = (await fixture.sale("2026-01-05T10:00:00Z", l, clean, 2, 99)).salesItemId;
  await fixture.adjustment("2026-01-06T10:00:00Z", l, tied, 4, 30);
  blocked = (await fixture.sale("2026-01-06T10:00:00Z", l, tied, 2, 77)).salesItemId;
  await fixture.checkpoint(CHECKPOINT, [
    { locationId: l, stockItemId: clean, quantity: 8, rate: 10 },
    { locationId: l, stockItemId: tied, quantity: 6, rate: 15 },
  ]);
  unroute = fixture.routePool();
  run = await buildHistoricalSalesCostRepairDryRun({ createdBy: "tester", companyIds: [fixture.companyId] });
});

afterEach(async () => {
  unroute();
  await fixture.close();
});

async function cost(salesItemId: number): Promise<string> {
  const result = await fixture.client.query("SELECT cost_price::text FROM sales_items WHERE id=$1", [salesItemId]);
  return result.rows[0].cost_price;
}

async function applyInput(overrides: Record<string, unknown> = {}) {
  const preview = await previewHistoricalSalesCostPartialApply(run.runId);
  const targetHash = (overrides.targetHash as string) ?? preview.targetHash;
  return {
    runId: run.runId,
    auditHash: run.auditHash,
    targetHash,
    mode: HISTORICAL_SALES_COST_PARTIAL_APPLY_MODE,
    confirmation: partialApplyConfirmation(run.runId, run.auditHash, targetHash),
    appliedBy: "tester",
    ...overrides,
  };
}

const rollbackInput = () => ({
  runId: run.runId,
  auditHash: run.auditHash,
  confirmation: partialRollbackConfirmation(run.runId, run.auditHash),
  rolledBackBy: "tester",
});

describe("proven-rows-only partial apply", () => {
  it("previews only the ready row with its reconciliation", async () => {
    const preview = await previewHistoricalSalesCostPartialApply(run.runId, { includeTargetIds: true });

    expect(preview.targetRows).toBe(1);
    expect(preview.targetSalesItemIds).toEqual([ready]);
    expect(preview.rowSetViolations).toEqual([]);
    expect(preview.liveTargetDrift.count).toBe(0);
    expect(preview.reconciliation.target).toMatchObject({ rows: 1, originalCogs: "198.00", proposedCogs: "20.00" });
    expect(preview.reconciliation.blockedRemainUnchanged).toMatchObject({ rows: 1, writes: 0 });
    expect(preview.targetHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("writes the ready row only, verifies it, and is a no-op when retried", async () => {
    const input = await applyInput();

    const result = await applyHistoricalSalesCostPartial(input);

    expect(result).toMatchObject({ runId: run.runId, appliedRows: 1, alreadyApplied: false });
    expect(await cost(ready)).toBe("10.00");
    expect(await cost(blocked)).toBe("77.00");
    const verification = await verifyHistoricalSalesCostPartialApply(run.runId);
    expect(verification).toMatchObject({ ok: true, rowsAtProposed: 1 });

    const retry = await applyHistoricalSalesCostPartial(input);
    // The retry reports the original apply instead of writing again.
    expect(retry).toMatchObject({ partialApplyId: result.partialApplyId, alreadyApplied: true });
    expect(await cost(ready)).toBe("10.00");
  });

  it.each([
    ["a wrong confirmation", { confirmation: "PARTIAL-APPLY-PROVEN-ROWS:yes" }, "HSCR_PARTIAL_CONFIRMATION_MISMATCH"],
    ["a wrong mode", { mode: "apply" }, "HSCR_PARTIAL_MODE_REQUIRED"],
  ])("refuses %s before writing", async (_label, overrides, code) => {
    await expect(applyHistoricalSalesCostPartial(await applyInput(overrides))).rejects.toThrow(code);
    expect(await cost(ready)).toBe("99.00");
  });

  it("refuses a target hash that no longer matches the ready rows", async () => {
    const stale = "c".repeat(64);
    const input = await applyInput({
      targetHash: stale,
      confirmation: partialApplyConfirmation(run.runId, run.auditHash, stale),
    });

    await expect(applyHistoricalSalesCostPartial(input)).rejects.toThrow("HSCR_PARTIAL_TARGET_HASH_MISMATCH");
    expect(await cost(ready)).toBe("99.00");
  });

  it("refuses a run whose audit hash differs", async () => {
    const wrong = "d".repeat(64);
    const base = await applyInput();
    const input = {
      ...base,
      auditHash: wrong,
      confirmation: partialApplyConfirmation(run.runId, wrong, base.targetHash),
    };

    await expect(applyHistoricalSalesCostPartial(input)).rejects.toThrow("HSCR_AUDIT_HASH_MISMATCH");
  });

  it("rolls the applied row back to its original values and verifies it", async () => {
    await applyHistoricalSalesCostPartial(await applyInput());

    const result = await rollbackHistoricalSalesCostPartial(rollbackInput());

    expect(result).toMatchObject({ runId: run.runId, restoredRows: 1, alreadyRolledBack: false });
    expect(await cost(ready)).toBe("99.00");
    expect(await verifyHistoricalSalesCostPartialApply(run.runId)).toMatchObject({ ok: true, rowsAtOriginal: 1 });
  });

  it("refuses to roll back with a wrong confirmation, or before anything was applied", async () => {
    await expect(rollbackHistoricalSalesCostPartial({ ...rollbackInput(), confirmation: "nope" })).rejects.toThrow(
      "HSCR_PARTIAL_ROLLBACK_CONFIRMATION_MISMATCH"
    );
    await expect(rollbackHistoricalSalesCostPartial(rollbackInput())).rejects.toThrow(/HSCR_PARTIAL/);
  });

  it("refuses to apply when the target sale changed after the dry run", async () => {
    const input = await applyInput();
    await fixture.client.query("UPDATE sales_items SET cost_price=98 WHERE id=$1", [ready]);

    await expect(applyHistoricalSalesCostPartial(input)).rejects.toThrow(/HSCR_/);
    expect(await cost(ready)).toBe("98.00");
  });
});

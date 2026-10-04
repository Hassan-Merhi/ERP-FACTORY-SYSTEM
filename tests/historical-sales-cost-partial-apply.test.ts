import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";

import { ensureHistoricalSalesCostRepairSchema } from "../server/services/inventory/ensureHistoricalSalesCostRepairSchema";
import {
  HISTORICAL_SALES_COST_PARTIAL_APPLY_MODE,
  applyHistoricalSalesCostPartialWithClient,
  previewHistoricalSalesCostPartialApplyWithClient,
  rollbackHistoricalSalesCostPartialWithClient,
  validatePartialApplyInput,
  validatePartialRollbackInput,
  verifyHistoricalSalesCostPartialApplyWithClient,
} from "../server/services/inventory/historicalSalesCostPartialApply";
import {
  partialApplyConfirmation,
  partialRollbackConfirmation,
  rowSetIntegrityViolations,
  tableWriteViolations,
  type PartialApplyDeps,
} from "../server/services/inventory/historicalSalesCostPartialApplyGuards";
import { HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION } from "../server/services/inventory/historicalSalesCostRepairEngine";

const AUDIT = "a".repeat(64);
const OTHER = "b".repeat(64);

describe("partial apply input gates", () => {
  const base = {
    runId: 7,
    auditHash: AUDIT,
    targetHash: OTHER,
    mode: HISTORICAL_SALES_COST_PARTIAL_APPLY_MODE,
    confirmation: partialApplyConfirmation(7, AUDIT, OTHER),
    appliedBy: "dev",
  };

  it("binds the confirmation to run, audit hash and target hash", () => {
    expect(base.confirmation).toBe("PARTIAL-APPLY-PROVEN-ROWS:7:aaaaaaaaaaaa:bbbbbbbbbbbb");
    expect(partialRollbackConfirmation(7, AUDIT)).toBe("ROLLBACK-PARTIAL-APPLY:7:aaaaaaaaaaaa");
    expect(() => validatePartialApplyInput(base)).not.toThrow();
  });

  it("requires the explicit mode, exact confirmation and well-formed hashes", () => {
    expect(() => validatePartialApplyInput({ ...base, mode: "apply" })).toThrow("HSCR_PARTIAL_MODE_REQUIRED");
    expect(() => validatePartialApplyInput({ ...base, confirmation: "yes" })).toThrow(
      "HSCR_PARTIAL_CONFIRMATION_MISMATCH"
    );
    expect(() =>
      validatePartialApplyInput({ ...base, confirmation: partialApplyConfirmation(8, AUDIT, OTHER) })
    ).toThrow("HSCR_PARTIAL_CONFIRMATION_MISMATCH");
    expect(() => validatePartialApplyInput({ ...base, auditHash: "abc" })).toThrow("HSCR_PARTIAL_AUDIT_HASH_INVALID");
    expect(() => validatePartialApplyInput({ ...base, targetHash: "" })).toThrow("HSCR_PARTIAL_TARGET_HASH_INVALID");
    expect(() => validatePartialApplyInput({ ...base, runId: 0 })).toThrow("HSCR_PARTIAL_RUN_ID_INVALID");
    expect(() =>
      validatePartialRollbackInput({ runId: 7, auditHash: AUDIT, confirmation: "x", rolledBackBy: "dev" })
    ).toThrow("HSCR_PARTIAL_ROLLBACK_CONFIRMATION_MISMATCH");
  });
});

describe("transaction write allowlist", () => {
  it("accepts exactly the allowed writes and rejects anything else", () => {
    const before = new Map([["public.sales_items", { ins: 5, upd: 0, del: 0 }]]);
    const after = new Map([
      ["public.sales_items", { ins: 5, upd: 3, del: 0 }],
      ["public.historical_sales_cost_repair_apply_log", { ins: 3, upd: 0, del: 0 }],
    ]);
    const allowed = {
      "public.sales_items": { ins: 0, upd: 3, del: 0 },
      "public.historical_sales_cost_repair_apply_log": { ins: 3, upd: 0, del: 0 },
    };
    expect(tableWriteViolations(before, after, allowed)).toEqual([]);

    const withInventoryWrite = new Map(after);
    withInventoryWrite.set("public.inventory", { ins: 0, upd: 1, del: 0 });
    expect(tableWriteViolations(before, withInventoryWrite, allowed)).toEqual([
      "public.inventory:ins=0/0,upd=1/0,del=0/0",
    ]);

    const tooFew = new Map(after);
    tooFew.set("public.sales_items", { ins: 5, upd: 2, del: 0 });
    expect(tableWriteViolations(before, tooFew, allowed)).toHaveLength(1);
  });
});

describe("row-set integrity", () => {
  const run = { total_sales_rows: 4, changed_rows: 2, blocked_rows: 1 } as never;
  const row = (status: string, rows: number, changed: number, blocker: number, noOp = 0) => ({
    status,
    rows,
    changed_rows: changed,
    blocker_rows: blocker,
    no_op_rows: noOp,
  });

  it("accepts the reviewed ready/blocked/unchanged split", () => {
    expect(
      rowSetIntegrityViolations(run, [row("blocked", 1, 1, 1), row("ready", 2, 2, 0), row("unchanged", 1, 0, 0, 1)])
    ).toEqual([]);
  });

  it("rejects ready rows with blockers, blocked rows without codes and already-applied rows", () => {
    expect(
      rowSetIntegrityViolations(run, [row("blocked", 1, 1, 0), row("ready", 2, 2, 1), row("unchanged", 1, 0, 0)])
    ).toEqual(["ready-with-blocker:1", "blocked-without-code:1"]);
    expect(
      rowSetIntegrityViolations(run, [row("blocked", 1, 1, 1), row("applied", 2, 2, 0), row("unchanged", 1, 0, 0)])
    ).toContain("unexpected-status:applied");
  });
});

// Real-database tests. Run locally against a disposable database:
//   HSCR_PARTIAL_APPLY_TEST_DATABASE_URL=postgresql://postgres@localhost:55432/hscr_test npx vitest run tests/historical-sales-cost-partial-apply.test.ts
const databaseUrl = process.env.HSCR_PARTIAL_APPLY_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("partial apply against a real database", () => {
  let pool: Pool;
  let client: PoolClient;
  let evidenceHash = "evidence-1";
  const deps: PartialApplyDeps = {
    recomputeEvidenceHash: async () => evidenceHash,
  };

  async function sale(id: number) {
    const result = await client.query(
      "SELECT cost_price::text,total_cost::text,profit::text FROM sales_items WHERE id=$1",
      [id]
    );
    return result.rows[0];
  }

  async function counts() {
    const result = await client.query(`SELECT
      (SELECT COUNT(*)::int FROM historical_sales_cost_repair_partial_applies) AS partials,
      (SELECT COUNT(*)::int FROM historical_sales_cost_repair_apply_log) AS logs`);
    return result.rows[0];
  }

  async function targetHash(): Promise<string> {
    const preview = await previewHistoricalSalesCostPartialApplyWithClient(client, 1);
    return preview.targetHash;
  }

  async function applyInput(overrides: Record<string, unknown> = {}) {
    const hash = (overrides.targetHash as string) ?? (await targetHash());
    return {
      runId: 1,
      auditHash: AUDIT,
      targetHash: hash,
      mode: HISTORICAL_SALES_COST_PARTIAL_APPLY_MODE,
      confirmation: partialApplyConfirmation(1, AUDIT, hash),
      appliedBy: "test",
      ...overrides,
    };
  }

  const rollbackInput = {
    runId: 1,
    auditHash: AUDIT,
    confirmation: partialRollbackConfirmation(1, AUDIT),
    rolledBackBy: "test",
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    client = await pool.connect();
  });

  afterAll(async () => {
    client?.release();
    await pool?.end();
  });

  beforeEach(async () => {
    evidenceHash = "evidence-1";
    await client.query(`
      DROP TABLE IF EXISTS historical_sales_cost_repair_apply_log, historical_sales_cost_repair_partial_applies,
        historical_sales_cost_repair_checks, historical_sales_cost_repair_rows, historical_sales_cost_repair_runs,
        sales_items, vouchers, inventory, canonical_stock_movements, audit_log, containers CASCADE;
      DROP FUNCTION IF EXISTS hscr_test_side_effect() CASCADE;
      CREATE TABLE vouchers (id INT PRIMARY KEY, company_id INT, voucher_type TEXT, deleted_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE sales_items (id INT PRIMARY KEY, voucher_id INT, stock_item_id INT,
        cost_price NUMERIC(15,2), total_cost NUMERIC(15,2), profit NUMERIC(15,2));
      CREATE TABLE inventory (company_id INT, location_id INT, stock_item_id INT,
        quantity NUMERIC, average_rate NUMERIC, total_value NUMERIC);
      CREATE TABLE canonical_stock_movements (id INT, company_id INT, created_at TIMESTAMPTZ, occurred_at TIMESTAMPTZ);
      CREATE TABLE audit_log (id INT, company_id INT, table_name TEXT, record_id INT, created_at TIMESTAMPTZ);
      CREATE TABLE containers (id INT, company_id INT, created_at TIMESTAMPTZ);
      INSERT INTO vouchers VALUES (10,1,'Sales',NULL,NOW() - INTERVAL '1 day'),(11,1,'Sales',NULL,NOW() - INTERVAL '1 day');
      -- 101,102 ready; 103 blocked (its rejected candidate differs); 104 unchanged.
      INSERT INTO sales_items VALUES
        (101,10,500,10.00,20.00,5.00),
        (102,10,501,7.00,70.00,30.00),
        (103,11,502,4.00,40.00,10.00),
        (104,11,503,3.00,3.00,1.00);
      INSERT INTO inventory VALUES (1,1,500,5,12,60),(1,1,501,2,8,16);
    `);
    await ensureHistoricalSalesCostRepairSchema(pool);
    await client.query(
      `INSERT INTO historical_sales_cost_repair_runs
       (id,algorithm_version,status,source_cutoff_at,requested_company_ids,created_by,completed_at,audit_hash,
        total_sales_rows,changed_rows,blocked_rows)
       VALUES (1,$1,'blocked',NOW(),ARRAY[1],'test',NOW(),$2,4,2,1)`,
      [HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION, AUDIT]
    );
    await client.query(`
      INSERT INTO historical_sales_cost_repair_rows
       (run_id,company_id,location_id,stock_item_id,voucher_id,sales_item_id,occurred_at,evidence,source_type,source_id,
        original_cost_price,original_total_cost,original_profit,proposed_cost_price,proposed_total_cost,proposed_profit,
        changed,status,blocker_code,blocker_detail)
      VALUES
       (1,1,1,500,10,101,'2026-05-03','checkpoint-rewind','sale','101',10,20,5,12,24,1,true,'ready',NULL,NULL),
       (1,1,1,501,10,102,'2026-06-04','closed-era','sale','102',7,70,30,8,80,20,true,'ready',NULL,NULL),
       (1,1,1,502,11,103,'2026-06-05','legacy','sale','103',4,40,10,9,90,-40,true,'blocked','LEGACY_SALE_INVERSE_NOT_UNIQUE','two inverses'),
       (1,1,1,503,11,104,'2026-06-06','legacy','sale','104',3,3,1,3,3,1,false,'unchanged',NULL,NULL);
      INSERT INTO historical_sales_cost_repair_checks (run_id,company_id,check_code,status,expected_value)
      VALUES (1,1,'V2_SOURCE_EVIDENCE_HASH','pass','evidence-1'),
             (1,1,'LEGACY_SALE_INVERSE_NOT_UNIQUE','block',NULL);
    `);
  });

  it("previews exactly the ready rows with reconciliation totals", async () => {
    const preview = await previewHistoricalSalesCostPartialApplyWithClient(client, 1, { includeTargetIds: true });
    expect(preview.targetRows).toBe(2);
    expect(preview.targetSalesItemIds).toEqual([101, 102]);
    expect(preview.rowSetViolations).toEqual([]);
    expect(preview.liveTargetDrift.count).toBe(0);
    expect(preview.blockedRowsTargeted).toBe(0);
    expect(preview.unchangedRowsTargeted).toBe(0);
    expect(preview.reconciliation.target).toEqual({
      rows: 2,
      originalCogs: "90.00",
      proposedCogs: "104.00",
      cogsDelta: "14.00",
      originalProfit: "35.00",
      proposedProfit: "21.00",
      profitDelta: "-14.00",
    });
    expect(preview.reconciliation.blockedRemainUnchanged).toEqual({
      rows: 1,
      cogsKeptAtOriginal: "40.00",
      profitKeptAtOriginal: "10.00",
      writes: 0,
    });
    expect(preview.reconciliation.unchangedRemainUnchanged.rows).toBe(1);
    expect(preview.reconciliation.byMonth.map((row) => row.month)).toEqual(["2026-05", "2026-06"]);
    expect(await counts()).toEqual({ partials: 0, logs: 0 });
  });

  it("writes only ready rows, snapshots them, and leaves blocked/unchanged/inventory untouched", async () => {
    const result = await applyHistoricalSalesCostPartialWithClient(client, await applyInput(), deps);
    expect(result).toMatchObject({ appliedRows: 2, alreadyApplied: false });

    expect(await sale(101)).toEqual({ cost_price: "12.00", total_cost: "24.00", profit: "1.00" });
    expect(await sale(102)).toEqual({ cost_price: "8.00", total_cost: "80.00", profit: "20.00" });
    expect(await sale(103)).toEqual({ cost_price: "4.00", total_cost: "40.00", profit: "10.00" });
    expect(await sale(104)).toEqual({ cost_price: "3.00", total_cost: "3.00", profit: "1.00" });

    const rows = await client.query(
      "SELECT sales_item_id,status,blocker_code FROM historical_sales_cost_repair_rows ORDER BY sales_item_id"
    );
    expect(rows.rows.map((row) => [row.sales_item_id, row.status, row.blocker_code])).toEqual([
      [101, "ready", null],
      [102, "ready", null],
      [103, "blocked", "LEGACY_SALE_INVERSE_NOT_UNIQUE"],
      [104, "unchanged", null],
    ]);

    const log = await client.query(
      `SELECT sales_item_id,voucher_id,before_cost_price::text,before_total_cost::text,before_profit::text,
              after_total_cost::text,apply_mode,audit_hash,evidence
         FROM historical_sales_cost_repair_apply_log ORDER BY sales_item_id`
    );
    expect(log.rows).toEqual([
      expect.objectContaining({
        sales_item_id: 101,
        voucher_id: 10,
        before_cost_price: "10.00",
        before_total_cost: "20.00",
        before_profit: "5.00",
        after_total_cost: "24.00",
        apply_mode: "partial-proven-rows-only",
        audit_hash: AUDIT,
        evidence: "checkpoint-rewind",
      }),
      expect.objectContaining({ sales_item_id: 102, before_total_cost: "70.00", after_total_cost: "80.00" }),
    ]);

    const inventory = await client.query("SELECT total_value::text FROM inventory ORDER BY stock_item_id");
    expect(inventory.rows.map((row) => row.total_value)).toEqual(["60", "16"]);

    const verification = await verifyHistoricalSalesCostPartialApplyWithClient(client, 1);
    expect(verification).toMatchObject({
      ok: true,
      loggedRows: 2,
      rowsAtProposed: 2,
      loggedRowsNotReady: 0,
      blockedOrUnchangedRowsDifferingFromOriginal: 0,
      cogs: { before: "90.00", after: "104.00", live: "104.00" },
    });
  });

  it("is idempotent on retry and never double-applies", async () => {
    const input = await applyInput();
    await applyHistoricalSalesCostPartialWithClient(client, input, deps);
    const again = await applyHistoricalSalesCostPartialWithClient(client, input, deps);
    expect(again).toMatchObject({ alreadyApplied: true, appliedRows: 2 });
    expect(await counts()).toEqual({ partials: 1, logs: 2 });
    expect(await sale(101)).toEqual({ cost_price: "12.00", total_cost: "24.00", profit: "1.00" });
  });

  it("rolls back exactly, audits the rollback, and refuses to re-apply the same run", async () => {
    const input = await applyInput();
    await applyHistoricalSalesCostPartialWithClient(client, input, deps);
    const rolled = await rollbackHistoricalSalesCostPartialWithClient(client, rollbackInput);
    expect(rolled).toMatchObject({ restoredRows: 2, alreadyRolledBack: false });
    expect(await sale(101)).toEqual({ cost_price: "10.00", total_cost: "20.00", profit: "5.00" });
    expect(await sale(102)).toEqual({ cost_price: "7.00", total_cost: "70.00", profit: "30.00" });

    const record = await client.query(
      "SELECT status,rolled_back_by FROM historical_sales_cost_repair_partial_applies WHERE run_id=1"
    );
    expect(record.rows[0]).toEqual({ status: "rolled_back", rolled_back_by: "test" });
    const log = await client.query(
      "SELECT COUNT(*)::int AS n FROM historical_sales_cost_repair_apply_log WHERE rolled_back_at IS NOT NULL"
    );
    expect(log.rows[0].n).toBe(2);
    expect((await verifyHistoricalSalesCostPartialApplyWithClient(client, 1)).ok).toBe(true);

    expect(await rollbackHistoricalSalesCostPartialWithClient(client, rollbackInput)).toMatchObject({
      alreadyRolledBack: true,
    });
    await expect(applyHistoricalSalesCostPartialWithClient(client, input, deps)).rejects.toThrow(
      "HSCR_PARTIAL_APPLY_ALREADY_ROLLED_BACK"
    );
  });

  it("refuses rollback when a repaired row changed after apply", async () => {
    await applyHistoricalSalesCostPartialWithClient(client, await applyInput(), deps);
    await client.query("UPDATE sales_items SET cost_price=99 WHERE id=102");
    await expect(rollbackHistoricalSalesCostPartialWithClient(client, rollbackInput)).rejects.toThrow(
      "HSCR_PARTIAL_ROLLBACK_ROWS_CHANGED_SINCE_APPLY:102"
    );
    expect(await sale(101)).toEqual({ cost_price: "12.00", total_cost: "24.00", profit: "1.00" });
  });

  async function expectNoWrites() {
    expect(await counts()).toEqual({ partials: 0, logs: 0 });
    expect(await sale(101)).toEqual({ cost_price: "10.00", total_cost: "20.00", profit: "5.00" });
    expect(await sale(102)).toEqual({ cost_price: "7.00", total_cost: "70.00", profit: "30.00" });
  }

  it("fails closed when a target sale changed after the dry run", async () => {
    const input = await applyInput();
    await client.query("UPDATE sales_items SET total_cost=21 WHERE id=101");
    await expect(applyHistoricalSalesCostPartialWithClient(client, input, deps)).rejects.toThrow(
      "HSCR_PARTIAL_TARGET_ROWS_CHANGED:1:101:total-cost-changed"
    );
    expect(await counts()).toEqual({ partials: 0, logs: 0 });
    expect(await sale(102)).toEqual({ cost_price: "7.00", total_cost: "70.00", profit: "30.00" });
  });

  it("fails closed when a target sale disappeared", async () => {
    const input = await applyInput();
    await client.query("DELETE FROM sales_items WHERE id=102");
    await expect(applyHistoricalSalesCostPartialWithClient(client, input, deps)).rejects.toThrow(
      "HSCR_PARTIAL_TARGET_ROWS_MISSING:1/2"
    );
    expect(await counts()).toEqual({ partials: 0, logs: 0 });
  });

  it("fails closed when a blocked or unchanged row's sale changed", async () => {
    const input = await applyInput();
    await client.query("UPDATE sales_items SET profit=11 WHERE id=103");
    await expect(applyHistoricalSalesCostPartialWithClient(client, input, deps)).rejects.toThrow(
      "HSCR_PARTIAL_NON_TARGET_ROWS_CHANGED:1"
    );
    await expectNoWrites();
  });

  it("fails closed when V2 source evidence drifted", async () => {
    const input = await applyInput();
    evidenceHash = "evidence-2";
    await expect(applyHistoricalSalesCostPartialWithClient(client, input, deps)).rejects.toThrow(
      "HSCR_V2_SOURCE_EVIDENCE_DRIFT:1"
    );
    await expectNoWrites();
  });

  it("fails closed when historical source evidence was edited after the cutoff", async () => {
    const input = await applyInput();
    await client.query("INSERT INTO audit_log VALUES (900,1,'vouchers',10,NOW() + INTERVAL '1 minute')");
    await expect(applyHistoricalSalesCostPartialWithClient(client, input, deps)).rejects.toThrow(
      "historical-voucher-edit#900"
    );
    await expectNoWrites();
  });

  it("refuses a wrong audit hash, target hash, algorithm version or tampered row set", async () => {
    const input = await applyInput();
    const wrongAudit = {
      ...input,
      auditHash: OTHER,
      confirmation: partialApplyConfirmation(1, OTHER, input.targetHash),
    };
    await expect(applyHistoricalSalesCostPartialWithClient(client, wrongAudit, deps)).rejects.toThrow(
      "HSCR_AUDIT_HASH_MISMATCH"
    );
    const wrongTarget = await applyInput({ targetHash: OTHER });
    await expect(applyHistoricalSalesCostPartialWithClient(client, wrongTarget, deps)).rejects.toThrow(
      "HSCR_PARTIAL_TARGET_HASH_MISMATCH"
    );
    await expect(
      applyHistoricalSalesCostPartialWithClient(client, input, { ...deps, algorithmVersion: "other" })
    ).rejects.toThrow("HSCR_ALGORITHM_VERSION_MISMATCH");

    // A proposal edited after review changes the target hash.
    await client.query("UPDATE historical_sales_cost_repair_rows SET proposed_total_cost=25 WHERE sales_item_id=101");
    await expect(applyHistoricalSalesCostPartialWithClient(client, input, deps)).rejects.toThrow(
      "HSCR_PARTIAL_TARGET_HASH_MISMATCH"
    );
    // A blocked row relabelled as ready breaks the reviewed row-set counts.
    await client.query(
      "UPDATE historical_sales_cost_repair_rows SET status='ready',blocker_code=NULL,blocker_detail=NULL WHERE sales_item_id=103"
    );
    await expect(applyHistoricalSalesCostPartialWithClient(client, input, deps)).rejects.toThrow(
      "HSCR_PARTIAL_ROW_SET_INVALID:ready:3/2"
    );
    await expectNoWrites();
  });

  it("refuses when sales_items carries an unreviewed side-effect trigger", async () => {
    const input = await applyInput();
    await client.query(`
      CREATE FUNCTION hscr_test_side_effect() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN UPDATE inventory SET total_value=total_value+1; RETURN NEW; END $$;
      CREATE TRIGGER hscr_test_side_effect AFTER UPDATE ON sales_items FOR EACH ROW EXECUTE FUNCTION hscr_test_side_effect();
    `);
    await expect(applyHistoricalSalesCostPartialWithClient(client, input, deps)).rejects.toThrow(
      "unreviewed side-effect trigger"
    );
    await expectNoWrites();
  });
});

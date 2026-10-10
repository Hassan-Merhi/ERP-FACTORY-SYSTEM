/**
 * Stock adjustments and their Inventory side (merge of main 365cf55, 2bf7351).
 *
 * main posted an Inventory line on every new stock adjustment and balanced the
 * old one-sided vouchers in a boot step. On this branch (accounting audit
 * waves 8.3, 11, 12 and 16 A):
 *   - before a company's perpetual cut-over a stock adjustment stays periodic:
 *     its STOCK_ADJUSTMENT line only (one net line for a Mixed voucher), the
 *     stock sub-ledger carrying the contra; from the cut-over the value-exact
 *     inventory line is posted by syncStockAdjustmentInventoryTx (tests in
 *     perpetual-inventory-stock-adjustments and wave11-*);
 *   - nothing rewrites old vouchers at boot; an Owner preview/apply gives the
 *     old one-sided vouchers their Inventory line, reviewed by plan hash,
 *     closed periods skipped, audited in the transaction, never renaming or
 *     retyping the INVENTORY account.
 */
import fs from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import { firstRow, resultRows } from "../server/lib/queryResult";
import { createStockAdjustment } from "../server/storage/stock-ops/transfers-create";
import { updateStockAdjustment } from "../server/storage/stock-ops/transfers-update";
import { STOCK_ADJUSTMENT_INVENTORY_NARRATION } from "../server/services/accounting/perpetualInventory/stockAdjustments";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "sainvside";
const PLAN = "/api/accounting/stock-adjustment-inventory-side/plan";
const APPLY = "/api/accounting/stock-adjustment-inventory-side/apply";
let ctx: TestContext;
let agent: request.SuperAgentTest;
let voucherSequence = 0;

type EntryRow = { code: string | null; debit: string; credit: string; narration: string | null };

async function resetInventory(locationId: number, stockItemId: number): Promise<void> {
  await db.execute(
    sql`DELETE FROM inventory_negative_layers WHERE location_id = ${locationId} AND stock_item_id = ${stockItemId}`
  );
  await db.execute(sql`DELETE FROM inventory WHERE location_id = ${locationId} AND stock_item_id = ${stockItemId}`);
}

async function seedInventory(locationId: number, stockItemId: number, quantity: number, rate: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value, last_updated)
    VALUES (${ctx.companyId}, ${locationId}, ${stockItemId}, ${quantity}, ${rate}, ${quantity * rate}, NOW())
  `);
}

async function createVoucher(voucherType: string, optional = false, date = "2026-09-11"): Promise<number> {
  voucherSequence += 1;
  const result = await db.execute(sql`
    INSERT INTO vouchers
      (company_id, location_id, voucher_number, voucher_type, voucher_date, total_amount, currency, optional)
    VALUES
      (${ctx.companyId}, ${ctx.locationId}, ${`${TEST_PREFIX}-${voucherType}-${voucherSequence}`}, ${voucherType},
       ${date}, 0, 'USD', ${optional})
    RETURNING id
  `);
  const row = firstRow<{ id: number }>(result);
  if (!row) throw new Error("Failed to create test voucher");
  return row.id;
}

async function readEntries(voucherId: number): Promise<EntryRow[]> {
  const result = await db.execute(sql`
    SELECT la.code, COALESCE(ve.debit_amount, 0)::text AS debit, COALESCE(ve.credit_amount, 0)::text AS credit,
           ve.narration
    FROM voucher_entries ve
    LEFT JOIN ledger_accounts la ON la.id = ve.ledger_account_id
    WHERE ve.voucher_id = ${voucherId}
    ORDER BY ve.id
  `);
  return resultRows<EntryRow>(result);
}

function sideTotals(entries: EntryRow[], code: string): { debit: number; credit: number } {
  const lines = entries.filter((entry) => entry.code === code);
  return {
    debit: lines.reduce((sum, entry) => sum + Number(entry.debit), 0),
    credit: lines.reduce((sum, entry) => sum + Number(entry.credit), 0),
  };
}

function expectBalanced(entries: EntryRow[]): void {
  const debit = entries.reduce((sum, entry) => sum + Math.round(Number(entry.debit) * 100), 0);
  const credit = entries.reduce((sum, entry) => sum + Math.round(Number(entry.credit) * 100), 0);
  expect(debit).toBe(credit);
}

async function ledgerAccount(code: string): Promise<{ id: number; account_type: string; name: string } | undefined> {
  const result = await db.execute(sql`
    SELECT id, account_type, name FROM ledger_accounts WHERE company_id = ${ctx.companyId} AND code = ${code}
  `);
  return firstRow<{ id: number; account_type: string; name: string }>(result);
}

/** A voucher as the old code left it: the adjustment row and one Stock Adjustment line only. */
async function createLegacyOneSidedVoucher(
  side: "production" | "consumption",
  amount: string,
  options: { optional?: boolean; extraNonLedgerLine?: boolean; date?: string } = {}
): Promise<number> {
  const type = side === "production" ? "Production" : "Consumption";
  const voucherId = await createVoucher(type, options.optional, options.date);
  const adjustmentAccount = await ledgerAccount("STOCK_ADJUSTMENT");
  if (!adjustmentAccount) throw new Error("STOCK_ADJUSTMENT account missing");
  await withFixtureTransaction(
    async (client) => {
      await client.query(
        `INSERT INTO stock_adjustment_vouchers (voucher_id, location_id, adjustment_type, notes)
         VALUES ($1, $2, $3, 'legacy')`,
        [voucherId, ctx.locationId, type]
      );
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, company_id, ledger_account_id, debit_amount, credit_amount, narration)
         VALUES ($1, $2, $3, $4, $5, 'legacy line')`,
        [
          voucherId,
          ctx.companyId,
          adjustmentAccount.id,
          side === "consumption" ? amount : "0",
          side === "production" ? amount : "0",
        ]
      );
      if (options.extraNonLedgerLine) {
        await client.query(
          `INSERT INTO voucher_entries (voucher_id, company_id, debit_amount, credit_amount, narration)
           VALUES ($1, $2, '1.00', '0', 'unrelated non-ledger line')`,
          [voucherId, ctx.companyId]
        );
      }
    },
    { legacyUnbalanced: true }
  );
  return voucherId;
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  await pool.query(`UPDATE user_company_roles SET role = 'Owner' WHERE user_id = $1 AND company_id = $2`, [
    ctx.userId,
    ctx.companyId,
  ]);
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  // The Stock Adjustment account exists, as it does for any company with old adjustments.
  const seedVoucher = await createVoucher("Production");
  await createStockAdjustment(seedVoucher, ctx.locationId, "Production", "seed", [
    { stockItemId: ctx.stockItemIds[0], quantity: "1", rate: "1" },
  ]);
}, 120_000);

afterAll(async () => {
  await pool.query(`DELETE FROM fiscal_period_closures WHERE company_id = $1`, [ctx.companyId]);
  await deleteAuditLogRowsForTests(pool, "company_id = $1", [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60_000);

beforeEach(async () => {
  for (const stockItemId of ctx.stockItemIds) await resetInventory(ctx.locationId, stockItemId);
});

describe("new stock adjustments before the cut-over stay periodic", () => {
  it("posts a production adjustment on Stock Adjustment only; the sub-ledger carries the contra", async () => {
    const voucherId = await createVoucher("Production");
    await createStockAdjustment(voucherId, ctx.locationId, "Production", "made", [
      { stockItemId: ctx.stockItemIds[0], quantity: "3", rate: "1.115" },
    ]);
    const entries = await readEntries(voucherId);
    expect(sideTotals(entries, "STOCK_ADJUSTMENT")).toEqual({ debit: 0, credit: 3.35 });
    expect(sideTotals(entries, "INVENTORY")).toEqual({ debit: 0, credit: 0 });
  });

  it("posts a mixed adjustment as one net line and keeps it so through an edit", async () => {
    const consumedItemId = ctx.stockItemIds[2];
    await seedInventory(ctx.locationId, consumedItemId, 100, 10);
    const voucherId = await createVoucher("Mixed");
    const created = await createStockAdjustment(voucherId, ctx.locationId, "Mixed", "convert", [
      { stockItemId: ctx.stockItemIds[0], quantity: "5", rate: "30" },
      { stockItemId: consumedItemId, quantity: "-10", rate: "10" },
    ]);
    let entries = await readEntries(voucherId);
    expect(entries).toHaveLength(1);
    expect(sideTotals(entries, "STOCK_ADJUSTMENT")).toEqual({ debit: 0, credit: 50 });

    await updateStockAdjustment(created.adjustment.id, ctx.locationId, "Mixed", "convert more", [
      { stockItemId: ctx.stockItemIds[0], quantity: "6", rate: "30" },
      { stockItemId: consumedItemId, quantity: "-20", rate: "10" },
    ]);
    entries = await readEntries(voucherId);
    expect(entries).toHaveLength(1);
    expect(sideTotals(entries, "STOCK_ADJUSTMENT")).toEqual({ debit: 20, credit: 0 });
  });

  it("posts nothing to the ledger for an optional adjustment", async () => {
    const voucherId = await createVoucher("Production", true);
    await createStockAdjustment(voucherId, ctx.locationId, "Production", "draft", [
      { stockItemId: ctx.stockItemIds[0], quantity: "1", rate: "5" },
    ]);
    expect(await readEntries(voucherId)).toHaveLength(0);
  });
});

describe("old one-sided stock adjustment vouchers: Owner preview/apply, never at boot", () => {
  it("is not a boot step", () => {
    const index = fs.readFileSync(path.join(__dirname, "../server/index.ts"), "utf8");
    expect(index).not.toMatch(/backfillStockAdjustmentInventorySide|stockAdjustmentInventoryBackfill/);
    expect(fs.existsSync(path.join(__dirname, "../server/startup/stockAdjustmentInventoryBackfill.ts"))).toBe(false);
  });

  it("refuses a request that is not signed in", async () => {
    expect((await request(ctx.app).get(PLAN)).status).toBe(401);
    expect(
      (
        await request(ctx.app)
          .post(APPLY)
          .send({ confirm: true, planHash: "0".repeat(64) })
      ).status
    ).toBe(401);
  });

  it("previews, refuses a changed plan, skips a closed period, applies once with audit", async () => {
    const production = await createLegacyOneSidedVoucher("production", "12.34");
    const consumption = await createLegacyOneSidedVoucher("consumption", "5.67");
    const optional = await createLegacyOneSidedVoucher("production", "9.99", { optional: true });
    const withOtherLine = await createLegacyOneSidedVoucher("production", "4.00", { extraNonLedgerLine: true });
    const closed = await createLegacyOneSidedVoucher("production", "3.00", { date: "2025-01-10" });
    await pool.query(
      `INSERT INTO fiscal_period_closures (company_id, period_start_date, period_end_date, closed_by_user_id,
         closing_voucher_id, retained_earnings_account_id, total_income, total_expense, net_income, status)
       VALUES ($1, '2025-01-01', '2025-01-31', $2, $3, $4, 0, 0, 0, 'CLOSED')`,
      [ctx.companyId, ctx.userId, closed, ctx.cashAccountId]
    );

    const preview = await agent.get(PLAN);
    expect(preview.status).toBe(200);
    expect(preview.body.blockers).toEqual([]);
    const planned = new Map(
      preview.body.vouchers.map((row: { voucherId: number; inventoryLine: unknown }) => [
        row.voucherId,
        row.inventoryLine,
      ])
    );
    expect(planned.get(production)).toEqual({ side: "debit", amount: "12.34" });
    expect(planned.get(consumption)).toEqual({ side: "credit", amount: "5.67" });
    expect(planned.has(optional)).toBe(false);
    expect(planned.has(withOtherLine)).toBe(false);
    expect(planned.has(closed)).toBe(false);
    expect(preview.body.skipped).toContainEqual(
      expect.objectContaining({ voucherId: closed, reason: "PERIOD_CLOSED" })
    );
    // Reading changed nothing.
    expect(sideTotals(await readEntries(production), "INVENTORY")).toEqual({ debit: 0, credit: 0 });

    expect((await agent.post(APPLY).send({ planHash: preview.body.planHash })).status).toBe(400);
    const stale = await agent.post(APPLY).send({ confirm: true, planHash: "0".repeat(64) });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("PLAN_CHANGED");

    const applied = await agent.post(APPLY).send({ confirm: true, planHash: preview.body.planHash });
    expect(applied.status).toBe(200);

    const productionEntries = await readEntries(production);
    expect(sideTotals(productionEntries, "INVENTORY")).toEqual({ debit: 12.34, credit: 0 });
    expect(productionEntries.find((entry) => entry.code === "INVENTORY")?.narration).toBe(
      STOCK_ADJUSTMENT_INVENTORY_NARRATION
    );
    expectBalanced(productionEntries);
    const consumptionEntries = await readEntries(consumption);
    expect(sideTotals(consumptionEntries, "INVENTORY")).toEqual({ debit: 0, credit: 5.67 });
    expectBalanced(consumptionEntries);
    expect(sideTotals(await readEntries(optional), "INVENTORY")).toEqual({ debit: 0, credit: 0 });
    expect(sideTotals(await readEntries(withOtherLine), "INVENTORY")).toEqual({ debit: 0, credit: 0 });
    expect(sideTotals(await readEntries(closed), "INVENTORY")).toEqual({ debit: 0, credit: 0 });

    const { rows: audits } = await pool.query(
      `SELECT changes FROM audit_log WHERE company_id = $1 AND record_identifier = 'stock-adjustment-inventory-side'`,
      [ctx.companyId]
    );
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0].changes)).toContain(String(production));

    const again = await agent.get(PLAN);
    expect(again.body.vouchers).toEqual([]);
    const nothing = await agent.post(APPLY).send({ confirm: true, planHash: again.body.planHash });
    expect(nothing.status).toBe(400);
    expect(nothing.body.code).toBe("NOTHING_TO_APPLY");
  });

  it("never renames or retypes an old credit-note INVENTORY row: the plan is blocked", async () => {
    await db.execute(sql`
      UPDATE ledger_accounts SET name = 'Credit Note - Customer Return', account_type = 'Indirect Expense', sub_type = ''
      WHERE company_id = ${ctx.companyId} AND code = 'INVENTORY'
    `);
    await createLegacyOneSidedVoucher("consumption", "1.00");
    try {
      const preview = await agent.get(PLAN);
      expect(preview.body.blockers.map((b: { code: string }) => b.code)).toContain("INVENTORY_ACCOUNT_NEEDS_REVIEW");
      const refused = await agent.post(APPLY).send({ confirm: true, planHash: preview.body.planHash });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe("PLAN_BLOCKED");
      const account = await ledgerAccount("INVENTORY");
      expect(account?.account_type).toBe("Indirect Expense");
      expect(account?.name).toBe("Credit Note - Customer Return");
    } finally {
      await db.execute(sql`
        UPDATE ledger_accounts SET name = 'Inventory', account_type = 'Asset', sub_type = 'Current Asset'
        WHERE company_id = ${ctx.companyId} AND code = 'INVENTORY'
      `);
    }
  });
});

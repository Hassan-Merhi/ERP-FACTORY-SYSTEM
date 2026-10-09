import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";
import { firstRow, resultRows } from "../server/lib/queryResult";
import { createStockAdjustment } from "../server/storage/stock-ops/transfers-create";
import { updateStockAdjustment } from "../server/storage/stock-ops/transfers-update";
import { backfillStockAdjustmentInventorySide } from "../server/startup/stockAdjustmentInventoryBackfill";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "sainvside";
let ctx: TestContext;
let voucherSequence = 0;

type EntryRow = { code: string | null; debit: string; credit: string };

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

async function createVoucher(voucherType: string, optional = false): Promise<number> {
  voucherSequence += 1;
  const result = await db.execute(sql`
    INSERT INTO vouchers
      (company_id, location_id, voucher_number, voucher_type, voucher_date, total_amount, currency, optional)
    VALUES
      (${ctx.companyId}, ${ctx.locationId}, ${`${TEST_PREFIX}-${voucherType}-${voucherSequence}`}, ${voucherType},
       '2026-09-11', 0, 'USD', ${optional})
    RETURNING id
  `);
  const row = firstRow<{ id: number }>(result);
  if (!row) throw new Error("Failed to create test voucher");
  return row.id;
}

async function readEntries(voucherId: number): Promise<EntryRow[]> {
  const result = await db.execute(sql`
    SELECT la.code, COALESCE(ve.debit_amount, 0)::text AS debit, COALESCE(ve.credit_amount, 0)::text AS credit
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
  const debit = entries.reduce((sum, entry) => sum + Number(entry.debit) * 100, 0);
  const credit = entries.reduce((sum, entry) => sum + Number(entry.credit) * 100, 0);
  expect(Math.round(debit)).toBe(Math.round(credit));
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
  options: { optional?: boolean; extraNonLedgerLine?: boolean } = {}
): Promise<number> {
  const voucherId = await createVoucher(side === "production" ? "Production" : "Consumption", options.optional);
  await db.execute(sql`
    INSERT INTO stock_adjustment_vouchers (voucher_id, location_id, adjustment_type, notes)
    VALUES (${voucherId}, ${ctx.locationId}, ${side === "production" ? "Production" : "Consumption"}, 'legacy')
  `);
  const adjustmentAccount = await ledgerAccount("STOCK_ADJUSTMENT");
  if (!adjustmentAccount) throw new Error("STOCK_ADJUSTMENT account missing");
  await db.execute(sql`
    INSERT INTO voucher_entries (voucher_id, company_id, ledger_account_id, debit_amount, credit_amount, narration)
    VALUES (${voucherId}, ${ctx.companyId}, ${adjustmentAccount.id},
            ${side === "consumption" ? amount : "0"}, ${side === "production" ? amount : "0"}, 'legacy line')
  `);
  if (options.extraNonLedgerLine) {
    await db.execute(sql`
      INSERT INTO voucher_entries (voucher_id, company_id, debit_amount, credit_amount, narration)
      VALUES (${voucherId}, ${ctx.companyId}, '1.00', '0', 'unrelated non-ledger line')
    `);
  }
  return voucherId;
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
}, 60_000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 30_000);

beforeEach(async () => {
  for (const stockItemId of ctx.stockItemIds) await resetInventory(ctx.locationId, stockItemId);
});

describe("stock adjustments post a balanced Inventory side", () => {
  it("balances a production adjustment with Dr Inventory / Cr Stock Adjustment", async () => {
    const voucherId = await createVoucher("Production");
    await createStockAdjustment(voucherId, ctx.locationId, "Production", "made", [
      { stockItemId: ctx.stockItemIds[0], quantity: "3", rate: "1.115" },
    ]);

    const entries = await readEntries(voucherId);
    expect(sideTotals(entries, "INVENTORY")).toEqual({ debit: 3.35, credit: 0 });
    expect(sideTotals(entries, "STOCK_ADJUSTMENT")).toEqual({ debit: 0, credit: 3.35 });
    expectBalanced(entries);
    expect((await ledgerAccount("INVENTORY"))?.account_type).toBe("Asset");
  });

  it("balances a mixed adjustment on both sides and keeps it balanced through an edit", async () => {
    const consumedItemId = ctx.stockItemIds[2];
    await seedInventory(ctx.locationId, consumedItemId, 100, 10);

    const voucherId = await createVoucher("Mixed");
    const created = await createStockAdjustment(voucherId, ctx.locationId, "Mixed", "convert", [
      { stockItemId: ctx.stockItemIds[0], quantity: "5", rate: "30" },
      { stockItemId: consumedItemId, quantity: "-10", rate: "10" },
    ]);

    let entries = await readEntries(voucherId);
    expect(sideTotals(entries, "INVENTORY")).toEqual({ debit: 150, credit: 100 });
    expect(sideTotals(entries, "STOCK_ADJUSTMENT")).toEqual({ debit: 100, credit: 150 });
    expectBalanced(entries);

    await updateStockAdjustment(created.adjustment.id, ctx.locationId, "Mixed", "convert more", [
      { stockItemId: ctx.stockItemIds[0], quantity: "6", rate: "30" },
      { stockItemId: consumedItemId, quantity: "-20", rate: "10" },
    ]);

    entries = await readEntries(voucherId);
    expect(entries).toHaveLength(4);
    expect(sideTotals(entries, "INVENTORY")).toEqual({ debit: 180, credit: 200 });
    expect(sideTotals(entries, "STOCK_ADJUSTMENT")).toEqual({ debit: 200, credit: 180 });
    expectBalanced(entries);
  });

  it("uses the canonical INVENTORY account, never a Stock in Hand account matched by name", async () => {
    await db.execute(sql`
      INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, opening_balance, opening_balance_side)
      VALUES (${ctx.companyId}, ${`${TEST_PREFIX}-SP-STOCK`}, 'Stock in Hand', 'Asset', 'sp_stock', '0', 'Dr')
      ON CONFLICT DO NOTHING
    `);

    const voucherId = await createVoucher("Production");
    await createStockAdjustment(voucherId, ctx.locationId, "Production", "made", [
      { stockItemId: ctx.stockItemIds[1], quantity: "2", rate: "4" },
    ]);

    const entries = await readEntries(voucherId);
    expect(entries.map((entry) => entry.code).sort()).toEqual(["INVENTORY", "STOCK_ADJUSTMENT"]);
  });

  it("posts nothing to the ledger for an optional adjustment", async () => {
    const voucherId = await createVoucher("Production", true);
    await createStockAdjustment(voucherId, ctx.locationId, "Production", "draft", [
      { stockItemId: ctx.stockItemIds[0], quantity: "1", rate: "5" },
    ]);
    expect(await readEntries(voucherId)).toHaveLength(0);
  });
});

describe("boot backfill of old one-sided stock adjustment vouchers", () => {
  it("mirrors each adjustment line onto Inventory once, and leaves vouchers it should not touch alone", async () => {
    // Make sure the Stock Adjustment account exists, as it does for any company with old adjustments.
    const seedVoucher = await createVoucher("Production");
    await createStockAdjustment(seedVoucher, ctx.locationId, "Production", "seed", [
      { stockItemId: ctx.stockItemIds[0], quantity: "1", rate: "1" },
    ]);

    const production = await createLegacyOneSidedVoucher("production", "12.34");
    const consumption = await createLegacyOneSidedVoucher("consumption", "5.67");
    const optional = await createLegacyOneSidedVoucher("production", "9.99", { optional: true });
    const withOtherLine = await createLegacyOneSidedVoucher("production", "4.00", { extraNonLedgerLine: true });

    const first = await backfillStockAdjustmentInventorySide(pool);
    expect(first.balanced).toBeGreaterThanOrEqual(2);

    const productionEntries = await readEntries(production);
    expect(sideTotals(productionEntries, "INVENTORY")).toEqual({ debit: 12.34, credit: 0 });
    expectBalanced(productionEntries);

    const consumptionEntries = await readEntries(consumption);
    expect(sideTotals(consumptionEntries, "INVENTORY")).toEqual({ debit: 0, credit: 5.67 });
    expectBalanced(consumptionEntries);

    expect(sideTotals(await readEntries(optional), "INVENTORY")).toEqual({ debit: 0, credit: 0 });
    expect(sideTotals(await readEntries(withOtherLine), "INVENTORY")).toEqual({ debit: 0, credit: 0 });

    const second = await backfillStockAdjustmentInventorySide(pool);
    expect(second.balanced).toBe(0);
    expect(await readEntries(production)).toHaveLength(2);
  });

  it("turns an old credit-note INVENTORY expense row into the Inventory asset", async () => {
    await db.execute(sql`
      UPDATE ledger_accounts SET name = 'Credit Note - Customer Return', account_type = 'Indirect Expense', sub_type = ''
      WHERE company_id = ${ctx.companyId} AND code = 'INVENTORY'
    `);
    await createLegacyOneSidedVoucher("consumption", "1.00");

    await backfillStockAdjustmentInventorySide(pool);

    const account = await ledgerAccount("INVENTORY");
    expect(account?.account_type).toBe("Asset");
    expect(account?.name).toBe("Inventory");
  });
});

/**
 * Mali POS: a CFA sale, edit or import that carries its typed CFA prices posts
 * their exact sum on both ledger entries; anything else keeps the previous
 * posting (USD total x rate). Runs against the real routes and database.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "malicfapost";
const RATE = "613";

let ctx: TestContext;
let agent: request.SuperAgentTest;

const today = () => new Date().toISOString().split("T")[0];
const usd = (cfa: number, rate = Number(RATE)) => (cfa / rate).toFixed(6);

function voucherIdFrom(body: Record<string, any>): number {
  return Number(body?.voucher?.id ?? body?.voucherId ?? body?.id);
}

async function posted(voucherId: number) {
  const voucher = (
    await pool.query<{ currency: string; rate: string; total: string }>(
      `SELECT currency, exchange_rate::text AS rate, total_amount::text AS total FROM vouchers WHERE id = $1`,
      [voucherId]
    )
  ).rows[0];
  const entries = (
    await pool.query<{ ccy: string; tx_debit: string; tx_credit: string; debit: string; credit: string }>(
      `SELECT transaction_currency AS ccy, transaction_debit_amount::text AS tx_debit,
              transaction_credit_amount::text AS tx_credit, debit_amount::text AS debit, credit_amount::text AS credit
         FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
      [voucherId]
    )
  ).rows;
  const prices = (
    await pool.query<{ price: string }>(
      `SELECT selling_price::text AS price FROM sales_items WHERE voucher_id = $1 ORDER BY id`,
      [voucherId]
    )
  ).rows.map((row) => row.price);
  return {
    voucher,
    prices,
    cfaDebit: entries.reduce((sum, e) => sum + Number(e.tx_debit), 0),
    cfaCredit: entries.reduce((sum, e) => sum + Number(e.tx_credit), 0),
    usdDebit: entries.reduce((sum, e) => sum + Number(e.debit), 0).toFixed(2),
    usdCredit: entries.reduce((sum, e) => sum + Number(e.credit), 0).toFixed(2),
    currencies: [...new Set(entries.map((e) => e.ccy))],
  };
}

async function sell(items: Array<Record<string, unknown>>, rate = RATE) {
  const res = await agent.post("/api/pos/sales").send({
    locationId: ctx.locationId,
    items,
    paymentAccountType: "ledger",
    paymentAccountId: ctx.cashAccountId,
    voucherDate: today(),
    currency: "CFA",
    exchangeRate: rate,
  });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return voucherIdFrom(res.body);
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  await db.update(schema.companies).set({ displayCurrency: "CFA" }).where(eq(schema.companies.id, ctx.companyId));
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  for (const stockItemId of ctx.stockItemIds.slice(0, 2)) {
    await db
      .insert(schema.inventory)
      .values({
        companyId: ctx.companyId,
        locationId: ctx.locationId,
        stockItemId,
        quantity: "5000.000",
        averageRate: "10.00",
        totalValue: "50000.00",
      })
      .onConflictDoUpdate({
        target: [schema.inventory.locationId, schema.inventory.stockItemId],
        set: { quantity: "5000.000", averageRate: "10.00", totalValue: "50000.00" },
      });
  }
}, 60000);

afterAll(async () => {
  await pool.query(`DELETE FROM canonical_stock_movement_audit WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM canonical_stock_movement_requests WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM canonical_stock_movements WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 30000);

describe("Mali POS CFA posting", () => {
  it("posts the exact CFA typed when a new sale carries its CFA prices", async () => {
    const [a, b] = ctx.stockItemIds;
    const voucherId = await sell([
      { stockItemId: a, quantity: 40, rate: usd(40000), originalCurrencyRate: "40000.00" },
      { stockItemId: b, quantity: 3, rate: usd(45000), originalCurrencyRate: "45000.00" },
    ]);
    const sale = await posted(voucherId);
    // 40 x 40,000 + 3 x 45,000; the previous posting gave 2,830.34 x 613 = 1,734,998.42.
    expect(sale.cfaDebit).toBe(1735000);
    expect(sale.cfaCredit).toBe(1735000);
    expect(sale.currencies).toEqual(["CFA"]);
    expect(sale.usdDebit).toBe("2830.34");
    expect(sale.usdCredit).toBe("2830.34");
    expect(Number(sale.voucher.total).toFixed(2)).toBe("2830.34");
    expect(sale.voucher.currency).toBe("CFA");
    expect(Number(sale.voucher.rate)).toBe(613);
    expect(sale.prices).toEqual(["65.252855", "73.409462"]);
  }, 60000);

  it("keeps the previous posting for a sale without CFA prices or with one that disagrees with its USD price", async () => {
    const [a] = ctx.stockItemIds;
    const legacy = await posted(await sell([{ stockItemId: a, quantity: 1, rate: "66.12" }], "605"));
    expect(legacy.cfaDebit).toBeCloseTo(40002.6, 2);
    expect(legacy.usdDebit).toBe("66.12");

    const forged = await posted(
      await sell([{ stockItemId: a, quantity: 1, rate: "66.12", originalCurrencyRate: "400000" }], "605")
    );
    expect(forged.cfaDebit).toBeCloseTo(40002.6, 2);
    expect(forged.usdDebit).toBe("66.12");
  }, 60000);

  it("re-posts an edited sale exactly at the rate it was sold at", async () => {
    const [a] = ctx.stockItemIds;
    const voucherId = await sell([{ stockItemId: a, quantity: 5, rate: "66.12" }], "605");
    expect((await posted(voucherId)).cfaDebit).toBeCloseTo(200013, 0);

    // The edit screen sends the round CFA price the cashier typed and its six-decimal USD value.
    const exact = await agent.put(`/api/vouchers/${voucherId}/sales`).send({
      locationId: ctx.locationId,
      currency: "CFA",
      items: [{ stockItemId: a, quantity: 7, sellingPrice: usd(40000, 605), originalCurrencyRate: "40000.00" }],
      paymentAccountType: "ledger",
      paymentAccountId: ctx.cashAccountId,
    });
    expect(exact.status, JSON.stringify(exact.body)).toBe(200);
    const edited = await posted(voucherId);
    expect(edited.cfaDebit).toBe(280000);
    expect(edited.cfaCredit).toBe(280000);
    expect(edited.usdDebit).toBe("462.81");
    expect(edited.usdCredit).toBe("462.81");
    expect(Number(edited.voucher.total).toFixed(2)).toBe("462.81");
    expect(Number(edited.voucher.rate)).toBe(605);

    // A USD-priced edit (the Daybook quick edit) has no CFA prices and posts as before.
    const usdEdit = await agent.put(`/api/vouchers/${voucherId}/sales`).send({
      locationId: ctx.locationId,
      items: [{ stockItemId: a, quantity: 2, sellingPrice: "66.12" }],
      paymentAccountType: "ledger",
      paymentAccountId: ctx.cashAccountId,
    });
    expect(usdEdit.status, JSON.stringify(usdEdit.body)).toBe(200);
    const again = await posted(voucherId);
    expect(again.cfaDebit).toBeCloseTo(80005.2, 2);
    expect(again.usdDebit).toBe("132.24");
  }, 60000);

  it("posts an imported CFA sheet exactly when it carries its CFA prices", async () => {
    const codes = (
      await pool.query<{ code: string }>(`SELECT code FROM stock_items WHERE id = ANY($1::int[]) ORDER BY id`, [
        ctx.stockItemIds.slice(0, 2),
      ])
    ).rows.map((row) => row.code);
    const importSheet = (items: Array<Record<string, unknown>>) =>
      agent.post("/api/pos-import/import").send({
        locationId: ctx.locationId,
        saleDate: today(),
        cashAccountId: ctx.cashAccountId,
        currency: "CFA",
        exchangeRate: RATE,
        items,
      });

    const exact = await importSheet([
      { barcode: codes[0], quantity: 52, rate: usd(40000), originalCurrencyRate: "40000" },
      { barcode: codes[1], quantity: 2, rate: usd(75000), originalCurrencyRate: "75000" },
    ]);
    expect(exact.status, JSON.stringify(exact.body)).toBeLessThan(300);
    const sheet = await posted(voucherIdFrom(exact.body));
    expect(sheet.cfaDebit).toBe(2230000);
    expect(sheet.cfaCredit).toBe(2230000);
    expect(sheet.usdDebit).toBe("3637.85");
    expect(sheet.usdCredit).toBe("3637.85");

    // An older client's sheet: cent-rounded USD prices, no CFA prices.
    const legacy = await importSheet([{ barcode: codes[0], quantity: 10, rate: "65.25" }]);
    expect(legacy.status, JSON.stringify(legacy.body)).toBeLessThan(300);
    const old = await posted(voucherIdFrom(legacy.body));
    expect(old.cfaDebit).toBeCloseTo(399982.5, 2);
    expect(old.usdDebit).toBe("652.50");
  }, 60000);
});

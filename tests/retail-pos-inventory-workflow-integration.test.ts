/**
 * Retail POS + Inventory workflow (feature/retail-pos-inventory-workflow,
 * phases 4–8) against PostgreSQL, reconciled through the posted ledger:
 *
 *   - customer credit and split tenders post Dr cash / Dr customer / Cr revenue;
 *   - returns reverse the unpaid receivable before paying any tender back
 *     ($100 = $60 cash + $40 credit: a $30 return clears $30 of receivable, the
 *     next $30 clears the last $10 and refunds $20 cash);
 *   - damaged (non-restock) returns refund revenue but never restore stock or COGS;
 *   - customer-account credit refunds credit the ERP customer, not cash;
 *   - return idempotency refuses a reused key with a different payload;
 *   - exchanges refund at the historical price, sell at the current server
 *     price and report the real tender movement at the counter;
 *   - dispatch/receive transfers park value in RETAIL-IN-TRANSIT, never create
 *     revenue or COGS, and receive exactly once;
 *   - Retail manual Journal / Credit Note / Adjustment voucher writes are refused
 *     while automatic Retail journals stay readable and other company types are
 *     unaffected;
 *   - the Retail stock sub-ledger equals RETAIL-INVENTORY throughout.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { getCompanyBusinessDate } from "../server/lib/dateUtils";
import { ensureRetailLedgerSchema } from "../server/services/retail/retailLedgerSchema";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "retailposinvwf";
let ctx: TestContext;
let agent: request.SuperAgentTest;
let shirtId = 0; // $40, cost $16
let capId = 0; // $30, cost $10
let customerId = 0;
let shiftId = 0;
const today = () => getCompanyBusinessDate(undefined);

async function purgeRetailRows() {
  for (const table of [
    "retail_cash_movements",
    "retail_inventory_openings",
    "retail_pos_payments",
    "retail_pos_return_items",
    "retail_pos_returns",
    "retail_pos_sale_items",
    "retail_pos_sales",
    "retail_stock_movements",
    "retail_stock_operations",
    "retail_variant_inventory",
    "retail_product_variants",
    "retail_products",
    "retail_brands",
    "retail_accounting_settings",
    "pos_shifts",
  ]) {
    await pool.query(`DELETE FROM ${table} WHERE company_id = $1`, [ctx.companyId]);
  }
}

/** A voucher's lines: account code (or customer:/bank: target), debit, credit. */
async function voucherLines(voucherNumber: string) {
  return (
    await pool.query(
      `SELECT CASE WHEN ve.customer_id IS NOT NULL THEN 'customer'
                   ELSE COALESCE(la.code, 'bank:' || ve.bank_account_id::text) END AS code,
              ve.debit_amount::text AS d, ve.credit_amount::text AS c
         FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
         LEFT JOIN ledger_accounts la ON la.id = ve.ledger_account_id
        WHERE v.company_id = $1 AND v.voucher_number = $2 AND v.deleted_at IS NULL
        ORDER BY ve.id`,
      [ctx.companyId, voucherNumber]
    )
  ).rows.map((row) => ({ code: row.code, d: Number(row.d).toFixed(2), c: Number(row.c).toFixed(2) }));
}

/** Net debit balance of a system ledger account across all live vouchers. */
async function ledgerBalance(code: string): Promise<string> {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(ve.debit_amount - ve.credit_amount), 0)::numeric(20,2)::text AS balance
       FROM voucher_entries ve
       JOIN vouchers v ON v.id = ve.voucher_id
       JOIN ledger_accounts la ON la.id = ve.ledger_account_id
      WHERE v.company_id = $1 AND la.code = $2 AND v.deleted_at IS NULL`,
    [ctx.companyId, code]
  );
  return rows[0].balance;
}

/** The customer's posted receivable from voucher entries (debit positive). */
async function customerLedger(): Promise<string> {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(ve.debit_amount - ve.credit_amount), 0)::numeric(20,2)::text AS balance
       FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
      WHERE v.company_id = $1 AND ve.customer_id = $2 AND v.deleted_at IS NULL`,
    [ctx.companyId, customerId]
  );
  return rows[0].balance;
}

async function stock(variantId: number, locationId: number) {
  const { rows } = await pool.query(
    `SELECT quantity::numeric::float8 AS q, average_cost::numeric::float8 AS cost
       FROM retail_variant_inventory WHERE company_id = $1 AND variant_id = $2 AND location_id = $3`,
    [ctx.companyId, variantId, locationId]
  );
  return { q: Number(rows[0]?.q ?? 0), cost: Number(rows[0]?.cost ?? 0) };
}

async function refundsOf(saleId: number) {
  const { rows } = await pool.query(
    `SELECT method, amount::numeric(20,2)::text AS amount FROM retail_pos_payments
      WHERE company_id = $1 AND sale_id = $2 AND payment_type = 'refund' ORDER BY id`,
    [ctx.companyId, saleId]
  );
  return rows as Array<{ method: string; amount: string }>;
}

const reconciliation = async () => (await agent.get("/api/retail/financial/inventory-reconciliation")).body;

async function sell(
  key: string,
  items: Array<{ variantId: number; quantity: number }>,
  payments: unknown[],
  withCustomer = true
) {
  return agent.post("/api/pos/retail/sales").send({
    locationId: ctx.locationId,
    shiftId,
    idempotencyKey: key,
    customerId: withCustomer ? customerId : null,
    payments,
    items,
  });
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  await ensureRetailLedgerSchema(pool);
  await pool.query(`UPDATE companies SET company_type = 'retail' WHERE id = $1`, [ctx.companyId]);
  await pool.query(`UPDATE user_company_roles SET role = 'Owner' WHERE user_id = $1 AND company_id = $2`, [
    ctx.userId,
    ctx.companyId,
  ]);
  await db.insert(schema.userLocations).values([
    { userId: ctx.userId, companyId: ctx.companyId, locationId: ctx.locationId },
    { userId: ctx.userId, companyId: ctx.companyId, locationId: ctx.location2Id },
  ]);

  const [brand] = await db
    .insert(schema.retailBrands)
    .values({ companyId: ctx.companyId, name: "RPIW", normalizedName: "rpiw" })
    .returning({ id: schema.retailBrands.id });
  const [product] = await db
    .insert(schema.retailProducts)
    .values({
      companyId: ctx.companyId,
      code: "RPIW-STYLE",
      name: "Workflow Style",
      brandId: brand.id,
      imageUrls: ["https://example.com/rpiw-style.jpg"],
    })
    .returning({ id: schema.retailProducts.id });
  const variants = await db
    .insert(schema.retailProductVariants)
    .values([
      {
        companyId: ctx.companyId,
        productId: product.id,
        color: "Red",
        size: "L",
        barcode: "RPIW-SHIRT-RED-L",
        sku: "RPIW-SHIRT-RL",
        imageUrls: ["https://example.com/rpiw-red-l.jpg"],
        cost: "16.000000",
        sellingPrice: "40.000000",
      },
      {
        companyId: ctx.companyId,
        productId: product.id,
        color: "Blue",
        size: "S",
        barcode: "RPIW-CAP-BLUE-S",
        sku: "RPIW-CAP-BS",
        imageUrls: ["https://example.com/rpiw-blue-s.jpg"],
        cost: "10.000000",
        sellingPrice: "30.000000",
      },
    ])
    .returning({ id: schema.retailProductVariants.id });
  [shirtId, capId] = variants.map((variant) => variant.id);
  await db.insert(schema.retailVariantInventory).values([
    { companyId: ctx.companyId, variantId: shirtId, locationId: ctx.locationId, quantity: "20", averageCost: "16" },
    { companyId: ctx.companyId, variantId: capId, locationId: ctx.locationId, quantity: "20", averageCost: "10" },
    { companyId: ctx.companyId, variantId: shirtId, locationId: ctx.location2Id, quantity: "2", averageCost: "19" },
  ]);

  agent = request.agent(ctx.app);
  expect(
    (await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" })).status
  ).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);

  const plan = await agent.get(`/api/retail/financial/inventory-opening/preview?openingDate=${today()}`);
  expect(plan.status).toBe(200);
  const applied = await agent
    .post("/api/retail/financial/inventory-opening/apply")
    .send({ openingDate: today(), planHash: plan.body.planHash, confirm: true });
  expect(applied.status).toBe(200);

  const customer = await agent.post("/api/pos/retail/customers").send({ legalName: `${PREFIX} Customer` });
  expect(customer.status).toBe(201);
  customerId = Number(customer.body.id);

  const shift = await agent.post("/api/pos/shifts/open").send({ locationId: ctx.locationId, openingCash: 0 });
  expect(shift.status).toBe(200);
  shiftId = Number(shift.body.id);
}, 120000);

afterAll(async () => {
  await purgeRetailRows();
  await cleanupTestData(PREFIX);
  await closeTestServer();
}, 120000);

describe("Retail customer credit, split tenders and credit-first returns", () => {
  let saleId = 0;
  let capLineId = 0;

  it("refuses credit without a real customer", async () => {
    const anonymous = await sell(
      "rpiw-sale-anon-01",
      [{ variantId: capId, quantity: 1 }],
      [{ method: "credit", amount: 30 }],
      false
    );
    expect(anonymous.status).toBe(400);
    expect(anonymous.body.code).toBe("RETAIL_CREDIT_CUSTOMER_REQUIRED");
  });

  it("posts a $100 sale paid $60 cash + $40 on account to cash, the customer and revenue", async () => {
    const sale = await sell(
      "rpiw-sale-split-01",
      [
        { variantId: shirtId, quantity: 1 },
        { variantId: capId, quantity: 2 },
      ],
      [
        { method: "cash", amount: 60, tenderedAmount: 60 },
        { method: "credit", amount: 40, tenderedAmount: null },
      ]
    );
    expect(sale.status).toBe(201);
    saleId = Number(sale.body.sale.id);
    capLineId = Number(sale.body.sale.items.find((line: { variantId: number }) => line.variantId === capId).id);
    expect(sale.body.sale.totalAmount).toBe(100);
    expect(await voucherLines(`RETAIL-SALE-${saleId}`)).toEqual([
      { code: "RETAIL-CASH", d: "60.00", c: "0.00" },
      { code: "customer", d: "40.00", c: "0.00" },
      { code: "RETAIL-SALES", d: "0.00", c: "100.00" },
      { code: "RETAIL-COGS", d: "36.00", c: "0.00" },
      { code: "RETAIL-INVENTORY", d: "0.00", c: "36.00" },
    ]);
    const balance = await agent.get(`/api/pos/retail/customers/${customerId}/balance`);
    expect(balance.status).toBe(200);
    expect(balance.body.balance).toBeCloseTo(40, 2);
    expect(await customerLedger()).toBe("40.00");
  });

  it("refuses changing the customer on a posted credit sale", async () => {
    const changed = await agent.post(`/api/pos/retail/sales/${saleId}/customer`).send({ customerId: null });
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe("RETAIL_CREDIT_CUSTOMER_LOCKED");
  });

  it("finds the original sale by receipt number and by exact variant barcode", async () => {
    const byReceipt = await agent.get(`/api/pos/retail/sales/search?locationId=${ctx.locationId}&receipt=${saleId}`);
    expect(byReceipt.status).toBe(200);
    expect(byReceipt.body.map((row: { id: number }) => row.id)).toContain(saleId);
    const byBarcode = await agent.get(
      `/api/pos/retail/sales/search?locationId=${ctx.locationId}&barcode=RPIW-CAP-BLUE-S`
    );
    expect(byBarcode.status).toBe(200);
    expect(byBarcode.body.map((row: { id: number }) => row.id)).toContain(saleId);
  });

  it("reverses $30 of receivable on the first $30 return without paying cash", async () => {
    const returned = await agent.post(`/api/pos/retail/sales/${saleId}/returns`).send({
      locationId: ctx.locationId,
      shiftId,
      idempotencyKey: "rpiw-return-cap-01",
      items: [{ saleItemId: capLineId, quantity: 1 }],
    });
    expect(returned.status).toBe(201);
    expect(returned.body.refundAmount).toBe(30);
    expect(await refundsOf(saleId)).toEqual([{ method: "credit", amount: "30.00" }]);
    expect(await customerLedger()).toBe("10.00");

    const replay = await agent.post(`/api/pos/retail/sales/${saleId}/returns`).send({
      locationId: ctx.locationId,
      shiftId,
      idempotencyKey: "rpiw-return-cap-01",
      items: [{ saleItemId: capLineId, quantity: 1 }],
    });
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    const changedReplay = await agent.post(`/api/pos/retail/sales/${saleId}/returns`).send({
      locationId: ctx.locationId,
      shiftId,
      idempotencyKey: "rpiw-return-cap-01",
      items: [{ saleItemId: capLineId, quantity: 1, restock: false }],
    });
    expect(changedReplay.status).toBe(400);
    expect(await refundsOf(saleId)).toHaveLength(1);
  });

  it("clears the last $10 receivable and refunds only $20 cash on the second $30 return", async () => {
    const returned = await agent.post(`/api/pos/retail/sales/${saleId}/returns`).send({
      locationId: ctx.locationId,
      shiftId,
      idempotencyKey: "rpiw-return-cap-02",
      items: [{ saleItemId: capLineId, quantity: 1 }],
    });
    expect(returned.status).toBe(201);
    expect(await refundsOf(saleId)).toEqual([
      { method: "credit", amount: "30.00" },
      { method: "credit", amount: "10.00" },
      { method: "cash", amount: "20.00" },
    ]);
    expect(await customerLedger()).toBe("0.00");
    const returnId = Number(returned.body.returnId);
    expect(await voucherLines(`RETAIL-RETURN-${returnId}`)).toEqual(
      expect.arrayContaining([
        { code: "RETAIL-SALES", d: "30.00", c: "0.00" },
        { code: "customer", d: "0.00", c: "10.00" },
        { code: "RETAIL-CASH", d: "0.00", c: "20.00" },
        { code: "RETAIL-INVENTORY", d: "10.00", c: "0.00" },
        { code: "RETAIL-COGS", d: "0.00", c: "10.00" },
      ])
    );
    // Both caps are back in sellable stock at their sale cost.
    expect((await stock(capId, ctx.locationId)).q).toBe(20);
    expect(await reconciliation()).toMatchObject({ difference: "0.00" });
  });
});

describe("Damaged returns and customer-account credit refunds", () => {
  it("refunds a damaged item without restoring stock or reversing COGS", async () => {
    const before = await stock(shirtId, ctx.locationId);
    const sale = await sell(
      "rpiw-sale-damaged-01",
      [{ variantId: shirtId, quantity: 1 }],
      [{ method: "cash", amount: 40, tenderedAmount: 40 }]
    );
    expect(sale.status).toBe(201);
    const saleId = Number(sale.body.sale.id);
    const returned = await agent.post(`/api/pos/retail/sales/${saleId}/returns`).send({
      locationId: ctx.locationId,
      shiftId,
      idempotencyKey: "rpiw-return-damaged-01",
      notes: "Torn seam",
      items: [{ saleItemId: Number(sale.body.sale.items[0].id), quantity: 1, restock: false }],
    });
    expect(returned.status).toBe(201);
    const returnId = Number(returned.body.returnId);
    expect(await stock(shirtId, ctx.locationId)).toEqual({ q: before.q - 1, cost: before.cost });
    const lines = await voucherLines(`RETAIL-RETURN-${returnId}`);
    expect(lines).toEqual([
      { code: "RETAIL-SALES", d: "40.00", c: "0.00" },
      { code: "RETAIL-CASH", d: "0.00", c: "40.00" },
    ]);
    const movement = await pool.query(
      `SELECT quantity_delta::numeric::float8 AS delta, metadata FROM retail_stock_movements
        WHERE company_id = $1 AND reference_type = 'retail_pos_return' AND reference_id = $2`,
      [ctx.companyId, returnId]
    );
    expect(movement.rows).toHaveLength(1);
    expect(movement.rows[0].delta).toBe(0);
    expect(movement.rows[0].metadata).toMatchObject({ restocked: false, returnedQuantity: 1 });
    expect(await reconciliation()).toMatchObject({ difference: "0.00" });
  });

  it("credits the customer's ERP account instead of paying cash when asked", async () => {
    const sale = await sell(
      "rpiw-sale-acct-credit-01",
      [{ variantId: capId, quantity: 1 }],
      [{ method: "card", amount: 30 }]
    );
    expect(sale.status).toBe(201);
    const saleId = Number(sale.body.sale.id);
    const before = Number(await customerLedger());
    const returned = await agent.post(`/api/pos/retail/sales/${saleId}/returns`).send({
      locationId: ctx.locationId,
      shiftId,
      idempotencyKey: "rpiw-return-acct-credit-01",
      refundDestination: "customer_credit",
      items: [{ saleItemId: Number(sale.body.sale.items[0].id), quantity: 1 }],
    });
    expect(returned.status).toBe(201);
    expect(await refundsOf(saleId)).toEqual([{ method: "store_credit", amount: "30.00" }]);
    // The customer ledger now holds this credit, so the sale's customer is locked.
    const reassigned = await agent.post(`/api/pos/retail/sales/${saleId}/customer`).send({ customerId: null });
    expect(reassigned.status).toBe(409);
    expect(reassigned.body.code).toBe("RETAIL_CREDIT_CUSTOMER_LOCKED");
    expect(Number(await customerLedger())).toBeCloseTo(before - 30, 2);
    expect(await voucherLines(`RETAIL-RETURN-${returned.body.returnId}`)).toEqual(
      expect.arrayContaining([{ code: "customer", d: "0.00", c: "30.00" }])
    );
  });
});

describe("Exchanges", () => {
  it("refunds the historical price, sells at the current price and reports the real counter movement", async () => {
    const sale = await sell(
      "rpiw-sale-exch-01",
      [{ variantId: capId, quantity: 1 }],
      [{ method: "credit", amount: 30 }]
    );
    expect(sale.status).toBe(201);
    const saleId = Number(sale.body.sale.id);
    const ledgerBefore = Number(await customerLedger());
    await pool.query(`UPDATE retail_product_variants SET selling_price = 35 WHERE id = $1`, [capId]);
    try {
      const exchanged = await agent.post("/api/pos/retail/exchanges").send({
        idempotencyKey: "rpiw-exchange-0001",
        saleId,
        locationId: ctx.locationId,
        shiftId,
        returnItems: [{ saleItemId: Number(sale.body.sale.items[0].id), quantity: 1 }],
        newItems: [{ variantId: capId, quantity: 1 }],
        payments: [{ method: "cash", amount: 35, tenderedAmount: 35 }],
      });
      expect(exchanged.status).toBe(201);
      expect(exchanged.body).toMatchObject({
        refundValue: 30,
        receivableReversed: 30,
        tenderRefund: 0,
        newSaleTotal: 35,
        // The $30 only reduced the unpaid balance: the customer hands over $35 now.
        balanceDue: 35,
      });
      expect(Number(await customerLedger())).toBeCloseTo(ledgerBefore - 30, 2);
      expect(await refundsOf(saleId)).toEqual([{ method: "credit", amount: "30.00" }]);
    } finally {
      await pool.query(`UPDATE retail_product_variants SET selling_price = 30 WHERE id = $1`, [capId]);
    }
  });
});

describe("Two-stage transfers through RETAIL-IN-TRANSIT", () => {
  let transferId = 0;

  it("dispatches stock out of the source into the in-transit asset only", async () => {
    const source = await stock(shirtId, ctx.locationId);
    const destination = await stock(shirtId, ctx.location2Id);
    const tooMany = await agent.post("/api/pos/retail/transfers/dispatch").send({
      idempotencyKey: "rpiw-dispatch-0000",
      variantId: shirtId,
      fromLocationId: ctx.locationId,
      toLocationId: ctx.location2Id,
      quantity: source.q + 1,
    });
    expect(tooMany.status).toBe(409);

    const dispatched = await agent.post("/api/pos/retail/transfers/dispatch").send({
      idempotencyKey: "rpiw-dispatch-0001",
      variantId: shirtId,
      fromLocationId: ctx.locationId,
      toLocationId: ctx.location2Id,
      quantity: 3,
    });
    expect(dispatched.status).toBe(201);
    transferId = Number(dispatched.body.operationId);
    expect((await stock(shirtId, ctx.locationId)).q).toBe(source.q - 3);
    expect((await stock(shirtId, ctx.location2Id)).q).toBe(destination.q);
    expect(await ledgerBalance("RETAIL-IN-TRANSIT")).toBe("48.00");
    expect(await voucherLines(`RETAIL-STK-TRANSFER-dispatch-${transferId}`)).toEqual([
      { code: "RETAIL-INVENTORY", d: "0.00", c: "48.00" },
      { code: "RETAIL-IN-TRANSIT", d: "48.00", c: "0.00" },
    ]);

    const replay = await agent.post("/api/pos/retail/transfers/dispatch").send({
      idempotencyKey: "rpiw-dispatch-0001",
      variantId: shirtId,
      fromLocationId: ctx.locationId,
      toLocationId: ctx.location2Id,
      quantity: 3,
    });
    expect(replay.status).toBe(200);
    const changed = await agent.post("/api/pos/retail/transfers/dispatch").send({
      idempotencyKey: "rpiw-dispatch-0001",
      variantId: shirtId,
      fromLocationId: ctx.locationId,
      toLocationId: ctx.location2Id,
      quantity: 2,
    });
    expect(changed.status).toBe(400);
    expect((await stock(shirtId, ctx.locationId)).q).toBe(source.q - 3);

    const pending = await agent.get("/api/pos/retail/transfers/workflow?status=otw");
    expect(pending.status).toBe(200);
    expect(pending.body).toEqual([
      expect.objectContaining({
        id: transferId,
        status: "otw",
        variantId: shirtId,
        color: "Red",
        size: "L",
        barcode: "RPIW-SHIRT-RED-L",
        imageUrls: ["https://example.com/rpiw-red-l.jpg", "https://example.com/rpiw-style.jpg"],
      }),
    ]);
    expect(await reconciliation()).toMatchObject({ difference: "0.00" });
  });

  it("receives exactly once into the destination at the source cost, clearing in-transit", async () => {
    const before = await stock(shirtId, ctx.location2Id); // 2 @ 19
    // Two receivers race: the row lock lets exactly one receipt through.
    const concurrent = await Promise.all([
      agent.post(`/api/pos/retail/transfers/${transferId}/receive`).send({ idempotencyKey: "rpiw-receive-0001" }),
      agent.post(`/api/pos/retail/transfers/${transferId}/receive`).send({ idempotencyKey: "rpiw-receive-0002" }),
    ]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([201, 409]);
    const winner = concurrent[0].status === 201 ? "rpiw-receive-0001" : "rpiw-receive-0002";
    const replay = await agent.post(`/api/pos/retail/transfers/${transferId}/receive`).send({ idempotencyKey: winner });
    expect(replay.status).toBe(200);

    const after = await stock(shirtId, ctx.location2Id);
    expect(after.q).toBe(before.q + 3);
    // (2 × 19 + 3 × 16) / 5 = 17.2 weighted average.
    expect(after.cost).toBeCloseTo(17.2, 6);
    expect(await ledgerBalance("RETAIL-IN-TRANSIT")).toBe("0.00");
    expect(await voucherLines(`RETAIL-STK-TRANSFER-receive-${transferId}`)).toEqual([
      { code: "RETAIL-INVENTORY", d: "48.00", c: "0.00" },
      { code: "RETAIL-IN-TRANSIT", d: "0.00", c: "48.00" },
    ]);
    const movements = await pool.query(
      `SELECT movement_type, quantity_delta::numeric::float8 AS delta FROM retail_stock_movements
        WHERE company_id = $1 AND reference_type = 'retail_transfer' AND reference_id = $2 ORDER BY id`,
      [ctx.companyId, transferId]
    );
    expect(movements.rows).toEqual([
      { movement_type: "transfer_out", delta: -3 },
      { movement_type: "transfer_in", delta: 3 },
    ]);
    expect(await reconciliation()).toMatchObject({ difference: "0.00" });
  });

  it("still receives goods dispatched from a location that has since been closed", async () => {
    const dispatched = await agent.post("/api/pos/retail/transfers/dispatch").send({
      idempotencyKey: "rpiw-dispatch-closed-src",
      variantId: shirtId,
      fromLocationId: ctx.locationId,
      toLocationId: ctx.location2Id,
      quantity: 1,
    });
    expect(dispatched.status).toBe(201);
    await pool.query(`UPDATE locations SET active = false WHERE id = $1`, [ctx.locationId]);
    try {
      const received = await agent
        .post(`/api/pos/retail/transfers/${dispatched.body.operationId}/receive`)
        .send({ idempotencyKey: "rpiw-receive-closed-src" });
      expect(received.status).toBe(201);
    } finally {
      await pool.query(`UPDATE locations SET active = true WHERE id = $1`, [ctx.locationId]);
    }
    expect(await ledgerBalance("RETAIL-IN-TRANSIT")).toBe("0.00");
  });

  it("never books revenue or COGS for transfers", async () => {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM voucher_entries ve
         JOIN vouchers v ON v.id = ve.voucher_id
         JOIN ledger_accounts la ON la.id = ve.ledger_account_id
        WHERE v.company_id = $1 AND v.voucher_number LIKE 'RETAIL-STK-TRANSFER-%'
          AND la.code IN ('RETAIL-SALES', 'RETAIL-COGS')`,
      [ctx.companyId]
    );
    expect(rows[0].n).toBe(0);
  });
});

describe("Retail transfer location assignments", () => {
  // A non-manager clerk assigned only to the second store.
  let clerk: request.SuperAgentTest;
  let otherStoreTransferId = 0;

  beforeAll(async () => {
    const bcrypt = await import("bcryptjs");
    const [user] = await db
      .insert(schema.users)
      .values({ username: `${PREFIX}_storeclerk`, password: await bcrypt.hash("testpassword123", 10) })
      .returning({ id: schema.users.id });
    await db.insert(schema.userCompanyRoles).values({ userId: user.id, companyId: ctx.companyId, role: "Normal User" });
    await pool.query(
      `INSERT INTO user_security_permissions (user_id, company_id, permission, granted_by)
       SELECT $1, company_id, permission, granted_by FROM user_security_permissions WHERE user_id = $2`,
      [user.id, ctx.userId]
    );
    // Normal Users reach the Retail stock screens through the company's POS module grant.
    await pool.query(
      `INSERT INTO role_feature_permissions (company_id, role, feature_key, enabled)
       VALUES ($1, 'Normal User', 'mod_pos', true) ON CONFLICT DO NOTHING`,
      [ctx.companyId]
    );
    await db
      .insert(schema.userLocations)
      .values({ userId: user.id, companyId: ctx.companyId, locationId: ctx.location2Id });
    clerk = request.agent(ctx.app);
    expect(
      (await clerk.post("/api/auth/login").send({ username: `${PREFIX}_storeclerk`, password: "testpassword123" }))
        .status
    ).toBe(200);
    expect((await clerk.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);

    // A manager ships main → second: the clerk may receive it, but may not ship from main.
    const shipped = await agent.post("/api/pos/retail/transfers/dispatch").send({
      idempotencyKey: "rpiw-dispatch-to-clerk",
      variantId: shirtId,
      fromLocationId: ctx.locationId,
      toLocationId: ctx.location2Id,
      quantity: 1,
    });
    expect(shipped.status).toBe(201);
    otherStoreTransferId = Number(shipped.body.operationId);
  });

  it("refuses shipping from, or moving stock into, a store the clerk is not assigned to", async () => {
    const dispatchFromMain = await clerk.post("/api/pos/retail/transfers/dispatch").send({
      idempotencyKey: "rpiw-clerk-dispatch-main",
      variantId: shirtId,
      fromLocationId: ctx.locationId,
      toLocationId: ctx.location2Id,
      quantity: 1,
    });
    expect(dispatchFromMain.status).toBe(403);
    expect(dispatchFromMain.body.code).toBe("RETAIL_LOCATION_NOT_ASSIGNED");
    const immediateIntoMain = await clerk.post("/api/pos/retail/transfers").send({
      idempotencyKey: "rpiw-clerk-immediate-main",
      variantId: shirtId,
      fromLocationId: ctx.location2Id,
      toLocationId: ctx.locationId,
      quantity: 1,
    });
    expect(immediateIntoMain.status).toBe(403);
  });

  it("lets the clerk receive at, and ship from, the assigned store", async () => {
    const received = await clerk
      .post(`/api/pos/retail/transfers/${otherStoreTransferId}/receive`)
      .send({ idempotencyKey: "rpiw-clerk-receive-0001" });
    expect(received.status).toBe(201);
    const shipped = await clerk.post("/api/pos/retail/transfers/dispatch").send({
      idempotencyKey: "rpiw-clerk-dispatch-second",
      variantId: shirtId,
      fromLocationId: ctx.location2Id,
      toLocationId: ctx.locationId,
      quantity: 1,
    });
    expect(shipped.status).toBe(201);
    // The main store, not the clerk, confirms that shipment's arrival.
    const notTheirs = await clerk
      .post(`/api/pos/retail/transfers/${shipped.body.operationId}/receive`)
      .send({ idempotencyKey: "rpiw-clerk-receive-0002" });
    expect(notTheirs.status).toBe(403);
    const pendingForClerk = await clerk.get("/api/pos/retail/transfers/workflow?status=all");
    expect(pendingForClerk.status).toBe(200);
    expect(
      pendingForClerk.body.every(
        (row: { fromLocationId: number; toLocationId: number }) =>
          row.fromLocationId === ctx.location2Id || row.toLocationId === ctx.location2Id
      )
    ).toBe(true);
    const managerReceives = await agent
      .post(`/api/pos/retail/transfers/${shipped.body.operationId}/receive`)
      .send({ idempotencyKey: "rpiw-manager-receive-clerk" });
    expect(managerReceives.status).toBe(201);
    expect(await ledgerBalance("RETAIL-IN-TRANSIT")).toBe("0.00");
  });
});

describe("Retail manual voucher boundary", () => {
  let saleVoucherId = 0;

  beforeAll(async () => {
    const { rows } = await pool.query(
      `SELECT id FROM vouchers WHERE company_id = $1 AND voucher_number LIKE 'RETAIL-SALE-%' ORDER BY id LIMIT 1`,
      [ctx.companyId]
    );
    saleVoucherId = Number(rows[0].id);
  });

  it("refuses manual Journal, Credit Note and Adjustment creation", async () => {
    for (const [path, body] of [
      ["/api/vouchers/journal", {}],
      ["/api/credit-notes", {}],
      ["/api/stock-adjustments", {}],
      ["/api/vouchers", { voucherType: "Journal" }],
      ["/api/vouchers/with-entries", { voucher: { voucherType: "Credit Note" } }],
    ] as const) {
      const response = await agent.post(path).send(body);
      expect(response.status, path).toBe(403);
      expect(response.body.code, path).toBe("RETAIL_MANUAL_VOUCHER_TYPE_BLOCKED");
    }
  });

  it("keeps automatic Retail journals readable but not editable or deletable", async () => {
    expect((await agent.get(`/api/vouchers/${saleVoucherId}`)).status).toBe(200);
    for (const response of [
      await agent.patch(`/api/vouchers/${saleVoucherId}`).send({ description: "edited" }),
      await agent.patch(`/api/vouchers/${saleVoucherId}/journal`).send({}),
      await agent.delete(`/api/vouchers/${saleVoucherId}`),
      await agent.post("/api/vouchers/bulk-delete").send({ voucherIds: [saleVoucherId] }),
      await agent.post("/api/voucher-entries").send({ voucherId: saleVoucherId }),
    ]) {
      expect(response.status).toBe(403);
      expect(response.body.code).toBe("RETAIL_SYSTEM_VOUCHER_READ_ONLY");
    }
    const [entry] = (
      await pool.query(`SELECT id FROM voucher_entries WHERE voucher_id = $1 ORDER BY id LIMIT 1`, [saleVoucherId])
    ).rows;
    const entryEdit = await agent.patch(`/api/voucher-entries/${entry.id}`).send({});
    expect(entryEdit.status).toBe(403);
    const reclassified = await agent
      .post("/api/voucher-entries/transfer-account")
      .send({ entryIds: [Number(entry.id)], toAccountId: ctx.cashAccountId });
    expect(reclassified.status).toBe(403);
    expect(reclassified.body.code).toBe("RETAIL_SYSTEM_VOUCHER_READ_ONLY");
    const intact = await pool.query(`SELECT deleted_at FROM vouchers WHERE id = $1`, [saleVoucherId]);
    expect(intact.rows[0].deleted_at).toBeNull();
  });

  it("does not block Payment vouchers or non-Retail companies", async () => {
    const payment = await agent.post("/api/vouchers").send({ voucherType: "Payment" });
    expect(payment.body.code).not.toBe("RETAIL_MANUAL_VOUCHER_TYPE_BLOCKED");
    await pool.query(`UPDATE companies SET company_type = 'erp' WHERE id = $1`, [ctx.companyId]);
    try {
      const journal = await agent.post("/api/vouchers/journal").send({});
      expect(journal.body.code).not.toBe("RETAIL_MANUAL_VOUCHER_TYPE_BLOCKED");
      const creditNote = await agent.post("/api/credit-notes").send({});
      expect(creditNote.body.code).not.toBe("RETAIL_MANUAL_VOUCHER_TYPE_BLOCKED");
    } finally {
      await pool.query(`UPDATE companies SET company_type = 'retail' WHERE id = $1`, [ctx.companyId]);
    }
  });
});

describe("Final reconciliation", () => {
  it("ties Retail cash, receivables, inventory and the sales report to the posted ledger", async () => {
    // Cash: every cash tender less every cash refund equals the RETAIL-CASH ledger.
    const cash = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN payment_type = 'payment' THEN amount ELSE -amount END), 0)::numeric(20,2)::text AS net
         FROM retail_pos_payments WHERE company_id = $1 AND method = 'cash'`,
      [ctx.companyId]
    );
    expect(await ledgerBalance("RETAIL-CASH")).toBe(cash.rows[0].net);

    // Customer: on-account sales less receivable reversals less account credits.
    const receivable = await pool.query(
      `SELECT COALESCE(SUM(CASE
                WHEN method = 'credit' AND payment_type = 'payment' THEN amount
                WHEN method IN ('credit', 'store_credit') AND payment_type = 'refund' THEN -amount
                ELSE 0 END), 0)::numeric(20,2)::text AS net
         FROM retail_pos_payments WHERE company_id = $1`,
      [ctx.companyId]
    );
    expect(await customerLedger()).toBe(receivable.rows[0].net);
    const balance = await agent.get(`/api/pos/retail/customers/${customerId}/balance`);
    expect(balance.body.balance).toBeCloseTo(Number(receivable.rows[0].net), 2);

    // Inventory: sub-ledger equals RETAIL-INVENTORY; nothing is left in transit.
    expect(await reconciliation()).toMatchObject({ difference: "0.00" });
    expect(await ledgerBalance("RETAIL-IN-TRANSIT")).toBe("0.00");

    // Sales report revenue equals posted net Retail revenue (no tax/discounts here).
    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 60 * 1000).toISOString();
    const dashboard = await agent.get(
      `/api/retail/reporting/dashboard?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
    );
    expect(dashboard.status).toBe(200);
    const revenue = -Number(await ledgerBalance("RETAIL-SALES"));
    expect(Number(dashboard.body.summary.revenue)).toBeCloseTo(revenue, 2);
    const cogs = Number(await ledgerBalance("RETAIL-COGS"));
    expect(Number(dashboard.body.summary.cogs)).toBeCloseTo(cogs, 2);
  });
});

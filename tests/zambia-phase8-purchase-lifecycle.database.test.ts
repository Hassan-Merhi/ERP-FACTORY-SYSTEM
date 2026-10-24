/**
 * Zambia Phase 8: native Kwacha purchasing against a real schema.
 *
 * A USD-base / ZMW-display subsidiary buys in Kwacha. The purchase order must
 * keep the original Kwacha prices and the approved rate of its own date, while
 * everything that reaches the ledgers, the parent company and inventory is the
 * historical USD value converted once at that locked rate. A later approved
 * rate (28 here) must never reprice the order, its edit or its offload, and a
 * Kwacha label without the native evidence (or with an unapproved rate) must be
 * refused before any row is written. The USD path a Mali-style company uses is
 * exercised alongside to show it is untouched.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { createPurchaseOrder } from "../server/storage/containers-store/purchase-orders";
import { valueZmwPurchaseAtLockedRate } from "../server/services/accounting/zambiaPurchaseCosting";
import { executeContainerOffloadLifecycle } from "../server/services/containers/offload-lifecycle/execute";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "zmwpo";
const PARENT_PREFIX = `${TEST_PREFIX}par`;
const RATE_DATE = "2026-10-20";
const LATER_RATE_DATE = "2026-10-22";

let ctx: TestContext;
let parentCtx: TestContext;
let agent: request.SuperAgentTest;
let supplierId: number;
let containerId: number;
let zmwPoId: number;
let zmwPoNumber: string;
let sequence = 0;

const nextPoNumber = () => {
  sequence += 1;
  return `${TEST_PREFIX}-PO-${sequence}`;
};

type EntryRow = {
  voucher_number: string;
  currency: string | null;
  exchange_rate: string | null;
  transaction_currency: string | null;
  debit_amount: string;
  credit_amount: string;
  supplier_id: number | null;
  code: string | null;
};

async function voucherEntries(companyId: number, voucherId: number | null, numberLike?: string): Promise<EntryRow[]> {
  const result = await pool.query<EntryRow>(
    `SELECT v.voucher_number, v.currency, v.exchange_rate, ve.transaction_currency,
            ve.debit_amount, ve.credit_amount, ve.supplier_id, la.code
       FROM voucher_entries ve
       JOIN vouchers v ON v.id = ve.voucher_id
       LEFT JOIN ledger_accounts la ON la.id = ve.ledger_account_id
      WHERE v.company_id = $1 AND v.deleted_at IS NULL
        AND ($2::int IS NULL OR v.id = $2)
        AND ($3::text IS NULL OR v.voucher_number LIKE $3)
      ORDER BY ve.id`,
    [companyId, voucherId, numberLike ?? null]
  );
  return result.rows;
}

const sum = (rows: EntryRow[], field: "debit_amount" | "credit_amount") =>
  rows.reduce((total, row) => total + Number(row[field] || 0), 0);

async function poCount(): Promise<number> {
  const result = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM purchase_orders WHERE company_id = $1`, [
    ctx.companyId,
  ]);
  return Number(result.rows[0].n);
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  parentCtx = await seedTestData(PARENT_PREFIX);
  agent = request.agent(ctx.app);
  const login = await agent
    .post("/api/auth/login")
    .send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  expect(login.status).toBe(200);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

  // Zambia: USD accounting base, Kwacha display, parent HADI-style company.
  await pool.query(`UPDATE companies SET display_currency = 'ZMW', parent_company_id = $2 WHERE id = $1`, [
    ctx.companyId,
    parentCtx.companyId,
  ]);
  // The caller must belong to the parent for the parent-side import posting.
  await db
    .insert(schema.userCompanyRoles)
    .values({ userId: ctx.userId, companyId: parentCtx.companyId, role: "Admin" });
  await db.insert(schema.exchangeRates).values([
    { companyId: ctx.companyId, fromCurrency: "USD", toCurrency: "ZMW", rate: "25", effectiveDate: RATE_DATE },
    { companyId: ctx.companyId, fromCurrency: "USD", toCurrency: "ZMW", rate: "28", effectiveDate: LATER_RATE_DATE },
  ]);

  const supplier = await pool.query<{ id: number }>(
    `INSERT INTO suppliers (company_id, code, legal_name, email, active)
     VALUES ($1, $2, $3, $4, true) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}SUP`.toUpperCase(), `${TEST_PREFIX} Supplier`, `${TEST_PREFIX}@example.test`]
  );
  supplierId = supplier.rows[0].id;
  const container = await pool.query<{ id: number }>(
    `INSERT INTO containers (company_id, container_number, supplier_id, status, import_date)
     VALUES ($1, $2, $3, 'OTW', $4) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-CONT-1`, supplierId, RATE_DATE]
  );
  containerId = container.rows[0].id;
}, 180_000);

afterAll(async () => {
  for (const companyId of [ctx.companyId, parentCtx.companyId]) {
    await pool.query(`DELETE FROM canonical_stock_movement_audit WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM canonical_stock_movement_requests WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM canonical_stock_movements WHERE company_id = $1`, [companyId]);
  }
  await pool.query(`DELETE FROM po_line_items WHERE po_id IN (SELECT id FROM purchase_orders WHERE company_id = $1)`, [
    ctx.companyId,
  ]);
  await pool.query(`DELETE FROM purchase_orders WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(
    `DELETE FROM container_offload_items WHERE offload_id IN (
       SELECT id FROM container_offloads WHERE container_id IN (SELECT id FROM containers WHERE company_id = $1))`,
    [ctx.companyId]
  );
  await pool.query(
    `DELETE FROM container_offloads WHERE container_id IN (SELECT id FROM containers WHERE company_id = $1)`,
    [ctx.companyId]
  );
  await pool.query(`DELETE FROM import_logs WHERE container_id IN (SELECT id FROM containers WHERE company_id = $1)`, [
    ctx.companyId,
  ]);
  await pool.query(
    `DELETE FROM container_charges WHERE container_id IN (SELECT id FROM containers WHERE company_id = $1)`,
    [ctx.companyId]
  );
  await pool.query(`DELETE FROM containers WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(
    `DELETE FROM voucher_entries WHERE voucher_id IN (SELECT voucher_id FROM voucher_entries WHERE supplier_id = $1)`,
    [supplierId]
  );
  await pool.query(`DELETE FROM suppliers WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM exchange_rates WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(PARENT_PREFIX);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 120_000);

/** K125 x 2 and K1 x 1 plus K50 freight at 25 ZMW per USD. */
function valuedNativeOrder() {
  return valueZmwPurchaseAtLockedRate({
    date: RATE_DATE,
    historicalRate: "25",
    lines: [
      { quantity: "2", rate: "125.00" },
      { quantity: "1", rate: "1.00" },
    ],
    charges: { freight: "50.00" },
  });
}

function nativePoFields(
  poNumber: string,
  valued: ReturnType<typeof valuedNativeOrder>,
  rate = valued.historicalExchangeRate
) {
  return {
    companyId: ctx.companyId,
    poNumber,
    containerId,
    supplierId,
    currency: "ZMW",
    historicalExchangeRate: rate,
    historicalRateDate: valued.historicalRateDate,
    nativeLineCount: valued.nativeLineCount,
    nativeItemsTotal: valued.nativeItemsTotal,
    nativeFreight: valued.nativeFreight,
    nativeSurcharge: valued.nativeSurcharge,
    nativeFumigation: valued.nativeFumigation,
    nativeDocumentCharges: valued.nativeDocumentCharges,
    nativeDiscount: valued.nativeDiscount,
    nativeOtherCharges: valued.nativeOtherCharges,
    itemsTotal: valued.itemsTotal,
    freight: valued.freight,
    surcharge: valued.surcharge,
    fumigation: valued.fumigation,
    documentCharges: valued.documentCharges,
    discount: valued.discount,
    otherCharges: valued.otherCharges,
    freightPaidBy: "supplier",
  };
}

function nativeLines(valued: ReturnType<typeof valuedNativeOrder>) {
  return valued.lines.map((line, index) => ({
    stockItemId: ctx.stockItemIds[index],
    itemName: `Test Item ${index + 1}`,
    quantity: line.quantity,
    rate: line.rate,
    lineTotal: line.lineTotal,
    nativeRate: line.nativeRate,
    nativeLineTotal: line.nativeLineTotal,
  }));
}

describe("native Kwacha purchase orders", () => {
  it("stores the original Kwacha evidence and posts one historical USD value to both companies", async () => {
    const valued = valuedNativeOrder();
    expect(valued).toMatchObject({
      nativeItemsTotal: "251.00",
      itemsTotal: "10.04",
      freight: "2.00",
      grandTotal: "12.04",
    });
    zmwPoNumber = nextPoNumber();

    const po = await createPurchaseOrder(nativePoFields(zmwPoNumber, valued), RATE_DATE, nativeLines(valued));
    zmwPoId = po.id;

    const stored = await pool.query(
      `SELECT currency, historical_exchange_rate, to_char(historical_rate_date, 'YYYY-MM-DD') AS historical_rate_date,
              native_line_count, native_items_total, native_freight, items_total, freight, voucher_id
         FROM purchase_orders WHERE id = $1`,
      [po.id]
    );
    expect(stored.rows[0]).toMatchObject({
      currency: "ZMW",
      native_line_count: 2,
      native_items_total: "251.00",
      native_freight: "50.00",
      items_total: "10.04",
      freight: "2.00",
    });
    expect(Number(stored.rows[0].historical_exchange_rate)).toBe(25);
    expect(stored.rows[0].historical_rate_date).toBe(RATE_DATE);

    const lines = await pool.query(
      `SELECT quantity, rate, line_total, native_rate, native_line_total FROM po_line_items WHERE po_id = $1 ORDER BY id`,
      [po.id]
    );
    expect(lines.rows).toEqual([
      expect.objectContaining({
        rate: "5.00",
        line_total: "10.00",
        native_rate: "125.00",
        native_line_total: "250.00",
      }),
      expect.objectContaining({ rate: "0.04", line_total: "0.04", native_rate: "1.00", native_line_total: "1.00" }),
    ]);

    // Subsidiary: Purchases 12.04 USD / Parent credit 12.04 USD, balanced, USD base.
    const subsidiary = await voucherEntries(ctx.companyId, stored.rows[0].voucher_id);
    expect(subsidiary.length).toBeGreaterThanOrEqual(2);
    expect(sum(subsidiary, "debit_amount")).toBeCloseTo(12.04, 6);
    expect(sum(subsidiary, "credit_amount")).toBeCloseTo(12.04, 6);
    expect(subsidiary.every((row) => (row.transaction_currency ?? "USD") === "USD")).toBe(true);
    expect(subsidiary.some((row) => Number(row.debit_amount) > 250)).toBe(false);

    // Parent: receivable from Zambia 12.04 USD / supplier credit 12.04 USD at the same base.
    const parent = await voucherEntries(parentCtx.companyId, null, `INTERCO-PARENT-${zmwPoNumber}-%`);
    expect(parent).toHaveLength(2);
    expect(sum(parent, "debit_amount")).toBeCloseTo(12.04, 6);
    expect(sum(parent, "credit_amount")).toBeCloseTo(12.04, 6);
    expect(parent.find((row) => row.supplier_id === supplierId)?.credit_amount).toBe("12.04");
    expect(parent[0].currency ?? "USD").toBe("USD");
  }, 60_000);

  it("refuses a Kwacha order whose rate is not the approved rate of its date, writing nothing", async () => {
    const before = await poCount();
    const valued = valuedNativeOrder();
    await expect(
      createPurchaseOrder(nativePoFields(nextPoNumber(), valued, "26"), RATE_DATE, nativeLines(valued))
    ).rejects.toMatchObject({
      statusCode: 409,
    });
    // A later approved rate is not the rate of the order's date either.
    await expect(
      createPurchaseOrder(nativePoFields(nextPoNumber(), valued, "28"), RATE_DATE, nativeLines(valued))
    ).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(await poCount()).toBe(before);
  });

  it("refuses a bare ZMW label without native evidence before any purchase, voucher or stock write", async () => {
    const before = await poCount();
    await expect(
      createPurchaseOrder(
        {
          companyId: ctx.companyId,
          poNumber: nextPoNumber(),
          containerId,
          supplierId,
          currency: "ZMW",
          itemsTotal: "250.00",
          freight: "0",
          surcharge: "0",
          fumigation: "0",
          documentCharges: "0",
          discount: "0",
          otherCharges: "0",
          freightPaidBy: "supplier",
        },
        RATE_DATE
      )
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await poCount()).toBe(before);
  });

  it("re-prices an edited Kwacha order at its own locked rate, not the later approved rate", async () => {
    const edit = await agent.patch(`/api/purchase-orders/${zmwPoId}`).send({
      poNumber: zmwPoNumber,
      currency: "ZMW",
      status: "OTW",
      items: [{ stockItemId: ctx.stockItemIds[0], itemName: "Test Item 1", quantity: "2", rate: "150.00" }],
      freight: "50.00",
      surcharge: "0",
      fumigation: "0",
      documentCharges: "0",
      discount: "0",
      otherCharges: "0",
      freightPaidBy: "supplier",
    });
    expect(edit.status).toBe(200);

    const stored = await pool.query(
      `SELECT historical_exchange_rate, native_items_total, items_total, freight, native_freight, native_line_count
         FROM purchase_orders WHERE id = $1`,
      [zmwPoId]
    );
    // K300 / 25 = 12.00 USD (at 28 it would have been 10.71).
    expect(stored.rows[0]).toMatchObject({
      native_items_total: "300.00",
      items_total: "12.00",
      native_freight: "50.00",
      freight: "2.00",
      native_line_count: 1,
    });
    expect(Number(stored.rows[0].historical_exchange_rate)).toBe(25);
    const lines = await pool.query(
      `SELECT rate, line_total, native_rate, native_line_total FROM po_line_items WHERE po_id = $1`,
      [zmwPoId]
    );
    expect(lines.rows).toEqual([
      expect.objectContaining({
        rate: "6.00",
        line_total: "12.00",
        native_rate: "150.00",
        native_line_total: "300.00",
      }),
    ]);
  }, 60_000);

  it("locks the currency and rate of a posted Kwacha order", async () => {
    const asUsd = await agent.patch(`/api/purchase-orders/${zmwPoId}`).send({ currency: "USD" });
    expect(asUsd.status).toBe(409);
    const newRate = await agent.patch(`/api/purchase-orders/${zmwPoId}`).send({ exchangeRate: "28", freight: "60.00" });
    expect(newRate.status).toBe(409);
  });

  it("offloads the container at the historical USD line value, never at the Kwacha figure", async () => {
    const inventoryValue = async () => {
      const inventory = await pool.query<{ total_value: string }>(
        `SELECT total_value FROM inventory WHERE location_id = $1 AND stock_item_id = $2`,
        [ctx.locationId, ctx.stockItemIds[0]]
      );
      return Number(inventory.rows[0]?.total_value ?? 0);
    };
    const valueBefore = await inventoryValue();
    const result = await executeContainerOffloadLifecycle({
      containerId,
      companyId: ctx.companyId,
      locationId: ctx.locationId,
      offloadDate: LATER_RATE_DATE,
      duties: "0",
      officeCharges: "0",
      transferCharges: "0",
      transportFees: "0",
      mode: "offload",
      userId: ctx.userId,
      username: `${TEST_PREFIX}_testuser`,
    } as Parameters<typeof executeContainerOffloadLifecycle>[0]);

    const items = await pool.query<{ stock_item_id: number; quantity: string; rate: string; total_value: string }>(
      `SELECT stock_item_id, quantity, rate, total_value FROM container_offload_items WHERE offload_id = $1`,
      [Number(result.offload.id)]
    );
    expect(items.rows).toHaveLength(1);
    expect(Number(items.rows[0].quantity)).toBe(2);
    // 2 bales for 12.00 USD (K300 at 25) plus the 2.00 USD freight: 7.00 each.
    expect(Number(items.rows[0].total_value)).toBeCloseTo(14, 2);
    expect(Number(items.rows[0].rate)).toBeCloseTo(7, 2);

    // The stock ledger moved by the USD landed value (14.00), not by K300.
    expect((await inventoryValue()) - valueBefore).toBeCloseTo(14, 2);
  }, 60_000);

  it("refuses to edit Kwacha quantities or prices once the container is offloaded", async () => {
    const edit = await agent.patch(`/api/purchase-orders/${zmwPoId}`).send({
      items: [{ stockItemId: ctx.stockItemIds[0], itemName: "Test Item 1", quantity: "3", rate: "150.00" }],
    });
    expect(edit.status).toBe(409);
  });
});

describe("Excel purchase import for a Kwacha-enabled company", () => {
  const containerNumber = `${TEST_PREFIX}-CONT-IMP`;
  const poNumber = `${TEST_PREFIX}-IMP-1`;

  function payload(extra: Record<string, unknown>) {
    return {
      fileHash: `${TEST_PREFIX}-HASH-IMP`,
      fileName: `${TEST_PREFIX}-imp.xlsx`,
      containerNumber,
      supplierId,
      importDate: RATE_DATE,
      freightPaidBy: "supplier",
      freightParentAccountId: null,
      preview: [
        {
          containerNumber,
          items: [
            {
              barcode: `${TEST_PREFIX}-ITEM2`,
              itemName: "Test Item 2",
              poNumber,
              quantity: 4,
              rate: 250,
              lineTotal: 1000,
            },
          ],
          charges: { freight: 100, surcharge: 0, fumigation: 0, documentCharges: 0, discount: 0, otherCharges: 0 },
          itemsTotal: 1000,
          chargesTotal: 100,
          grandTotal: 1100,
          itemsCount: 1,
        },
      ],
      ...extra,
    };
  }

  it("will not validate a sheet without a stated invoice currency", async () => {
    const res = await agent.post("/api/po-import/validate").send(payload({}));
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors).toEqual([expect.stringContaining("Select the invoice currency")]);
  });

  it("requires the approved rate of the import date for a Kwacha invoice", async () => {
    const missing = await agent.post("/api/po-import/validate").send(payload({ currency: "ZMW" }));
    expect(missing.body.valid).toBe(false);
    const wrong = await agent.post("/api/po-import/validate").send(payload({ currency: "ZMW", exchangeRate: "28" }));
    expect(wrong.body.valid).toBe(false);
    const ok = await agent.post("/api/po-import/validate").send(payload({ currency: "ZMW", exchangeRate: "25" }));
    expect(ok.body).toEqual({ valid: true, errors: [] });
  });

  it("imports Kwacha lines once at the locked rate into USD inventory cost and the parent's USD books", async () => {
    const res = await agent.post("/api/po-import/import").send(payload({ currency: "ZMW", exchangeRate: "25" }));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Converted container totals: K1000 -> 40.00, K100 -> 4.00.
    expect(Number(res.body.grandTotal)).toBeCloseTo(44, 2);

    const po = await pool.query(
      `SELECT id, currency, historical_exchange_rate, historical_rate_date, native_line_count, native_items_total,
              native_freight, items_total, freight, voucher_id
         FROM purchase_orders WHERE company_id = $1 AND po_number = $2`,
      [ctx.companyId, poNumber]
    );
    expect(po.rows).toHaveLength(1);
    expect(po.rows[0]).toMatchObject({
      currency: "ZMW",
      native_line_count: 1,
      native_items_total: "1000.00",
      native_freight: "100.00",
      items_total: "40.00",
      freight: "4.00",
    });
    expect(Number(po.rows[0].historical_exchange_rate)).toBe(25);
    const lines = await pool.query(
      `SELECT quantity, rate, line_total, native_rate, native_line_total FROM po_line_items WHERE po_id = $1`,
      [po.rows[0].id]
    );
    expect(lines.rows).toEqual([
      expect.objectContaining({
        rate: "10.00",
        line_total: "40.00",
        native_rate: "250.00",
        native_line_total: "1000.00",
      }),
    ]);

    const subsidiary = await voucherEntries(ctx.companyId, po.rows[0].voucher_id);
    expect(sum(subsidiary, "debit_amount")).toBeCloseTo(44, 6);
    expect(sum(subsidiary, "credit_amount")).toBeCloseTo(44, 6);

    const marker = await pool.query<{ voucher_id: number }>(
      `SELECT voucher_id FROM accounting_posting_requests
        WHERE company_id = $1 AND source_type = 'po-import' AND source_id = $2`,
      [parentCtx.companyId, `${ctx.companyId}:${poNumber}:parent-intercompany`]
    );
    expect(marker.rows).toHaveLength(1);
    const parent = await voucherEntries(parentCtx.companyId, marker.rows[0].voucher_id);
    expect(sum(parent, "debit_amount")).toBeCloseTo(44, 6);
    expect(sum(parent, "credit_amount")).toBeCloseTo(44, 6);
    expect(parent.find((row) => row.supplier_id === supplierId)?.credit_amount).toBe("44.00");
  }, 60_000);

  it("does not import the same file twice", async () => {
    const res = await agent.post("/api/po-import/import").send(payload({ currency: "ZMW", exchangeRate: "25" }));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already been imported/);
  });

  it("refuses to relabel a USD sheet as Kwacha", async () => {
    const otherContainer = `${TEST_PREFIX}-CONT-USDSHEET`;
    const res = await agent.post("/api/po-import/validate").send(
      payload({
        currency: "ZMW",
        exchangeRate: "25",
        containerNumber: otherContainer,
        preview: [
          {
            ...payload({}).preview[0],
            containerNumber: otherContainer,
            items: [{ ...payload({}).preview[0].items[0], currency: "USD" }],
          },
        ],
      })
    );
    expect(res.body.valid).toBe(false);
    expect(res.body.errors).toEqual([expect.stringContaining("says USD but ZMW was selected")]);
  });
});

describe("USD purchasing stays as it was", () => {
  it("posts a plain USD order without any native Kwacha fields", async () => {
    const usdContainer = await pool.query<{ id: number }>(
      `INSERT INTO containers (company_id, container_number, supplier_id, status, import_date)
       VALUES ($1, $2, $3, 'OTW', $4) RETURNING id`,
      [ctx.companyId, `${TEST_PREFIX}-CONT-USD`, supplierId, RATE_DATE]
    );
    const po = await createPurchaseOrder(
      {
        companyId: ctx.companyId,
        poNumber: nextPoNumber(),
        containerId: usdContainer.rows[0].id,
        supplierId,
        currency: "USD",
        itemsTotal: "10.00",
        freight: "2.00",
        surcharge: "0",
        fumigation: "0",
        documentCharges: "0",
        discount: "0",
        otherCharges: "0",
        freightPaidBy: "supplier",
      },
      RATE_DATE
    );
    const stored = await pool.query(
      `SELECT currency, historical_exchange_rate, native_items_total, items_total, voucher_id FROM purchase_orders WHERE id = $1`,
      [po.id]
    );
    expect(stored.rows[0]).toMatchObject({
      currency: "USD",
      historical_exchange_rate: null,
      native_items_total: null,
      items_total: "10.00",
    });
    const subsidiary = await voucherEntries(ctx.companyId, stored.rows[0].voucher_id);
    expect(sum(subsidiary, "debit_amount")).toBeCloseTo(12, 6);
    expect(sum(subsidiary, "credit_amount")).toBeCloseTo(12, 6);
  });
});

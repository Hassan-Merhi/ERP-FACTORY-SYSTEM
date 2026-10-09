/**
 * Wave 17 (B) — inventory and factory leftovers (accounting audit 2026-10):
 *
 *   1  the V3 load finalize invoices the load in one transaction (a FINALIZED
 *      order with the bales at their proforma price, the customer's SALE row,
 *      the INV-GL journal with COGS once the cut-over applies, an audit row);
 *      a bale it cannot invoice refuses it with nothing written; re-finalize
 *      is idempotent;
 *   2  a stock-entry bale with no mix is refused after the cut-over (HMD16
 *      garbage bales excepted); before it, such bales are listed by the
 *      readiness report and block the cut-over apply;
 *   3  a non-USD factory invoice posts at the confirmed factory rate on or
 *      before its date, normalized (USD base, native transaction amounts; the
 *      cost lines in USD);
 *   4  a stock adjustment edit reapplies on the negative-stock model: a
 *      consumption may take the row short, at exact values, with no clamp;
 *   5  the opening carries factory goods in transit for containers expensed
 *      before the cut-over and not received, and the daily factory journal
 *      clears it with their receipts before crediting expense;
 *   6  the cut-over apply refuses while factory blockers remain;
 *   7  STOCK-IN is one journal per offload, dated with it, crediting goods in
 *      transit by quantity share; a later offload leaves an earlier journal
 *      untouched;
 *   8  a receipt deleted after its day's journal is reversed in the journal of
 *      the day of the change;
 *   9  a transfer import from a source with no stock row takes the item's
 *      latest cost as its provisional cost, the selling price only without one.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import {
  OpeningJournalRefusal,
  applyOpeningInventoryJournal,
  planOpeningInventoryJournal,
} from "../server/services/accounting/perpetualInventory/openingJournal";
import { syncFactoryInvoiceTx } from "../server/services/accounting/perpetualInventory/factoryInvoice";
import {
  factoryGoodsInTransitHeld,
  syncFactoryStockJournalTx,
} from "../server/services/accounting/perpetualInventory/factoryStockJournal";
import {
  factoryCutoverBlockerMessage,
  factoryCutoverBlockers,
} from "../server/services/accounting/perpetualInventory/factoryCutoverBlockers";
import { perpetualReadinessReport } from "../server/services/accounting/perpetualInventory/readiness";
import { syncContainerStockInTx } from "../server/services/accounting/perpetualInventory/stockReceipts";
import { assertStockEntryHasCostedMixTx } from "../server/services/factory/baleCostBasis";
import { ensureFactoryCostBasisSchema } from "../server/services/factory/factoryCostBasisSchema";
import { runWithDatabaseMaintenanceScope } from "../server/services/security/databaseScopeRuntimeContext";
import { createPurchaseOrder } from "../server/storage/containers-store/purchase-orders";
import { createStockAdjustment } from "../server/storage/stock-ops/transfers-create";
import { updateStockAdjustment } from "../server/storage/stock-ops/transfers-update";
import { provisionalTransferImportRate } from "../server/routes/stockTransferImportPosting";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "w17b";
const day = (offset: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};
const today = day(0);
const CUTOVER = "2026-01-01";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let customerId: number;
let sequence = 0;
const asMaintenance = <T>(work: () => Promise<T>) => runWithDatabaseMaintenanceScope("wave17b-test", work);
const query = (text: string, values: unknown[] = []) => asMaintenance(() => pool.query(text, values));

async function setCutover(effectiveFrom: string | null, plan: Record<string, unknown> = {}) {
  await query(`DELETE FROM gl_inventory_cutovers WHERE company_id = $1`, [ctx.companyId]);
  if (effectiveFrom) {
    await query(
      `INSERT INTO gl_inventory_cutovers (company_id, effective_from, opening_plan, applied_by)
       VALUES ($1, $2, $3::jsonb, 'test')`,
      [ctx.companyId, effectiveFrom, JSON.stringify(plan)]
    );
  }
}

async function account(code: string, type: string): Promise<number> {
  const { rows } = await query(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, $4, 0, 'Dr') RETURNING id`,
    [ctx.companyId, code, code, type]
  );
  return rows[0].id;
}

/** A balanced fixture voucher. */
async function voucher(number: string, date: string, lines: Array<[number, string, string]>) {
  await withFixtureTransaction(async (client) => {
    await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
    const { rows } = await client.query(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
       VALUES ($1, $2, 'Journal', $3, $4) RETURNING id`,
      [ctx.companyId, number, date, lines.reduce((sum, [, d]) => sum + Number(d), 0)]
    );
    for (const [ledger, d, c] of lines) {
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, $3, $4)`,
        [rows[0].id, ledger, d, c]
      );
    }
  });
}

/** The live lines of the vouchers whose number matches `pattern`: [number, code, debit, credit]. */
async function journal(pattern: string) {
  const { rows } = await query(
    `SELECT v.voucher_number, la.code, ROUND(ve.debit_amount, 2)::text AS d, ROUND(ve.credit_amount, 2)::text AS c
       FROM vouchers v JOIN voucher_entries ve ON ve.voucher_id = v.id JOIN ledger_accounts la ON la.id = ve.ledger_account_id
      WHERE v.company_id = $1 AND v.voucher_number LIKE $2 AND v.deleted_at IS NULL
      ORDER BY v.id, la.code, ve.id`,
    [ctx.companyId, pattern]
  );
  return rows.map((row) => [row.voucher_number, row.code, row.d, row.c]);
}

async function bale(values: {
  article: string;
  cost: string;
  status?: string;
  mix?: number | null;
  location?: boolean;
}) {
  sequence += 1;
  const reference = `${PREFIX}-REF-${sequence}`;
  const { rows } = await query(
    `INSERT INTO factory_bales (company_id, bale_code, reference_number, article_code, product_name, weight_kg,
                                cost_per_kg, total_cost, status, erp_location_id, mix_batch_id)
     VALUES ($1, $2, $8, $3, $9, '25.000', '2.00', $4, $5, $6, $7) RETURNING id`,
    [
      ctx.companyId,
      reference,
      values.article,
      values.cost,
      values.status ?? "IN_STOCK",
      values.location === false ? null : ctx.locationId,
      values.mix ?? null,
      reference,
      values.article,
    ]
  );
  return { id: rows[0].id as number, reference };
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  await ensureFactoryCostBasisSchema(pool);
  await query(`DELETE FROM inventory WHERE company_id = $1`, [ctx.companyId]);
  // The V3 load routes need a factory company.
  await query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [ctx.companyId]);
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  const { rows } = await query(
    `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, $3) RETURNING id`,
    [ctx.companyId, `${PREFIX}-CUST`, `${PREFIX} Customer`]
  );
  customerId = rows[0].id;
}, 120_000);

afterAll(async () => {
  const id = ctx.companyId;
  await query(`DELETE FROM gl_inventory_cutovers WHERE company_id = $1`, [id]);
  await query(`DELETE FROM factory_stock_value_events WHERE company_id = $1`, [id]);
  await query(
    `DELETE FROM factory_v3_load_bales WHERE load_id IN (SELECT id FROM factory_v3_loads WHERE company_id = $1)`,
    [id]
  );
  await query(`DELETE FROM factory_v3_loads WHERE company_id = $1`, [id]);
  await query(`DELETE FROM customer_balances WHERE company_id = $1`, [id]);
  for (const table of ["customer_order_bales", "customer_order_lines"]) {
    await query(`DELETE FROM ${table} WHERE order_id IN (SELECT id FROM customer_orders WHERE company_id = $1)`, [id]);
  }
  await query(`DELETE FROM customer_orders WHERE company_id = $1`, [id]);
  await query(`DELETE FROM customer_invoice_sequences WHERE company_id = $1`, [id]);
  await query(`DELETE FROM customer_dispatch_batches WHERE company_id = $1`, [id]);
  for (const table of [
    "factory_container_receipts",
    "factory_bales",
    "factory_containers",
    "factory_fx_rates",
    "inventory_negative_layers",
  ]) {
    await query(`DELETE FROM ${table} WHERE company_id = $1`, [id]);
  }
  await deleteAuditLogRowsForTests(pool, "company_id = $1", [id]);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 120_000);

describe("cut-over apply refuses on factory blockers (decisions 2 and 6)", () => {
  it("lists a no-mix bale at the catalogue price and refuses the apply while it is stock", async () => {
    await setCutover(null);
    const noMix = await bale({ article: `${PREFIX}-ART-NM`, cost: "40.00" });
    // A garbage bale costs nothing by rule and is not a blocker.
    await bale({ article: "HMD16-W17B", cost: "0" });

    const blockers = await asMaintenance(() => factoryCutoverBlockers(db, ctx.companyId));
    expect(blockers.noMixBales).toMatchObject({ count: 1, cost: "40.00", baleIds: [noMix.id] });
    expect(factoryCutoverBlockerMessage(blockers)).toContain("1 bales with no mix costed at the catalogue price");

    const report = await asMaintenance(() => perpetualReadinessReport(ctx.companyId, today));
    expect(report.noMixCataloguePricedBales.count).toBe(1);
    expect(report.blockers.map((blocker) => blocker.code)).toContain("NO_MIX_BALES_AT_CATALOGUE_PRICE");

    const refused = await asMaintenance(() =>
      applyOpeningInventoryJournal(ctx.companyId, today, "test", { postingReady: true, today })
    ).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(OpeningJournalRefusal);
    expect((refused as OpeningJournalRefusal).code).toBe("FACTORY_READINESS_BLOCKERS");
    expect((refused as OpeningJournalRefusal).message).toContain("1 bales with no mix");
    const { rows } = await query(`SELECT 1 FROM gl_inventory_cutovers WHERE company_id = $1`, [ctx.companyId]);
    expect(rows).toEqual([]);
    await query(`DELETE FROM factory_bales WHERE company_id = $1`, [ctx.companyId]);
  }, 60_000);

  it("refuses a stock-entry bale with no mix after the cut-over, garbage bales excepted", async () => {
    await setCutover(CUTOVER);
    await expect(
      asMaintenance(() =>
        db.transaction((tx) => assertStockEntryHasCostedMixTx(tx, ctx.companyId, today, ["ART-1", "HMD16-X"]))
      )
    ).rejects.toMatchObject({ statusCode: 409, code: "FACTORY_BALE_REQUIRES_COSTED_MIX", articleCodes: ["ART-1"] });
    await asMaintenance(() =>
      db.transaction((tx) => assertStockEntryHasCostedMixTx(tx, ctx.companyId, today, ["HMD16-X"]))
    );
    // Before the cut-over the catalogue price stays.
    await asMaintenance(() =>
      db.transaction((tx) => assertStockEntryHasCostedMixTx(tx, ctx.companyId, "2025-12-31", ["ART-1"]))
    );
  });
});

describe("V3 load finalize invoices the load (decision 1)", () => {
  async function loadingLoad(bales: Array<{ reference: string }>) {
    const proforma = await query(
      `INSERT INTO customer_proformas (company_id, customer_id, name, is_active) VALUES ($1, $2, $3, true) RETURNING id`,
      [ctx.companyId, customerId, `${PREFIX} proforma ${++sequence}`]
    );
    const proformaId = proforma.rows[0].id;
    await query(
      `INSERT INTO customer_proforma_lines (proforma_id, article_code, product_name, quantity, price_per_bale)
       VALUES ($1, $2, 'priced', 10, '80.00')`,
      [proformaId, `${PREFIX}-ART-V3`]
    );
    const created = await agent
      .post("/api/factory/v3/loads")
      .send({ proformaId, loadName: `${PREFIX} load ${sequence}`, expectedLoadDate: today });
    expect(created.status, created.text).toBe(201);
    expect((await agent.patch(`/api/factory/v3/loads/${created.body.id}/start`)).status).toBe(200);
    for (const entry of bales) {
      const scanned = await agent
        .post(`/api/factory/v3/loads/${created.body.id}/bales`)
        .send({ scanCode: entry.reference });
      expect(scanned.status, scanned.text).toBe(201);
    }
    return created.body.id as number;
  }

  it("creates the factory invoice, posts receivable, revenue and COGS, and is idempotent", async () => {
    await setCutover(CUTOVER);
    const first = await bale({ article: `${PREFIX}-ART-V3`, cost: "50.00" });
    const second = await bale({ article: `${PREFIX}-ART-V3`, cost: "50.00" });
    const loadId = await loadingLoad([first, second]);

    const response = await agent.post(`/api/factory/v3/loads/${loadId}/finalize`);
    expect(response.status, response.text).toBe(200);
    expect(response.body.status).toBe("finalized");
    const { orderId, grandTotal } = response.body.invoice;
    expect(grandTotal).toBe("160.00");

    const order = await query(`SELECT status, customer_id, proforma_id_used FROM customer_orders WHERE id = $1`, [
      orderId,
    ]);
    expect(order.rows[0]).toMatchObject({ status: "FINALIZED", customer_id: customerId });
    const statuses = await query(`SELECT status FROM factory_bales WHERE id = ANY($1::int[]) ORDER BY id`, [
      [first.id, second.id],
    ]);
    expect(statuses.rows.map((row) => row.status)).toEqual(["SOLD", "SOLD"]);
    const sale = await query(
      `SELECT debit_amount::text AS d FROM customer_balances WHERE company_id = $1 AND reference_id = $2 AND transaction_type = 'SALE'`,
      [ctx.companyId, orderId]
    );
    expect(sale.rows.map((row) => row.d)).toEqual(["160.00"]);
    expect(await journal(`INV-GL-${ctx.companyId}-${orderId}`)).toEqual([
      [`INV-GL-${ctx.companyId}-${orderId}`, "COGS", "100.00", "0.00"],
      [`INV-GL-${ctx.companyId}-${orderId}`, `CUST-${customerId}`, "160.00", "0.00"],
      [`INV-GL-${ctx.companyId}-${orderId}`, "FACTORY_BALE_SALES_INCOME", "0.00", "160.00"],
      [`INV-GL-${ctx.companyId}-${orderId}`, "FACTORY_FINISHED_GOODS", "0.00", "100.00"],
    ]);
    const audit = await query(
      `SELECT 1 FROM audit_log WHERE company_id = $1 AND table_name = 'factory_v3_loads' AND record_identifier = $2`,
      [ctx.companyId, `v3-load-finalize:${loadId}`]
    );
    expect(audit.rows).toHaveLength(1);

    const again = await agent.post(`/api/factory/v3/loads/${loadId}/finalize`);
    expect(again.status).toBe(200);
    expect(again.body.alreadyFinalized).toBe(true);
    expect(again.body.invoice.orderId).toBe(orderId);
    const orders = await query(`SELECT COUNT(*)::int AS n FROM customer_orders WHERE proforma_id_used = $1`, [
      order.rows[0].proforma_id_used,
    ]);
    expect(orders.rows[0].n).toBe(1);
  }, 60_000);

  it("refuses a load with a bale it cannot invoice and writes nothing", async () => {
    const located = await bale({ article: `${PREFIX}-ART-V3`, cost: "50.00" });
    const unlocated = await bale({ article: `${PREFIX}-ART-V3`, cost: "50.00", location: false });
    const loadId = await loadingLoad([located, unlocated]);

    const response = await agent.post(`/api/factory/v3/loads/${loadId}/finalize`);
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "V3_LOAD_BALES_WITHOUT_LOCATION", bales: [unlocated.reference] });
    const statuses = await query(`SELECT status FROM factory_bales WHERE id = ANY($1::int[])`, [
      [located.id, unlocated.id],
    ]);
    expect(statuses.rows.map((row) => row.status)).toEqual(["IN_STOCK", "IN_STOCK"]);
    const load = await query(`SELECT status, customer_order_id FROM factory_v3_loads WHERE id = $1`, [loadId]);
    expect(load.rows[0]).toEqual({ status: "loading", customer_order_id: null });
  }, 60_000);
});

describe("non-USD factory invoices (decision 3)", () => {
  it("posts at the confirmed factory rate on or before the invoice date, normalized", async () => {
    await setCutover(CUTOVER);
    // A manual rate dated before the invoice, and a later one that must not be used.
    await query(
      `INSERT INTO factory_fx_rates (company_id, currency_code, rate_to_usd, effective_date, source)
       VALUES ($1, 'EUR', '1.10000000', '2026-02-01', 'manual'), ($1, 'EUR', '9.00000000', $2, 'manual')`,
      [ctx.companyId, day(30)]
    );
    const cost = await bale({ article: `${PREFIX}-ART-EUR`, cost: "100.00", status: "SOLD" });
    const batch = await query(
      `INSERT INTO customer_dispatch_batches (company_id, customer_id, batch_number, batch_date, currency)
       VALUES ($1, $2, $3, $4, 'EUR') RETURNING id`,
      [ctx.companyId, customerId, `${PREFIX}-DB1`, today]
    );
    const order = await query(
      `INSERT INTO customer_orders (company_id, customer_id, order_date, status, invoice_number, grand_total,
                                    finalized_at, dispatch_batch_id)
       VALUES ($1, $2, $3, 'FINALIZED', 'W17B-EUR-1', 300, now(), $4) RETURNING id`,
      [ctx.companyId, customerId, today, batch.rows[0].id]
    );
    const orderId = order.rows[0].id;
    await query(
      `INSERT INTO customer_order_bales (order_id, bale_id, bale_reference, location_id, weight, price_used)
       VALUES ($1, $2, $3, $4, 25, 300)`,
      [orderId, cost.id, cost.reference, ctx.locationId]
    );

    const voucherId = await asMaintenance(() =>
      db.transaction((tx) => syncFactoryInvoiceTx(tx, ctx.companyId, orderId))
    );
    expect(voucherId).not.toBeNull();
    const header = await query(`SELECT currency, exchange_rate::text AS rate FROM vouchers WHERE id = $1`, [voucherId]);
    expect(header.rows[0].currency).toBe("EUR");
    expect(Number(header.rows[0].rate)).toBe(1.1);
    const { rows } = await query(
      `SELECT la.code, ve.transaction_currency AS ccy, ROUND(ve.transaction_debit_amount, 2)::text AS td,
              ROUND(ve.transaction_credit_amount, 2)::text AS tc, ROUND(ve.debit_amount, 2)::text AS d,
              ROUND(ve.credit_amount, 2)::text AS c
         FROM voucher_entries ve JOIN ledger_accounts la ON la.id = ve.ledger_account_id
        WHERE ve.voucher_id = $1 ORDER BY ve.id`,
      [voucherId]
    );
    expect(rows).toEqual([
      { code: `CUST-${customerId}`, ccy: "EUR", td: "300.00", tc: "0.00", d: "330.00", c: "0.00" },
      { code: "FACTORY_BALE_SALES_INCOME", ccy: "EUR", td: "0.00", tc: "300.00", d: "0.00", c: "330.00" },
      { code: "COGS", ccy: "USD", td: "100.00", tc: "0.00", d: "100.00", c: "0.00" },
      { code: "FACTORY_FINISHED_GOODS", ccy: "USD", td: "0.00", tc: "100.00", d: "0.00", c: "100.00" },
    ]);
  }, 60_000);
});

describe("stock adjustment edit on the negative-stock model (item 4)", () => {
  it("lets an edited consumption take the row short at exact values, with no clamp", async () => {
    await setCutover(null);
    const item = ctx.stockItemIds[0];
    await query(
      `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value)
       VALUES ($1, $2, $3, 5, 4, 20)`,
      [ctx.companyId, ctx.locationId, item]
    );
    const created = await query(
      `INSERT INTO vouchers (company_id, location_id, voucher_number, voucher_type, voucher_date, total_amount)
       VALUES ($1, $2, $3, 'Consumption', '2025-11-01', 0) RETURNING id`,
      [ctx.companyId, ctx.locationId, `${PREFIX}-ADJ-1`]
    );
    const adjustment = await asMaintenance(() =>
      createStockAdjustment(created.rows[0].id, ctx.locationId, "Consumption", "w17b", [
        { stockItemId: item, quantity: "3", rate: "4" },
      ])
    );
    const edited = await asMaintenance(() =>
      updateStockAdjustment(adjustment.adjustment.id, ctx.locationId, "Consumption", "w17b edited", [
        { stockItemId: item, quantity: "8", rate: "4" },
      ])
    );
    expect(edited.items[0]).toMatchObject({ totalAmount: "32.00", valueMoved: "32.00" });
    const { rows } = await query(
      `SELECT quantity::text AS q, total_value::text AS v FROM inventory WHERE location_id = $1 AND stock_item_id = $2`,
      [ctx.locationId, item]
    );
    // Short by 3 at the cost memory: the negative value is the provisional cost (it used to be clamped at 0).
    expect(rows[0]).toEqual({ q: "-3.000", v: "-12.00" });
  }, 60_000);
});

describe("factory goods in transit at the opening and receipts (items 5 and 8)", () => {
  it("carries an expensed container in transit, clears it with receipts, and reverses a deleted one", async () => {
    await setCutover(null);
    const expense = await account(`${PREFIX}_IMPORT_EXP`, "Expense");
    const payable = await account(`${PREFIX}_SUPPLIER`, "Liability");
    const container = await query(
      `INSERT INTO factory_containers (company_id, container_number, status) VALUES ($1, $2, 'PENDING') RETURNING id`,
      [ctx.companyId, `${PREFIX}-FC1`]
    );
    const containerId = container.rows[0].id;
    await voucher(`FACTORY-IMPORT-${containerId}-1`, "2025-12-20", [
      [expense, "1000", "0"],
      [payable, "0", "1000"],
    ]);

    const plan = await asMaintenance(() => planOpeningInventoryJournal(ctx.companyId, CUTOVER, db));
    expect(plan.factoryGoodsInTransit).toEqual([{ containerId, amount: "1000.00" }]);
    expect(plan.lines.find((line) => line.accountCode === "FACTORY_GOODS_IN_TRANSIT")?.target).toBe("1000.00");
    await setCutover(CUTOVER, { factoryGoodsInTransit: plan.factoryGoodsInTransit });

    const receipt = async (value: string) =>
      (
        await query(
          `INSERT INTO factory_container_receipts (company_id, container_id, receipt_date, received_kg,
                                                   cumulative_received_kg, receipt_value_usd)
           VALUES ($1, $2, $3, 100, 100, $4) RETURNING id`,
          [ctx.companyId, containerId, today, value]
        )
      ).rows[0].id;
    const run = (date: string) =>
      asMaintenance(() => db.transaction((tx) => syncFactoryStockJournalTx(tx, ctx.companyId, date)));
    const receiptLines = async (date: string) =>
      (await journal(`GL-FACTORY-STOCK-${ctx.companyId}-${date}`))
        .filter(([, code]) => code === "FACTORY_GOODS_IN_TRANSIT" || code === `${PREFIX}_IMPORT_EXP`)
        .map(([, code, d, c]) => [code, d, c]);

    const firstReceipt = await receipt("600");
    await run(today);
    expect(await receiptLines(today)).toEqual([["FACTORY_GOODS_IN_TRANSIT", "0.00", "600.00"]]);
    // Run again the same day: replaced, not doubled.
    await run(today);
    expect(await receiptLines(today)).toEqual([["FACTORY_GOODS_IN_TRANSIT", "0.00", "600.00"]]);

    await receipt("500");
    await run(day(1));
    expect(await receiptLines(day(1))).toEqual([
      ["FACTORY_GOODS_IN_TRANSIT", "0.00", "400.00"],
      [`${PREFIX}_IMPORT_EXP`, "0.00", "100.00"],
    ]);
    expect((await asMaintenance(() => factoryGoodsInTransitHeld(db, ctx.companyId, day(1)))).toFixed(2)).toBe("0.00");

    // The first receipt is deleted after its day's journal: today's journals stay; the change day reverses it.
    await query(`UPDATE factory_container_receipts SET deleted_at = now() WHERE id = $1`, [firstReceipt]);
    await run(day(2));
    expect(await receiptLines(day(2))).toEqual([
      ["FACTORY_GOODS_IN_TRANSIT", "500.00", "0.00"],
      [`${PREFIX}_IMPORT_EXP`, "100.00", "0.00"],
    ]);
    expect(await receiptLines(today)).toEqual([["FACTORY_GOODS_IN_TRANSIT", "0.00", "600.00"]]);
    expect((await asMaintenance(() => factoryGoodsInTransitHeld(db, ctx.companyId, day(2)))).toFixed(2)).toBe("500.00");
  }, 90_000);
});

describe("STOCK-IN per offload (item 7)", () => {
  it("posts one journal per offload, dated with it, and leaves an earlier one untouched", async () => {
    await setCutover(CUTOVER);
    const supplier = await query(
      `INSERT INTO suppliers (company_id, code, legal_name, email, active) VALUES ($1, $2, $3, $4, true) RETURNING id`,
      [ctx.companyId, `${PREFIX}SUP`, `${PREFIX} Supplier`, "w17b@example.test"]
    );
    const container = await query(
      `INSERT INTO containers (company_id, container_number, supplier_id, status, import_date, charges_total, offload_date)
       VALUES ($1, $2, $3, 'OFFLOADED', '2025-12-15', '0', $4) RETURNING id`,
      [ctx.companyId, `${PREFIX}-C1`, supplier.rows[0].id, today]
    );
    const containerId = container.rows[0].id;
    const po = await asMaintenance(() =>
      createPurchaseOrder(
        {
          companyId: ctx.companyId,
          poNumber: `${PREFIX}-PO1`,
          containerId,
          supplierId: supplier.rows[0].id,
          currency: "USD",
          status: "Open",
          itemsTotal: "130.00",
        },
        "2025-12-15"
      )
    );
    const [itemA, itemB] = ctx.stockItemIds;
    await query(
      `INSERT INTO po_line_items (po_id, stock_item_id, item_name, quantity, rate, line_total)
       VALUES ($1, $2, 'line', '10', '5.00', '50.00'), ($1, $3, 'line', '20', '4.00', '80.00')`,
      [po.id, itemA, itemB]
    );
    // The opening carried the PO as goods in transit.
    await setCutover(CUTOVER, { goodsInTransitPurchaseOrderIds: [po.id] });

    const offload = async (date: string, stockItemId: number, quantity: string, value: string) => {
      const created = await query(
        `INSERT INTO container_offloads (container_id, location_id, total_bales, additional_cost_per_bale, offloaded_at)
         VALUES ($1, $2, $3, 0, $4::date) RETURNING id`,
        [containerId, ctx.locationId, quantity, date]
      );
      await query(
        `INSERT INTO container_offload_items (offload_id, stock_item_id, quantity, rate, total_value, value_moved)
         VALUES ($1, $2, $3, 1, $4, $4)`,
        [created.rows[0].id, stockItemId, quantity, value]
      );
      return created.rows[0].id as number;
    };
    const sync = () =>
      asMaintenance(() => db.transaction((tx) => syncContainerStockInTx(tx, ctx.companyId, containerId)));

    // A partial offload: 10 of the 30 bales.
    const firstOffload = await offload(day(-1), itemA, "10", "50.00");
    await query(`UPDATE containers SET offload_date = $2 WHERE id = $1`, [containerId, day(-1)]);
    await sync();
    const firstNumber = `STOCK-IN-${containerId}-${firstOffload}`;
    expect(await journal(firstNumber)).toEqual([
      [firstNumber, "GOODS_IN_TRANSIT", "0.00", "43.33"],
      [firstNumber, "INVENTORY", "50.00", "0.00"],
      [firstNumber, "PURCHASES", "0.00", "6.67"],
    ]);
    const firstJournal = await query(`SELECT id, voucher_date::text AS date FROM vouchers WHERE voucher_number = $1`, [
      firstNumber,
    ]);
    expect(firstJournal.rows[0].date).toBe(day(-1));

    // The rest arrives today: its own journal takes the rest of the transit; the first is not rewritten.
    const secondOffload = await offload(today, itemB, "20", "80.00");
    await query(`UPDATE containers SET offload_date = $2 WHERE id = $1`, [containerId, today]);
    await sync();
    const secondNumber = `STOCK-IN-${containerId}-${secondOffload}`;
    expect(await journal(secondNumber)).toEqual([
      [secondNumber, "GOODS_IN_TRANSIT", "0.00", "86.67"],
      [secondNumber, "INVENTORY", "80.00", "0.00"],
      [secondNumber, "PURCHASES", "6.67", "0.00"],
    ]);
    const after = await query(`SELECT id FROM vouchers WHERE voucher_number = $1 AND deleted_at IS NULL`, [
      firstNumber,
    ]);
    expect(after.rows[0].id).toBe(firstJournal.rows[0].id);
  }, 90_000);
});

describe("transfer import provisional cost (item 9)", () => {
  it("takes the latest average, else the last purchase cost, else the selling price", async () => {
    const [withAverage, withPurchase, withNothing] = ctx.stockItemIds;
    await query(`DELETE FROM inventory WHERE company_id = $1`, [ctx.companyId]);
    await query(
      `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value)
       VALUES ($1, $2, $3, 1, 7.25, 7.25)`,
      [ctx.companyId, ctx.location2Id, withAverage]
    );
    const rate = (id: number, sellingPrice: string) =>
      asMaintenance(() => provisionalTransferImportRate(db, ctx.companyId, { id, sellingPrice }));
    expect(await rate(withAverage, "99")).toMatchObject({ basis: "average_rate" });
    expect((await rate(withAverage, "99")).rate.toFixed(2)).toBe("7.25");
    // The PO of the STOCK-IN test carries itemB at 4.00.
    expect(await rate(withPurchase, "99")).toMatchObject({ basis: "purchase_cost" });
    expect((await rate(withPurchase, "99")).rate.toFixed(2)).toBe("4.00");
    const fallback = await rate(withNothing ?? 999_999_999, "12.50");
    expect(fallback.basis).toBe("selling_price");
    expect(fallback.rate.toFixed(2)).toBe("12.50");
  });
});

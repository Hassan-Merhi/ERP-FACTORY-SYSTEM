/**
 * Phase 24 (M5) review findings on the PO import:
 *
 *   - the currency and rate are resolved per PO, so a container may hold an
 *     EUR PO and a USD PO (before: one currency across the whole container,
 *     refused as PO_IMPORT_MIXED_CURRENCY); a PO whose own items mix currencies
 *     is still refused, and so is a mixed-currency container with container
 *     charges (the charges state no currency);
 *   - the container's totals and its container_charges records are USD, like
 *     its POs' money columns (before: the raw native preview totals).
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { ensureCurrencyNormalizationGuard } from "../server/services/accounting/currencyNormalizationGuard";
import { ensurePurchaseOrderCurrencySchema } from "../server/services/accounting/fx/purchaseOrderCurrencySchema";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "p24poccy";
let ctx: TestContext;
let agent: request.SuperAgentTest;
let supplierId = 0;
let items: Array<{ id: number; code: string; name: string }> = [];

type Charges = Partial<Record<"freight" | "surcharge" | "fumigation" | "documentCharges" | "discount", number>>;

function line(index: number, poNumber: string, quantity: number, rate: number, currency: string) {
  const item = items[index];
  return {
    poNumber,
    stockItemId: item.id,
    barcode: item.code,
    itemName: item.name,
    quantity,
    rate,
    lineTotal: quantity * rate,
    currency,
  };
}

function send(containerNumber: string, lines: ReturnType<typeof line>[], charges: Charges = {}) {
  const itemsTotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
  const chargesTotal =
    (charges.freight ?? 0) +
    (charges.surcharge ?? 0) +
    (charges.fumigation ?? 0) +
    (charges.documentCharges ?? 0) -
    (charges.discount ?? 0);
  return agent.post("/api/po-import/import").send({
    fileHash: `${PREFIX}-${containerNumber}`,
    fileName: `${PREFIX}.xlsx`,
    containerNumber,
    supplierId,
    importDate: "2026-03-10",
    freightPaidBy: "supplier",
    preview: [
      {
        containerNumber,
        itemsTotal,
        chargesTotal,
        grandTotal: itemsTotal + chargesTotal,
        itemsCount: lines.length,
        charges: { otherCharges: 0, ...charges },
        items: lines,
      },
    ],
  });
}

async function containerRow(containerNumber: string) {
  return (
    await pool.query(
      `SELECT id, items_total::text AS items, charges_total::text AS charges, grand_total::text AS grand
         FROM containers WHERE company_id = $1 AND container_number = $2`,
      [ctx.companyId, containerNumber]
    )
  ).rows[0];
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  expect(await ensureCurrencyNormalizationGuard(pool)).toBe(true);
  await ensurePurchaseOrderCurrencySchema(pool);
  agent = request.agent(ctx.app);
  expect(
    (await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" })).status
  ).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
  const supplier = await pool.query<{ id: number }>(
    `INSERT INTO suppliers (company_id, code, legal_name, email, opening_balance, active)
     VALUES ($1, $2, $3, $4, '0', true) RETURNING id`,
    [ctx.companyId, `${PREFIX}-SUP`, `${PREFIX} Supplier`, `${PREFIX}@example.test`]
  );
  supplierId = supplier.rows[0].id;
  items = (
    await pool.query(`SELECT id, code, name FROM stock_items WHERE id = ANY($1) ORDER BY id`, [ctx.stockItemIds])
  ).rows;
  // 0.8 EUR per USD.
  await pool.query(
    `INSERT INTO exchange_rates (company_id, from_currency, to_currency, rate, effective_date)
     VALUES ($1, 'USD', 'EUR', '0.800000', '2026-03-01')`,
    [ctx.companyId]
  );
}, 120000);

afterAll(async () => {
  await withFixtureTransaction(async (client) => {
    await client.query(`SET LOCAL app.ledger_integrity_bypass = 'on'`);
    await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
    await client.query(
      `DELETE FROM po_line_items WHERE po_id IN (SELECT id FROM purchase_orders WHERE company_id = $1)`,
      [ctx.companyId]
    );
    await client.query(`DELETE FROM purchase_orders WHERE company_id = $1`, [ctx.companyId]);
    await client.query(
      `DELETE FROM container_charges WHERE container_id IN (SELECT id FROM containers WHERE company_id = $1)`,
      [ctx.companyId]
    );
    await client.query(
      `DELETE FROM import_logs WHERE container_id IN (SELECT id FROM containers WHERE company_id = $1)`,
      [ctx.companyId]
    );
    await client.query(`DELETE FROM containers WHERE company_id = $1`, [ctx.companyId]);
    await client.query(`DELETE FROM accounting_posting_requests WHERE company_id = $1`, [ctx.companyId]);
    await client.query(
      `DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`,
      [ctx.companyId]
    );
    await client.query(`DELETE FROM vouchers WHERE company_id = $1`, [ctx.companyId]);
    await client.query(`DELETE FROM exchange_rates WHERE company_id = $1`, [ctx.companyId]);
  });
  await deleteAuditLogRowsForTests(pool, "company_id = $1", [ctx.companyId]);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60000);

describe("review finding: the container of a foreign-currency import is in USD", () => {
  it("writes the container totals and charge records in USD, the same cents as its PO", async () => {
    const containerNumber = `${PREFIX.toUpperCase()}-EUR-${Date.now()}`;
    const poNumber = `${containerNumber}-PO`;
    // EUR 800 of goods, EUR 80 freight, EUR 8 discount at 0.8 EUR/USD.
    const res = await send(containerNumber, [line(0, poNumber, 10, 80, "EUR")], { freight: 80, discount: 8 });
    expect(res.status).toBe(200);
    const container = await containerRow(containerNumber);
    expect(container).toMatchObject({ items: "1000.00", charges: "90.00", grand: "1090.00" });
    const charges = await pool.query(
      `SELECT charge_type, amount::text AS amount FROM container_charges WHERE container_id = $1 ORDER BY charge_type`,
      [container.id]
    );
    expect(charges.rows).toEqual([
      { charge_type: "Discount", amount: "-10.00" },
      { charge_type: "Freight", amount: "100.00" },
    ]);
    const po = (
      await pool.query(
        `SELECT items_total::text AS items, freight::text AS freight, discount::text AS discount,
                native_grand_total::text AS native_grand
           FROM purchase_orders WHERE company_id = $1 AND po_number = $2`,
        [ctx.companyId, poNumber]
      )
    ).rows[0];
    // The native figures stay on the PO; the container carries the PO's USD.
    expect(po).toEqual({ items: "1000.00", freight: "100.00", discount: "10.00", native_grand: "872.00" });
  });
});

describe("review finding: the currency is resolved per PO", () => {
  it("imports a container holding an EUR PO and a USD PO, each in its currency, the container in USD", async () => {
    const containerNumber = `${PREFIX.toUpperCase()}-MIX-${Date.now()}`;
    const eurPo = `${containerNumber}-E`;
    const usdPo = `${containerNumber}-U`;
    const res = await send(containerNumber, [line(0, eurPo, 10, 80, "EUR"), line(1, usdPo, 5, 30, "USD")]);
    expect(res.status).toBe(200);
    const pos = await pool.query(
      `SELECT po.po_number, po.currency, po.native_currency, po.items_total::text AS items, v.currency AS voucher_currency
         FROM purchase_orders po JOIN vouchers v ON v.id = po.voucher_id
        WHERE po.company_id = $1 AND po.po_number = ANY($2) ORDER BY po.po_number`,
      [ctx.companyId, [eurPo, usdPo]]
    );
    expect(pos.rows).toEqual([
      { po_number: eurPo, currency: "USD", native_currency: "EUR", items: "1000.00", voucher_currency: "EUR" },
      { po_number: usdPo, currency: "USD", native_currency: "USD", items: "150.00", voucher_currency: "USD" },
    ]);
    expect(await containerRow(containerNumber)).toMatchObject({ items: "1150.00", charges: "0.00", grand: "1150.00" });
  });

  it("still refuses a PO whose own items mix currencies, and container charges on a mixed container", async () => {
    const stamp = Date.now();
    const mixedPo = await send(`${PREFIX.toUpperCase()}-BAD-${stamp}`, [
      line(0, `${PREFIX}-BAD-${stamp}`, 1, 10, "EUR"),
      line(1, `${PREFIX}-BAD-${stamp}`, 1, 10, "USD"),
    ]);
    expect(mixedPo.status).toBe(400);
    expect(mixedPo.body.code).toBe("PO_IMPORT_MIXED_CURRENCY");

    const charged = `${PREFIX.toUpperCase()}-CHG-${stamp}`;
    const withCharges = await send(
      charged,
      [line(0, `${charged}-E`, 1, 10, "EUR"), line(1, `${charged}-U`, 1, 10, "USD")],
      {
        freight: 5,
      }
    );
    expect(withCharges.status).toBe(400);
    expect(withCharges.body.code).toBe("PO_IMPORT_MIXED_CURRENCY_CHARGES");
    const written = await pool.query(`SELECT COUNT(*)::int AS n FROM containers WHERE container_number = $1`, [
      charged,
    ]);
    expect(written.rows[0].n).toBe(0);
  });
});

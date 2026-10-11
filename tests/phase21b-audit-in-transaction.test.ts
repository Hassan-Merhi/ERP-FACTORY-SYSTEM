/**
 * Phase 21 (B) — audit rows inside their transactions
 * (docs/accounting-audit-2026-10.md, section 13 AT1a/AT1b/AT1c and the wave log).
 *
 * For one writer of each group, through the real route:
 *   (1) after a successful write its audit row exists, and
 *   (2) when the audit insert fails, the write is rolled back (nothing of it is
 *       left), instead of committing without its audit row.
 *
 * The failure is forced by a temporary BEFORE INSERT trigger on audit_log that
 * raises for the application rows (not the 21 A `row_*` rows) of one table
 * while that table is listed in a control table; both are dropped afterwards.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "p21baud";
const FACTORY_PREFIX = "p21bfac";
const TODAY = new Date().toISOString().slice(0, 10);

let erp: TestContext;
let factory: TestContext;
let agent: request.SuperAgentTest;
let factoryAgent: request.SuperAgentTest;
let sequence = 0;
const nextName = (label: string) => `${PREFIX}-${label}-${++sequence}`;

type AppAuditRow = { action: string; record_id: number | null; changes: Record<string, unknown> | null };

/** Application audit rows (the database trigger's row_* rows excluded). */
async function appAudits(companyId: number, tableName: string, recordId?: number | null): Promise<AppAuditRow[]> {
  const result = await pool.query<AppAuditRow>(
    `SELECT action, record_id, changes FROM audit_log
      WHERE company_id = $1 AND table_name = $2 AND action NOT LIKE 'row\\_%'
        AND ($3::int IS NULL OR record_id = $3)
      ORDER BY id`,
    [companyId, tableName, recordId ?? null]
  );
  return result.rows;
}

/** Runs `run` while every application audit insert for `tableName` fails. */
async function withFailingAudit(tableName: string, run: () => Promise<void>): Promise<void> {
  await pool.query(`INSERT INTO p21b_audit_fail (table_name) VALUES ($1) ON CONFLICT DO NOTHING`, [tableName]);
  try {
    await run();
  } finally {
    await pool.query(`DELETE FROM p21b_audit_fail WHERE table_name = $1`, [tableName]);
  }
}

const count = async (text: string, params: unknown[]) =>
  Number((await pool.query<{ n: string }>(text, params)).rows[0].n);

async function login(context: TestContext, prefix: string): Promise<request.SuperAgentTest> {
  const session = request.agent(context.app) as request.SuperAgentTest;
  const response = await session
    .post("/api/auth/login")
    .send({ username: `${prefix}_testuser`, password: "testpassword123" });
  expect(response.status).toBe(200);
  expect((await session.post("/api/auth/set-company").send({ companyId: context.companyId })).status).toBe(200);
  return session;
}

async function inventoryQuantity(locationId: number, stockItemId: number): Promise<number> {
  const { rows } = await pool.query(`SELECT quantity FROM inventory WHERE location_id = $1 AND stock_item_id = $2`, [
    locationId,
    stockItemId,
  ]);
  return Number(rows[0]?.quantity ?? 0);
}

const sale = (quantity: number) =>
  agent.post("/api/pos/sales").send({
    locationId: erp.locationId,
    items: [{ stockItemId: erp.stockItemIds[0], quantity, rate: 50 }],
    paymentAccountType: "ledger",
    paymentAccountId: erp.cashAccountId,
    voucherDate: TODAY,
  });

async function createTransfer(quantity: number): Promise<{ transferId: number; voucherId: number }> {
  const response = await agent.post("/api/stock-transfers").send({
    sourceLocationId: erp.locationId,
    destinationLocationId: erp.location2Id,
    items: [{ stockItemId: erp.stockItemIds[0], quantity: String(quantity), sourceLocationId: erp.locationId }],
    notes: "phase 21 b",
    voucherDate: TODAY,
    clientRequestId: nextName("transfer"),
  });
  expect(response.status, response.text).toBe(201);
  const transferId = Number(response.body.transfer.id);
  const { rows } = await pool.query(`SELECT voucher_id FROM stock_transfer_vouchers WHERE id = $1`, [transferId]);
  return { transferId, voucherId: Number(rows[0].voucher_id) };
}

async function stockVoucher(type: string): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO vouchers (company_id, voucher_type, voucher_number, voucher_date, description, total_amount, optional)
     VALUES ($1, $2, $3, CURRENT_DATE, 'phase 21 b', '0', false) RETURNING id`,
    [erp.companyId, type, nextName("adj")]
  );
  return Number(rows[0].id);
}

async function productionAdjustment(): Promise<number> {
  const voucherId = await stockVoucher("Stock Adjustment");
  const response = await agent.post("/api/stock-adjustments").send({
    voucherId,
    locationId: erp.locationId,
    adjustmentType: "Production",
    notes: "phase 21 b",
    items: [{ stockItemId: erp.stockItemIds[1] ?? erp.stockItemIds[0], quantity: "6", rate: "3.00" }],
  });
  expect(response.status, response.text).toBeLessThan(300);
  return voucherId;
}

beforeAll(async () => {
  erp = await seedTestData(PREFIX);
  factory = await seedTestData(FACTORY_PREFIX);
  await pool.query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [factory.companyId]);
  agent = await login(erp, PREFIX);
  factoryAgent = await login(factory, FACTORY_PREFIX);

  await pool.query(`CREATE TABLE IF NOT EXISTS p21b_audit_fail (table_name text PRIMARY KEY)`);
  await pool.query(`
    CREATE OR REPLACE FUNCTION p21b_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.action NOT LIKE 'row\\_%' AND EXISTS (SELECT 1 FROM p21b_audit_fail f WHERE f.table_name = NEW.table_name) THEN
        RAISE EXCEPTION 'phase 21 b: forced audit failure on %', NEW.table_name;
      END IF;
      RETURN NEW;
    END $$`);
  await pool.query(`DROP TRIGGER IF EXISTS p21b_fail_audit ON audit_log`);
  await pool.query(
    `CREATE TRIGGER p21b_fail_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION p21b_fail_audit()`
  );

  await db
    .insert(schema.inventory)
    .values({
      companyId: erp.companyId,
      locationId: erp.locationId,
      stockItemId: erp.stockItemIds[0],
      quantity: "500.000",
      averageRate: "10.00",
      totalValue: "5000.00",
    })
    .onConflictDoNothing();
}, 120_000);

afterAll(async () => {
  await pool.query(`DROP TRIGGER IF EXISTS p21b_fail_audit ON audit_log`).catch(() => undefined);
  await pool.query(`DROP FUNCTION IF EXISTS p21b_fail_audit()`).catch(() => undefined);
  await pool.query(`DROP TABLE IF EXISTS p21b_audit_fail`).catch(() => undefined);
  for (const context of [erp, factory]) {
    if (!context) continue;
    const companyId = context.companyId;
    for (const statement of [
      `DELETE FROM factory_payroll_items WHERE payroll_id IN (SELECT id FROM factory_payrolls WHERE company_id = $1)`,
      `DELETE FROM factory_payrolls WHERE company_id = $1`,
      `DELETE FROM factory_workers WHERE company_id = $1`,
      `DELETE FROM customer_orders WHERE company_id = $1`,
      `DELETE FROM factory_bales WHERE company_id = $1`,
      `DELETE FROM factory_mix_batches WHERE company_id = $1`,
      `DELETE FROM factory_suppliers WHERE company_id = $1`,
      `DELETE FROM property_units WHERE company_id = $1`,
      `DELETE FROM role_feature_permissions WHERE company_id = $1`,
      `DELETE FROM stock_categories WHERE company_id = $1`,
      `DELETE FROM fiscal_period_closures WHERE company_id = $1`,
      `DELETE FROM accounting_posting_requests WHERE company_id = $1`,
    ]) {
      await pool.query(statement, [companyId]).catch(() => undefined);
    }
    await deleteAuditLogRowsForTests(pool, "company_id = $1", [companyId]);
  }
  await cleanupTestData(PREFIX);
  await cleanupTestData(FACTORY_PREFIX);
  closeTestServer();
}, 120_000);

describe("AT1a money paths", () => {
  it("POS sale create: one audit row with the items in the sale's transaction; a failed audit leaves no sale", async () => {
    const created = await sale(3);
    expect(created.status, created.text).toBe(200);
    const voucherId = Number(created.body.voucher.id);
    const rows = (await appAudits(erp.companyId, "vouchers", voucherId)).filter((row) => row.action === "create");
    // The route's duplicate after-commit summary row is gone: one row, with the items.
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0].changes)).toContain('"items"');

    const salesBefore = await count(
      `SELECT COUNT(*) AS n FROM vouchers WHERE company_id = $1 AND voucher_type = 'Sales'`,
      [erp.companyId]
    );
    const stockBefore = await inventoryQuantity(erp.locationId, erp.stockItemIds[0]);
    await withFailingAudit("vouchers", async () => {
      expect((await sale(2)).status).toBeGreaterThanOrEqual(400);
    });
    expect(
      await count(`SELECT COUNT(*) AS n FROM vouchers WHERE company_id = $1 AND voucher_type = 'Sales'`, [
        erp.companyId,
      ])
    ).toBe(salesBefore);
    expect(await inventoryQuantity(erp.locationId, erp.stockItemIds[0])).toBe(stockBefore);
  });

  it("POS sale edit: audited in the edit's transaction; a failed audit keeps the sale as it was", async () => {
    const created = await sale(5);
    const voucherId = Number(created.body.voucher.id);
    const edit = (quantity: number) =>
      agent.put(`/api/vouchers/${voucherId}/sales`).send({
        locationId: erp.locationId,
        items: [{ stockItemId: erp.stockItemIds[0], quantity, sellingPrice: 50 }],
        paymentAccountType: "ledger",
        paymentAccountId: erp.cashAccountId,
      });
    expect((await edit(4)).status).toBe(200);
    expect((await appAudits(erp.companyId, "vouchers", voucherId)).filter((r) => r.action === "update")).toHaveLength(
      1
    );

    await withFailingAudit("vouchers", async () => {
      expect((await edit(2)).status).toBeGreaterThanOrEqual(400);
    });
    const { rows } = await pool.query(`SELECT total_amount FROM vouchers WHERE id = $1`, [voucherId]);
    expect(Number(rows[0].total_amount)).toBe(200);
    expect((await appAudits(erp.companyId, "vouchers", voucherId)).filter((r) => r.action === "update")).toHaveLength(
      1
    );
  });

  it("stock transfer edit: the posted edit is audited with its header and items; a failed audit undoes it", async () => {
    const { transferId, voucherId } = await createTransfer(5);
    const edit = (quantity: number, description: string) =>
      agent.patch(`/api/vouchers/${voucherId}/transfer`).send({
        sourceLocationId: erp.locationId,
        destinationLocationId: erp.location2Id,
        description,
        items: [{ stockItemId: erp.stockItemIds[0], quantity, rate: 10, sourceLocationId: erp.locationId }],
      });
    expect((await edit(4, "edited")).status).toBe(200);
    const audits = (await appAudits(erp.companyId, "vouchers", voucherId)).filter((r) => r.action === "update");
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0].changes)).toContain('"items"');

    await withFailingAudit("vouchers", async () => {
      expect((await edit(2, "rolled back")).status).toBeGreaterThanOrEqual(400);
    });
    const items = await pool.query(`SELECT quantity FROM stock_transfer_items WHERE transfer_id = $1`, [transferId]);
    expect(items.rows.map((row) => Number(row.quantity))).toEqual([4]);
    const header = await pool.query(`SELECT description FROM vouchers WHERE id = $1`, [voucherId]);
    expect(header.rows[0].description).toBe("edited");
  });

  it("stock transfer revision: audited in the revision's transaction; a failed audit leaves no revision", async () => {
    const { transferId } = await createTransfer(5);
    const revise = (newQuantity: number) =>
      agent.post(`/api/stock-transfers/${transferId}/revisions`).send({
        optional: false,
        note: "phase 21 b",
        items: [
          {
            stockItemId: erp.stockItemIds[0],
            stockItemName: "Item",
            sourceLocationId: erp.locationId,
            originalQuantity: 5,
            newQuantity,
          },
        ],
      });
    await withFailingAudit("stock_transfer_revisions", async () => {
      expect((await revise(4)).status).toBeGreaterThanOrEqual(400);
    });
    expect(await count(`SELECT COUNT(*) AS n FROM stock_transfer_revisions WHERE transfer_id = $1`, [transferId])).toBe(
      0
    );

    const saved = await revise(4);
    expect(saved.status, saved.text).toBe(201);
    expect(await appAudits(erp.companyId, "stock_transfer_revisions", Number(saved.body.id))).toHaveLength(1);
  });

  it("stock adjustment delete: audited in the deletion's transaction; a failed audit keeps the adjustment", async () => {
    const kept = await productionAdjustment();
    await withFailingAudit("vouchers", async () => {
      expect((await agent.delete(`/api/vouchers/${kept}`)).status).toBeGreaterThanOrEqual(400);
    });
    const { rows } = await pool.query(`SELECT deleted_at FROM vouchers WHERE id = $1`, [kept]);
    expect(rows[0].deleted_at).toBeNull();

    expect((await agent.delete(`/api/vouchers/${kept}`)).status).toBe(200);
    expect((await appAudits(erp.companyId, "vouchers", kept)).filter((r) => r.action === "delete")).toHaveLength(1);
  });

  it("adjustment update (voucherPurchaseUpdateRoutes): the adjustment and its audit commit together", async () => {
    const patch = (voucherId: number) =>
      agent.patch(`/api/vouchers/${voucherId}/adjustment`).send({
        locationId: erp.locationId,
        description: "phase 21 b",
        items: [{ stockItemId: erp.stockItemIds[0], quantity: "2", rate: "3.00" }],
      });
    const failed = await stockVoucher("Production");
    await withFailingAudit("vouchers", async () => {
      expect((await patch(failed)).status).toBeGreaterThanOrEqual(400);
    });
    expect(await count(`SELECT COUNT(*) AS n FROM stock_adjustment_vouchers WHERE voucher_id = $1`, [failed])).toBe(0);

    const saved = await stockVoucher("Production");
    const response = await patch(saved);
    expect(response.status, response.text).toBe(200);
    expect((await appAudits(erp.companyId, "vouchers", saved)).filter((r) => r.action === "update")).toHaveLength(1);
  });

  it("fiscal reopen: the reopen and its audit commit together", async () => {
    const closingVoucherId = await withFixtureTransaction(async (client) => {
      const id = (
        await client.query(
          `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, optional)
           VALUES ($1, $2, 'Journal', '2021-06-30', '1.00', false) RETURNING id`,
          [erp.companyId, nextName("close")]
        )
      ).rows[0].id as number;
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount)
         VALUES ($1, $2, '1.00', 0), ($1, $3, 0, '1.00')`,
        [id, erp.cashAccountId, erp.salesAccountId]
      );
      return id;
    });
    const closureId = (
      await pool.query(
        `INSERT INTO fiscal_period_closures (company_id, period_start_date, period_end_date, closed_by_user_id,
           closing_voucher_id, retained_earnings_account_id, total_income, total_expense, net_income, status)
         VALUES ($1, '2021-01-01', '2021-06-30', $2, $3, $4, 0, 0, 0, 'CLOSED') RETURNING id`,
        [erp.companyId, erp.userId, closingVoucherId, erp.cashAccountId]
      )
    ).rows[0].id as number;

    await withFailingAudit("fiscal_period_closures", async () => {
      const response = await agent.post(`/api/fiscal-period/${closureId}/reopen`).send({ reason: "phase 21 b" });
      expect(response.status).toBeGreaterThanOrEqual(400);
    });
    expect(await count(`SELECT COUNT(*) AS n FROM fiscal_period_closures WHERE id = $1`, [closureId])).toBe(1);
    const voucher = await pool.query(`SELECT deleted_at FROM vouchers WHERE id = $1`, [closingVoucherId]);
    expect(voucher.rows[0].deleted_at).toBeNull();

    const reopened = await agent.post(`/api/fiscal-period/${closureId}/reopen`).send({ reason: "phase 21 b" });
    expect(reopened.status, reopened.text).toBe(200);
    expect(await appAudits(erp.companyId, "fiscal_period_closures", closureId)).toHaveLength(1);
  });
});

describe("AT1b factory writers", () => {
  it("payroll generation: the batch and its audit commit together", async () => {
    await pool.query(
      `INSERT INTO factory_workers (company_id, full_name, salary_type, base_salary, active)
       VALUES ($1, $2, 'Monthly', '1000.00', true)`,
      [factory.companyId, nextName("worker")]
    );
    const body = { companyId: factory.companyId, startDate: "2026-08-01", endDate: "2026-08-31" };
    await withFailingAudit("factory_payrolls", async () => {
      expect((await factoryAgent.post("/api/factory/payroll/generate").send(body)).status).toBeGreaterThanOrEqual(400);
    });
    expect(await count(`SELECT COUNT(*) AS n FROM factory_payrolls WHERE company_id = $1`, [factory.companyId])).toBe(
      0
    );

    const generated = await factoryAgent.post("/api/factory/payroll/generate").send(body);
    expect(generated.status, generated.text).toBe(200);
    expect(await appAudits(factory.companyId, "factory_payrolls")).toHaveLength(1);
  });

  it("bale rename: the rename and its audit commit together", async () => {
    const baleId = (
      await pool.query(
        `INSERT INTO factory_bales (company_id, bale_code, reference_number, weight_kg, product_name, status)
         VALUES ($1, $2, $2, '10.000', 'Before', 'PRESSED') RETURNING id`,
        [factory.companyId, nextName("bale")]
      )
    ).rows[0].id as number;
    await withFailingAudit("bales", async () => {
      const response = await factoryAgent.patch(`/api/factory/bales/${baleId}/product-name`).send({ name: "Lost" });
      expect(response.status).toBeGreaterThanOrEqual(400);
    });
    expect(
      (await pool.query(`SELECT product_name FROM factory_bales WHERE id = $1`, [baleId])).rows[0].product_name
    ).toBe("Before");

    expect((await factoryAgent.patch(`/api/factory/bales/${baleId}/product-name`).send({ name: "After" })).status).toBe(
      200
    );
    expect(await appAudits(factory.companyId, "bales", baleId)).toHaveLength(1);
  });

  it("customer order create: the order and its audit commit together", async () => {
    const customerId = (
      await pool.query(
        `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2::varchar, $2::text) RETURNING id`,
        [factory.companyId, nextName("cust")]
      )
    ).rows[0].id as number;
    const create = () => factoryAgent.post("/api/factory/customer-orders").send({ customerId, orderDate: TODAY });
    await withFailingAudit("factory_customer_orders", async () => {
      expect((await create()).status).toBeGreaterThanOrEqual(400);
    });
    expect(await count(`SELECT COUNT(*) AS n FROM customer_orders WHERE customer_id = $1`, [customerId])).toBe(0);

    const created = await create();
    expect(created.status, created.text).toBe(200);
    expect(await appAudits(factory.companyId, "factory_customer_orders", Number(created.body.id))).toHaveLength(1);
  });

  it("mix batch delete: the delete and its audit commit together", async () => {
    const mixId = (
      await pool.query(
        `INSERT INTO factory_mix_batches (company_id, batch_code, cost_per_kg, status) VALUES ($1, $2, '0', 'COMPLETED')
         RETURNING id`,
        [factory.companyId, nextName("mix")]
      )
    ).rows[0].id as number;
    await withFailingAudit("factory_mix_batches", async () => {
      expect((await factoryAgent.delete(`/api/factory/mix-batches/${mixId}`)).status).toBeGreaterThanOrEqual(400);
    });
    expect(
      (await pool.query(`SELECT deleted_at FROM factory_mix_batches WHERE id = $1`, [mixId])).rows[0].deleted_at
    ).toBeNull();

    expect((await factoryAgent.delete(`/api/factory/mix-batches/${mixId}`)).status).toBe(200);
    expect(await appAudits(factory.companyId, "factory_mix_batches", mixId)).toHaveLength(1);
  });

  it("raw stock supplier rate restore: the rate and its audit commit together", async () => {
    const supplierId = (
      await pool.query(
        `INSERT INTO factory_suppliers (company_id, name, current_raw_material_cost_per_kg_usd) VALUES ($1, $2, '1.000000')
         RETURNING id`,
        [factory.companyId, nextName("sup")]
      )
    ).rows[0].id as number;
    const restore = () =>
      factoryAgent
        .post("/api/factory/raw-stock/supplier-rate/restore-from-audit")
        .send({ restorations: [{ supplierId, rate: 1.25 }] });
    await withFailingAudit("factory_suppliers", async () => {
      expect((await restore()).status).toBeGreaterThanOrEqual(400);
    });
    const rate = async () =>
      Number(
        (
          await pool.query(`SELECT current_raw_material_cost_per_kg_usd AS r FROM factory_suppliers WHERE id = $1`, [
            supplierId,
          ])
        ).rows[0].r
      );
    expect(await rate()).toBe(1);

    expect((await restore()).status).toBe(200);
    expect(await rate()).toBe(1.25);
    expect(await appAudits(factory.companyId, "factory_suppliers", supplierId)).toHaveLength(1);
  });
});

describe("AT1c master data and settings", () => {
  it("stock category create: the row and its audit commit together", async () => {
    const lost = nextName("cat");
    await withFailingAudit("stock_categories", async () => {
      expect((await agent.post("/api/stock-categories").send({ name: lost })).status).toBeGreaterThanOrEqual(400);
    });
    expect(await count(`SELECT COUNT(*) AS n FROM stock_categories WHERE name = $1`, [lost])).toBe(0);

    const created = await agent.post("/api/stock-categories").send({ name: nextName("cat") });
    expect(created.status, created.text).toBe(201);
    expect(await appAudits(erp.companyId, "stock_categories", Number(created.body.id))).toHaveLength(1);
  });

  it("rental unit create: the unit and its audit commit together", async () => {
    const body = (unitNumber: string) => ({ unitType: "SHOP", locationGroup: "P21B", unitNumber });
    const lost = nextName("unit");
    await withFailingAudit("property_units", async () => {
      expect((await agent.post("/api/erp/rental/units").send(body(lost))).status).toBeGreaterThanOrEqual(400);
    });
    expect(await count(`SELECT COUNT(*) AS n FROM property_units WHERE unit_number = $1`, [lost])).toBe(0);

    const created = await agent.post("/api/erp/rental/units").send(body(nextName("unit")));
    expect(created.status, created.text).toBe(200);
    expect(await appAudits(erp.companyId, "property_units", Number(created.body.id))).toHaveLength(1);
  });

  it("role permissions (settings): the upserts and their audit rows commit together", async () => {
    const put = (featureKey: string) =>
      agent
        .put("/api/settings/role-permissions")
        .send({ permissions: [{ role: "Manager", featureKey, enabled: true }] });
    const lost = nextName("feature");
    await withFailingAudit("role_feature_permissions", async () => {
      expect((await put(lost)).status).toBeGreaterThanOrEqual(400);
    });
    expect(
      await count(`SELECT COUNT(*) AS n FROM role_feature_permissions WHERE company_id = $1 AND feature_key = $2`, [
        erp.companyId,
        lost,
      ])
    ).toBe(0);

    const kept = nextName("feature");
    expect((await put(kept)).status).toBe(200);
    const rows = await pool.query(
      `SELECT COUNT(*) AS n FROM audit_log WHERE company_id = $1 AND table_name = 'role_feature_permissions'
         AND record_identifier LIKE $2`,
      [erp.companyId, `%feature:${kept} %`]
    );
    expect(Number(rows.rows[0].n)).toBe(1);
  });
});

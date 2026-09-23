import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const RUN_ID = Date.now().toString(36);
const TEST_PREFIX = `spcharge-${RUN_ID}`;

let ctx: TestContext;
let companyId: number;
let locationId: number;
let stockItemId: number;
let bankAccountId: number;
let payableAccountId: number;
let agent: request.SuperAgentTest;

async function accountId(subType: string): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `SELECT id FROM ledger_accounts WHERE company_id = $1 AND sub_type = $2 AND deleted_at IS NULL LIMIT 1`,
    [companyId, subType]
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error(`Missing SP account ${subType}`);
  return id;
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  const bcrypt = await import("bcryptjs");
  const password = await bcrypt.hash("testpassword123", 10);

  const [user] = await db.insert(schema.users).values({ username: `${TEST_PREFIX}_user`, password }).returning();
  const [company] = await db.insert(schema.companies).values({
    code: `SPC-${RUN_ID}`,
    name: `${TEST_PREFIX} Company`,
    baseCurrency: "USD",
    companyType: "supplier_partner",
  }).returning();
  companyId = company.id;

  await db.insert(schema.userCompanyRoles).values({ userId: user.id, companyId, role: "Admin" });
  const [item] = await db.insert(schema.stockItems).values({
    companyId,
    code: `${TEST_PREFIX}-ITEM`,
    name: "SP charge lifecycle item",
    uom: "PCS",
    stockGroupId: null,
    active: true,
  }).returning();
  stockItemId = item.id;

  agent = request.agent(ctx.app);
  expect((await agent.post("/api/auth/login").send({ username: `${TEST_PREFIX}_user`, password: "testpassword123" })).status).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId })).status).toBe(200);
  const setup = await agent.post("/api/sp/setup").send({
    confirmation: "CHANGE SP SETUP",
    reason: "Initialize SP charge lifecycle integration test",
    idempotencyKey: `setup-${RUN_ID}`,
  });
  expect(setup.status).toBe(200);

  const [location] = await db.select().from(schema.locations).where(eq(schema.locations.companyId, companyId)).limit(1);
  if (!location) throw new Error("SP setup did not create a location");
  locationId = location.id;
  payableAccountId = await accountId("sp_payable");

  const [bank] = await db.insert(schema.bankAccounts).values({
    companyId,
    code: `${TEST_PREFIX}-BANK`,
    name: "SP charge lifecycle bank",
    bankName: "SP charge lifecycle bank",
    accountNumber: `${Date.now()}`,
    openingBalance: "0",
    openingBalanceSide: "Dr",
  }).returning();
  bankAccountId = bank.id;
}, 90_000);

afterAll(async () => {
  if (companyId) {
    await pool.query(`DELETE FROM sp_offload_charges WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM sp_stock_movements WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM sp_offloads WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM sp_prepaid_charges WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM sp_container_lines WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM sp_containers WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`, [companyId]);
    await pool.query(`DELETE FROM vouchers WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM canonical_stock_movement_audit WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM canonical_stock_movement_requests WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM canonical_stock_movements WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM inventory WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM bank_accounts WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM stock_items WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM ledger_accounts WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM locations WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM sp_audit_events WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM sp_idempotency_keys WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM sp_permission_grants WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM user_company_roles WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM audit_log WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM login_history WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM companies WHERE id = $1`, [companyId]);
    await pool.query(`DELETE FROM users WHERE username = $1`, [`${TEST_PREFIX}_user`]);
  }
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 30_000);

describe("SP offload charge lifecycle", () => {
  it("posts prepaid, paid-now and unpaid-payable charges into one balanced landed-cost result", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const baseCost = 1000;
    const prepaidAmount = 100;
    const paidNowAmount = 50;
    const unpaidAmount = 25;
    const landedCharges = prepaidAmount + paidNowAmount + unpaidAmount;

    const create = await agent.post("/api/sp/containers").send({
      supplierName: "Charge Lifecycle Supplier",
      containerNumber: `${TEST_PREFIX}-CONT`,
      invoiceNumber: `${TEST_PREFIX}-INV`,
      invoiceDate: today,
      invoiceTotalUsd: baseCost,
      discountPct: 0,
      freightEstimateUsd: 0,
      lines: [{ articleCode: `${TEST_PREFIX}-ITEM`, description: "SP charge lifecycle item", qty: 50, unitRateUsd: 20, stockItemId }],
    });
    expect(create.status).toBe(200);
    const containerId = Number(create.body.id);

    const [prepaid] = await db.insert(schema.spPrepaidCharges).values({ companyId, containerId, prepaidDate: today, chargeType: "freight", amountPaidUsd: "150", amountUsedUsd: "0", notes: "Charge lifecycle prepaid" }).returning();

    const offload = await agent.post("/api/sp/offload").send({
      containerId, offloadDate: today, locationId,
      chargeLines: [
        { chargeType: "prepaid_used", amountUsd: prepaidAmount, prepaidChargeId: String(prepaid.id), description: "Prepaid freight" },
        { chargeType: "paid_now", amountUsd: paidNowAmount, creditBankAccountId: String(bankAccountId), description: "Cash transport" },
        { chargeType: "unpaid_payable", amountUsd: unpaidAmount, creditLedgerAccountId: String(payableAccountId), description: "Unpaid handling" },
      ],
    });
    expect(offload.status).toBe(200);

    const offloadRow = await pool.query<{ id: number; total_base_cost_usd: string; total_landed_cost_usd: string; total_final_cost_usd: string; voucher_id_stock: number }>(`SELECT id, total_base_cost_usd, total_landed_cost_usd, total_final_cost_usd, voucher_id_stock FROM sp_offloads WHERE company_id = $1 AND container_id = $2 LIMIT 1`, [companyId, containerId]);
    expect(offloadRow.rows).toHaveLength(1);
    const posted = offloadRow.rows[0];
    expect(Number(posted.total_base_cost_usd)).toBeCloseTo(baseCost, 2);
    expect(Number(posted.total_landed_cost_usd)).toBeCloseTo(landedCharges, 2);
    expect(Number(posted.total_final_cost_usd)).toBeCloseTo(baseCost + landedCharges, 2);

    const charges = await pool.query<{ charge_type: string; amount_usd: string; prepaid_charge_id: number | null; credit_bank_account_id: number | null; credit_ledger_account_id: number | null }>(`SELECT charge_type, amount_usd, prepaid_charge_id, credit_bank_account_id, credit_ledger_account_id FROM sp_offload_charges WHERE company_id = $1 AND offload_id = $2 ORDER BY charge_type`, [companyId, posted.id]);
    expect(charges.rows).toHaveLength(3);
    expect(charges.rows.find((row) => row.charge_type === "prepaid_used")?.prepaid_charge_id).toBe(prepaid.id);
    expect(charges.rows.find((row) => row.charge_type === "paid_now")?.credit_bank_account_id).toBe(bankAccountId);
    expect(charges.rows.find((row) => row.charge_type === "unpaid_payable")?.credit_ledger_account_id).toBe(payableAccountId);

    const [prepaidAfter] = await db.select().from(schema.spPrepaidCharges).where(eq(schema.spPrepaidCharges.id, prepaid.id));
    expect(Number(prepaidAfter.amountUsedUsd)).toBeCloseTo(prepaidAmount, 2);

    const [inventory] = await db.select().from(schema.inventory).where(and(eq(schema.inventory.companyId, companyId), eq(schema.inventory.locationId, locationId), eq(schema.inventory.stockItemId, stockItemId))).limit(1);
    expect(Number(inventory.quantity)).toBeCloseTo(50, 4);
    expect(Number(inventory.totalValue ?? 0)).toBeCloseTo(baseCost + landedCharges, 2);
    expect(Number(inventory.averageRate)).toBeCloseTo((baseCost + landedCharges) / 50, 4);

    const totals = await pool.query<{ dr: string; cr: string }>(`SELECT COALESCE(SUM(debit_amount::numeric), 0)::text AS dr, COALESCE(SUM(credit_amount::numeric), 0)::text AS cr FROM voucher_entries WHERE voucher_id = $1`, [posted.voucher_id_stock]);
    expect(Number(totals.rows[0].dr)).toBeCloseTo(baseCost + landedCharges, 2);
    expect(Number(totals.rows[0].dr)).toBeCloseTo(Number(totals.rows[0].cr), 2);
  });

  it("rolls back prepaid usage and every offload side effect when a later paid-now bank reference is invalid", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const suffix = `${TEST_PREFIX}-ROLLBACK`;
    const create = await agent.post("/api/sp/containers").send({
      supplierName: "Rollback Supplier", containerNumber: `${suffix}-CONT`, invoiceNumber: `${suffix}-INV`, invoiceDate: today,
      invoiceTotalUsd: 400, discountPct: 0, freightEstimateUsd: 0,
      lines: [{ articleCode: `${TEST_PREFIX}-ITEM`, description: "Rollback item", qty: 20, unitRateUsd: 20, stockItemId }],
    });
    expect(create.status).toBe(200);
    const containerId = Number(create.body.id);
    const [prepaid] = await db.insert(schema.spPrepaidCharges).values({ companyId, containerId, prepaidDate: today, chargeType: "freight", amountPaidUsd: "80", amountUsedUsd: "0", notes: "Rollback prepaid" }).returning();

    const before = await pool.query<{ vouchers: string; inventory_qty: string }>(`SELECT (SELECT COUNT(*) FROM vouchers WHERE company_id = $1)::text AS vouchers, COALESCE((SELECT SUM(quantity::numeric) FROM inventory WHERE company_id = $1 AND location_id = $2 AND stock_item_id = $3), 0)::text AS inventory_qty`, [companyId, locationId, stockItemId]);

    // The offload guard rejects an invalid bank before posting, while the route still
    // validates charge ownership inside its transaction as defense in depth. Either
    // path must leave prepaid, vouchers, inventory and offload state unchanged.
    const failed = await agent.post("/api/sp/offload").send({
      containerId, offloadDate: today, locationId,
      chargeLines: [
        { chargeType: "prepaid_used", amountUsd: 60, prepaidChargeId: String(prepaid.id), description: "Prepaid before failure" },
        { chargeType: "paid_now", amountUsd: 10, creditBankAccountId: "2147483647", description: "Invalid bank forces rollback" },
      ],
    });
    expect(failed.status).toBeGreaterThanOrEqual(400);

    const [prepaidAfter] = await db.select().from(schema.spPrepaidCharges).where(eq(schema.spPrepaidCharges.id, prepaid.id));
    expect(Number(prepaidAfter.amountUsedUsd)).toBe(0);
    expect((await pool.query(`SELECT 1 FROM sp_offloads WHERE company_id = $1 AND container_id = $2`, [companyId, containerId])).rowCount).toBe(0);
    expect((await pool.query(`SELECT 1 FROM sp_stock_movements WHERE company_id = $1 AND container_id = $2`, [companyId, containerId])).rowCount).toBe(0);
    expect(
      (
        await pool.query(
          `SELECT 1
           FROM sp_offload_charges c
           JOIN sp_offloads o ON o.id = c.offload_id
           WHERE c.company_id = $1 AND o.company_id = $1 AND o.container_id = $2`,
          [companyId, containerId]
        )
      ).rowCount
    ).toBe(0);

    const after = await pool.query<{ vouchers: string; inventory_qty: string }>(`SELECT (SELECT COUNT(*) FROM vouchers WHERE company_id = $1)::text AS vouchers, COALESCE((SELECT SUM(quantity::numeric) FROM inventory WHERE company_id = $1 AND location_id = $2 AND stock_item_id = $3), 0)::text AS inventory_qty`, [companyId, locationId, stockItemId]);
    expect(after.rows[0].vouchers).toBe(before.rows[0].vouchers);
    expect(after.rows[0].inventory_qty).toBe(before.rows[0].inventory_qty);

    const container = await pool.query<{ status: string }>(`SELECT status FROM sp_containers WHERE company_id = $1 AND id = $2`, [companyId, containerId]);
    expect(container.rows[0]?.status).toBe("open");
  });
});

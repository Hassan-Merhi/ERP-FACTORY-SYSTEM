/**
 * Factory / Supplier Partner container lifecycle integration coverage.
 *
 * Protects setup, container creation, OTW accounting, offload accounting,
 * inventory application, exact-request idempotent replay, reversal and corrected re-offload.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";
import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { spContainerLines, spContainers, spOffloads } from "../shared/schema/sp";

const RUN_ID = Date.now().toString(36);
const TEST_PREFIX = `facttest-${RUN_ID}`;

let erpCtx: TestContext;
let spCompanyId: number;
let spLocationId: number;
let spStockItemId: number;
let spAgent: request.SuperAgentTest;
let createdContainerId: number;
let originalOffloadId: number;
let offloadVoucherIds: number[] = [];

const INVOICE_TOTAL = 1000;
const CONTAINER_QTY = 50;
const UNIT_RATE = 20;

async function cleanupSpTables(companyId: number): Promise<void> {
  await pool.query(`DELETE FROM sp_stock_movements WHERE company_id = $1`, [companyId]);
  await pool.query(
    `DELETE FROM sp_offload_charges WHERE offload_id IN (
       SELECT id FROM sp_offloads WHERE company_id = $1
     )`,
    [companyId]
  );
  await pool.query(`DELETE FROM sp_offload_reversals WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM sp_prepaid_charges WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM sp_offloads WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM sp_container_lines WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM sp_containers WHERE company_id = $1`, [companyId]);
}

async function offloadCount(): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM sp_offloads WHERE company_id = $1 AND container_id = $2`,
    [spCompanyId, createdContainerId]
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function inventoryQuantity(): Promise<number> {
  const [row] = await db
    .select({ quantity: schema.inventory.quantity })
    .from(schema.inventory)
    .where(
      and(
        eq(schema.inventory.companyId, spCompanyId),
        eq(schema.inventory.locationId, spLocationId),
        eq(schema.inventory.stockItemId, spStockItemId)
      )
    )
    .limit(1);
  return Number(row?.quantity ?? 0);
}

beforeAll(async () => {
  erpCtx = await seedTestData(TEST_PREFIX);
  const bcrypt = await import("bcryptjs");
  const hashedPassword = await bcrypt.hash("testpassword123", 10);

  const [spUser] = await db
    .insert(schema.users)
    .values({ username: `${TEST_PREFIX}_spuser`, password: hashedPassword })
    .returning();

  const [spCompany] = await db
    .insert(schema.companies)
    .values({
      code: `FSP-${RUN_ID}`,
      name: `${TEST_PREFIX} Company`,
      baseCurrency: "USD",
      companyType: "supplier_partner",
    })
    .returning();
  spCompanyId = spCompany.id;

  await db.insert(schema.userCompanyRoles).values({
    userId: spUser.id,
    companyId: spCompanyId,
    role: "Admin",
  });

  const [spItem] = await db
    .insert(schema.stockItems)
    .values({
      companyId: spCompanyId,
      code: `${TEST_PREFIX}-ITEM`,
      name: "SP Test Item",
      uom: "PCS",
      stockGroupId: null,
      active: true,
    })
    .returning();
  spStockItemId = spItem.id;

  spAgent = request.agent(erpCtx.app);
  const login = await spAgent
    .post("/api/auth/login")
    .send({ username: `${TEST_PREFIX}_spuser`, password: "testpassword123" });
  if (login.status !== 200) {
    throw new Error(`SP login failed: ${login.status} ${JSON.stringify(login.body)}`);
  }
  const companySwitch = await spAgent.post("/api/auth/set-company").send({ companyId: spCompanyId });
  if (companySwitch.status !== 200) {
    throw new Error(`SP company switch failed: ${companySwitch.status} ${JSON.stringify(companySwitch.body)}`);
  }

  const setup = await spAgent.post("/api/sp/setup").send({
    confirmation: "CHANGE SP SETUP",
    reason: "Initialize Supplier Partner lifecycle test setup",
    idempotencyKey: `sp-setup-initial-${RUN_ID}`,
  });
  if (setup.status !== 200) {
    throw new Error(`SP setup failed: ${setup.status} ${JSON.stringify(setup.body)}`);
  }

  const [defaultLocation] = await db
    .select()
    .from(schema.locations)
    .where(eq(schema.locations.companyId, spCompanyId))
    .limit(1);
  if (!defaultLocation) throw new Error("SP setup did not create a default location");
  spLocationId = defaultLocation.id;
}, 90000);

afterAll(async () => {
  if (spCompanyId) {
    await cleanupSpTables(spCompanyId);
    await pool.query(
      `DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`,
      [spCompanyId]
    );
    await pool.query(`DELETE FROM vouchers WHERE company_id = $1`, [spCompanyId]);
    await pool.query(`DELETE FROM canonical_stock_movement_audit WHERE company_id = $1`, [spCompanyId]);
    await pool.query(`DELETE FROM canonical_stock_movement_requests WHERE company_id = $1`, [spCompanyId]);
    await pool.query(`DELETE FROM canonical_stock_movements WHERE company_id = $1`, [spCompanyId]);
    await pool.query(`DELETE FROM inventory WHERE company_id = $1`, [spCompanyId]);
    await pool.query(`DELETE FROM stock_items WHERE company_id = $1`, [spCompanyId]);
    await pool.query(`DELETE FROM bank_accounts WHERE company_id = $1`, [spCompanyId]);
    await pool.query(`DELETE FROM ledger_accounts WHERE company_id = $1`, [spCompanyId]);
    await pool.query(`DELETE FROM locations WHERE company_id = $1`, [spCompanyId]);
    await pool.query(`DELETE FROM sp_audit_events WHERE company_id = $1`, [spCompanyId]);
    await pool.query(`DELETE FROM sp_idempotency_keys WHERE company_id = $1`, [spCompanyId]);
    await pool.query(`DELETE FROM sp_permission_grants WHERE company_id = $1`, [spCompanyId]);
    await pool.query(`DELETE FROM user_company_roles WHERE company_id = $1`, [spCompanyId]);
    await pool.query(`DELETE FROM audit_log WHERE company_id = $1`, [spCompanyId]);
    await pool.query(`DELETE FROM login_history WHERE company_id = $1`, [spCompanyId]);
    await pool.query(`DELETE FROM companies WHERE id = $1`, [spCompanyId]);
    await pool.query(`DELETE FROM users WHERE username = $1`, [`${TEST_PREFIX}_spuser`]);
  }
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 30000);

describe("SP lifecycle setup", () => {
  it("reports a configured Supplier Partner company", async () => {
    const response = await spAgent.get("/api/sp/setup/status");
    expect(response.status).toBe(200);
    expect(response.body.isConfigured).toBe(true);
    expect(Array.isArray(response.body.spAccounts)).toBe(true);
    expect(response.body.spAccounts.length).toBeGreaterThanOrEqual(8);
    expect(Array.isArray(response.body.locations)).toBe(true);
    expect(response.body.locations.length).toBeGreaterThanOrEqual(1);
  });

  it("is idempotent when setup runs again", async () => {
    const response = await spAgent.post("/api/sp/setup").send({
      confirmation: "CHANGE SP SETUP",
      reason: "Verify Supplier Partner setup remains idempotent",
      idempotencyKey: `sp-setup-repeat-${RUN_ID}`,
    });
    expect(response.status).toBe(200);
    const created: string[] = response.body?.created ?? [];
    expect(created.filter((entry) => !entry.toLowerCase().includes("location"))).toHaveLength(0);
  });
});

describe("SP container creation", () => {
  it("creates an open container and balanced Goods OTW voucher", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const response = await spAgent.post("/api/sp/containers").send({
      supplierName: "Test SP Supplier",
      containerNumber: `${TEST_PREFIX}-CONT-001`,
      invoiceNumber: `${TEST_PREFIX}-INV-001`,
      invoiceDate: today,
      invoiceTotalUsd: INVOICE_TOTAL,
      discountPct: 0,
      freightEstimateUsd: 0,
      lines: [
        {
          articleCode: `${TEST_PREFIX}-ITEM`,
          description: "SP test item",
          qty: CONTAINER_QTY,
          unitRateUsd: UNIT_RATE,
          stockItemId: spStockItemId,
        },
      ],
    });

    expect(response.status).toBe(200);
    createdContainerId = response.body.id;
    expect(createdContainerId).toBeDefined();

    const [container] = await db.select().from(spContainers).where(eq(spContainers.id, createdContainerId));
    expect(container.status).toBe("open");
    expect(container.goodsOtwVoucherId).not.toBeNull();

    const totals = await pool.query(
      `SELECT COALESCE(SUM(debit_amount::numeric), 0) AS dr,
              COALESCE(SUM(credit_amount::numeric), 0) AS cr
       FROM voucher_entries
       WHERE voucher_id = $1`,
      [container.goodsOtwVoucherId]
    );
    expect(Number(totals.rows[0].dr)).toBeCloseTo(INVOICE_TOTAL, 0);
    expect(Number(totals.rows[0].dr)).toBeCloseTo(Number(totals.rows[0].cr), 2);

    const [line] = await db.select().from(spContainerLines).where(eq(spContainerLines.containerId, createdContainerId));
    expect(Number(line.qty)).toBeCloseTo(CONTAINER_QTY, 1);
    expect(line.stockItemId).toBe(spStockItemId);
  });

  it("lists the created container", async () => {
    const response = await spAgent.get("/api/sp/containers");
    expect(response.status).toBe(200);
    expect((response.body as Array<{ id: number }>).map((row) => row.id)).toContain(createdContainerId);
  });
});

describe("SP container offload", () => {
  it("offloads once, posts balanced vouchers and applies inventory", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const response = await spAgent.post("/api/sp/offload").send({
      containerId: createdContainerId,
      offloadDate: today,
      locationId: spLocationId,
      chargeLines: [],
    });
    expect(response.status).toBe(200);

    const [offload] = await db.select().from(spOffloads).where(eq(spOffloads.containerId, createdContainerId));
    expect(offload).toBeDefined();
    originalOffloadId = offload.id;
    expect(Number(offload.totalQty)).toBeCloseTo(CONTAINER_QTY, 1);
    expect(Number(offload.totalBaseCostUsd)).toBeCloseTo(CONTAINER_QTY * UNIT_RATE, 0);

    offloadVoucherIds = [offload.voucherIdReversal, offload.voucherIdStock].filter((id): id is number =>
      Number.isInteger(id)
    );
    expect(offloadVoucherIds.length).toBeGreaterThan(0);
    for (const voucherId of offloadVoucherIds) {
      const totals = await pool.query(
        `SELECT COALESCE(SUM(debit_amount::numeric), 0) AS dr,
                COALESCE(SUM(credit_amount::numeric), 0) AS cr
         FROM voucher_entries
         WHERE voucher_id = $1`,
        [voucherId]
      );
      expect(Number(totals.rows[0].dr)).toBeCloseTo(Number(totals.rows[0].cr), 2);
    }

    const [container] = await db.select().from(spContainers).where(eq(spContainers.id, createdContainerId));
    expect(container.status).toBe("offloaded");

    const [inventory] = await db
      .select()
      .from(schema.inventory)
      .where(
        and(
          eq(schema.inventory.companyId, spCompanyId),
          eq(schema.inventory.locationId, spLocationId),
          eq(schema.inventory.stockItemId, spStockItemId)
        )
      )
      .limit(1);
    expect(Number(inventory.quantity)).toBeCloseTo(CONTAINER_QTY, 1);
    expect(Number(inventory.totalValue ?? 0)).toBeCloseTo(CONTAINER_QTY * UNIT_RATE, 0);
    expect(Number(inventory.averageRate)).toBeCloseTo(UNIT_RATE, 1);
  });

  it("replays the exact same offload idempotently without duplicate writes", async () => {
    const beforeOffloads = await offloadCount();
    const beforeInventory = await inventoryQuantity();
    const today = new Date().toISOString().slice(0, 10);

    const response = await spAgent.post("/api/sp/offload").send({
      containerId: createdContainerId,
      offloadDate: today,
      locationId: spLocationId,
      chargeLines: [],
    });

    expect(response.status).toBe(200);
    expect(response.headers["x-idempotent-replay"]).toBe("true");
    expect(await offloadCount()).toBe(beforeOffloads);
    expect(await inventoryQuantity()).toBeCloseTo(beforeInventory, 6);
  });
});

describe("SP reverse and corrected re-offload", () => {
  it("reverses the offload exactly, preserves immutable history and refuses a duplicate reversal", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const response = await spAgent.post(`/api/sp/offloads/${originalOffloadId}/reverse`).send({
      reversalDate: today,
      reason: "Wave 2 lifecycle regression coverage",
      confirmation: "REVERSE SP OFFLOAD",
      idempotencyKey: `sp-offload-reverse-${RUN_ID}`,
    });

    expect(response.status).toBe(200);
    expect(response.body.containerId).toBe(createdContainerId);
    expect(response.body.reversedMovementCount).toBeGreaterThan(0);
    expect(response.body.originalVoucherIds).toEqual(expect.arrayContaining(offloadVoucherIds));
    expect(response.body.reversalVoucherIds.length).toBeGreaterThanOrEqual(offloadVoucherIds.length);

    const [container] = await db.select().from(spContainers).where(eq(spContainers.id, createdContainerId));
    expect(container.status).toBe("open");
    expect(await inventoryQuantity()).toBeCloseTo(0, 6);

    const reversalHistory = await pool.query<{
      offload_id: number;
      snapshot_offload_id: string;
      voucher_ids_reversal: number[];
    }>(
      `SELECT offload_id,
              snapshot->'offload'->>'id' AS snapshot_offload_id,
              voucher_ids_reversal
       FROM sp_offload_reversals
       WHERE company_id = $1 AND offload_id = $2`,
      [spCompanyId, originalOffloadId]
    );
    expect(reversalHistory.rowCount).toBe(1);
    expect(Number(reversalHistory.rows[0].snapshot_offload_id)).toBe(originalOffloadId);
    expect(reversalHistory.rows[0].voucher_ids_reversal.length).toBeGreaterThanOrEqual(offloadVoucherIds.length);

    for (const voucherId of reversalHistory.rows[0].voucher_ids_reversal) {
      const totals = await pool.query(
        `SELECT COALESCE(SUM(debit_amount::numeric), 0) AS dr,
                COALESCE(SUM(credit_amount::numeric), 0) AS cr
         FROM voucher_entries
         WHERE voucher_id = $1`,
        [voucherId]
      );
      expect(Number(totals.rows[0].dr)).toBeCloseTo(Number(totals.rows[0].cr), 2);
    }

    const duplicate = await spAgent.post(`/api/sp/offloads/${originalOffloadId}/reverse`).send({
      reversalDate: today,
      reason: "Duplicate reversal must be rejected",
      confirmation: "REVERSE SP OFFLOAD",
      idempotencyKey: `sp-offload-reverse-duplicate-${RUN_ID}`,
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe("SP_LIFECYCLE_ALREADY_DONE");
    expect(await inventoryQuantity()).toBeCloseTo(0, 6);
  });

  it("re-offloads after reversal and reproduces the original inventory result without erasing reversal history", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const response = await spAgent.post("/api/sp/offload").send({
      containerId: createdContainerId,
      offloadDate: today,
      locationId: spLocationId,
      chargeLines: [],
    });

    expect(response.status).toBe(200);
    expect(response.headers["x-idempotent-replay"]).not.toBe("true");
    expect(await offloadCount()).toBe(1);

    const [newOffload] = await db.select().from(spOffloads).where(eq(spOffloads.containerId, createdContainerId));
    expect(newOffload.id).not.toBe(originalOffloadId);
    expect(Number(newOffload.totalQty)).toBeCloseTo(CONTAINER_QTY, 1);
    expect(Number(newOffload.totalBaseCostUsd)).toBeCloseTo(CONTAINER_QTY * UNIT_RATE, 0);

    const [container] = await db.select().from(spContainers).where(eq(spContainers.id, createdContainerId));
    expect(container.status).toBe("offloaded");

    const [inventory] = await db
      .select()
      .from(schema.inventory)
      .where(
        and(
          eq(schema.inventory.companyId, spCompanyId),
          eq(schema.inventory.locationId, spLocationId),
          eq(schema.inventory.stockItemId, spStockItemId)
        )
      )
      .limit(1);
    expect(Number(inventory.quantity)).toBeCloseTo(CONTAINER_QTY, 1);
    expect(Number(inventory.totalValue ?? 0)).toBeCloseTo(CONTAINER_QTY * UNIT_RATE, 0);
    expect(Number(inventory.averageRate)).toBeCloseTo(UNIT_RATE, 1);

    const history = await pool.query<{ count: string; snapshot_offload_id: string }>(
      `SELECT COUNT(*)::text AS count,
              MAX(snapshot->'offload'->>'id') AS snapshot_offload_id
       FROM sp_offload_reversals
       WHERE company_id = $1 AND container_id = $2`,
      [spCompanyId, createdContainerId]
    );
    expect(Number(history.rows[0].count)).toBe(1);
    expect(Number(history.rows[0].snapshot_offload_id)).toBe(originalOffloadId);
  });
});

describe("SP offload charge lines", () => {
  it("offload supports prepaid, paid-now and unpaid-payable charge lines", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const PREPAID_PAID = 120;
    const PREPAID_USED = 80;
    const PAID_NOW = 30;
    const PAYABLE = 50;
    const QTY = 10;
    const RATE = 20;

    const [bank] = await db
      .insert(schema.bankAccounts)
      .values({
        companyId: spCompanyId,
        code: `${TEST_PREFIX}-BANK`.slice(0, 50),
        name: "SP Charges Bank",
        bankName: "Test Bank",
        accountNumber: `${RUN_ID}-001`,
      })
      .returning();
    const [payable] = await db
      .insert(schema.ledgerAccounts)
      .values({
        companyId: spCompanyId,
        code: `${TEST_PREFIX}-PAY`.slice(0, 50),
        name: "Clearing Agent Payable",
        accountType: "Liability",
      })
      .returning();

    const container = await spAgent.post("/api/sp/containers").send({
      supplierName: "Charges Supplier",
      containerNumber: `${TEST_PREFIX}-CONT-CHG`,
      invoiceNumber: `${TEST_PREFIX}-INV-CHG`,
      invoiceDate: today,
      invoiceTotalUsd: QTY * RATE,
      discountPct: 0,
      freightEstimateUsd: 0,
      lines: [
        {
          articleCode: `${TEST_PREFIX}-ITEM`,
          description: "charged",
          qty: QTY,
          unitRateUsd: RATE,
          stockItemId: spStockItemId,
        },
      ],
    });
    expect(container.status, JSON.stringify(container.body)).toBe(200);
    const containerId = container.body.id as number;

    const prepaid = await spAgent.post("/api/sp/prepaid").send({
      containerId,
      prepaidDate: today,
      chargeType: "clearing",
      agentName: "Port Agent",
      amountPaidUsd: PREPAID_PAID,
      bankAccountId: String(bank.id),
    });
    expect(prepaid.status, JSON.stringify(prepaid.body)).toBe(200);
    const prepaidId = prepaid.body.id as number;

    const inventoryBefore = await inventoryQuantity();
    const offload = await spAgent.post("/api/sp/offload").send({
      containerId,
      offloadDate: today,
      locationId: spLocationId,
      chargeLines: [
        {
          chargeType: "prepaid_used",
          prepaidChargeId: String(prepaidId),
          amountUsd: PREPAID_USED,
          description: "Clearing",
        },
        { chargeType: "paid_now", creditBankAccountId: String(bank.id), amountUsd: PAID_NOW, description: "Handling" },
        {
          chargeType: "unpaid_payable",
          creditLedgerAccountId: String(payable.id),
          amountUsd: PAYABLE,
          description: "Transport",
        },
      ],
    });
    expect(offload.status, JSON.stringify(offload.body)).toBe(200);

    const landed = PREPAID_USED + PAID_NOW + PAYABLE;
    const [row] = await db.select().from(spOffloads).where(eq(spOffloads.containerId, containerId));
    expect(Number(row.totalBaseCostUsd)).toBeCloseTo(QTY * RATE, 2);
    expect(Number(row.totalLandedCostUsd)).toBeCloseTo(landed, 2);
    expect(Number(row.totalFinalCostUsd)).toBeCloseTo(QTY * RATE + landed, 2);

    // The stock voucher is balanced and credits each funding source exactly once.
    const entries = await pool.query<{
      ledger_account_id: number | null;
      bank_account_id: number | null;
      debit: string;
      credit: string;
    }>(
      `SELECT ledger_account_id, bank_account_id, debit_amount::text AS debit, credit_amount::text AS credit
       FROM voucher_entries WHERE voucher_id = $1`,
      [row.voucherIdStock]
    );
    const dr = entries.rows.reduce((sum, e) => sum + Number(e.debit), 0);
    const cr = entries.rows.reduce((sum, e) => sum + Number(e.credit), 0);
    expect(dr).toBeCloseTo(QTY * RATE + landed, 2);
    expect(cr).toBeCloseTo(dr, 2);
    expect(entries.rows.filter((e) => e.bank_account_id === bank.id).map((e) => Number(e.credit))).toEqual([PAID_NOW]);
    expect(entries.rows.filter((e) => e.ledger_account_id === payable.id).map((e) => Number(e.credit))).toEqual([
      PAYABLE,
    ]);

    // The prepaid asset is drawn down, not re-paid.
    const prepaidRow = await pool.query<{ used: string; paid: string }>(
      `SELECT amount_used_usd::text AS used, amount_paid_usd::text AS paid FROM sp_prepaid_charges WHERE id = $1`,
      [prepaidId]
    );
    expect(Number(prepaidRow.rows[0].used)).toBeCloseTo(PREPAID_USED, 4);
    expect(Number(prepaidRow.rows[0].paid)).toBeCloseTo(PREPAID_PAID, 4);

    const charges = await pool.query<{ charge_type: string; amount_usd: string }>(
      `SELECT charge_type, amount_usd::text AS amount_usd FROM sp_offload_charges WHERE offload_id = $1 ORDER BY id`,
      [row.id]
    );
    expect(charges.rows.map((c) => [c.charge_type, Number(c.amount_usd)])).toEqual([
      ["prepaid_used", PREPAID_USED],
      ["paid_now", PAID_NOW],
      ["unpaid_payable", PAYABLE],
    ]);

    expect(await inventoryQuantity()).toBeCloseTo(inventoryBefore + QTY, 6);
  });

  it("refuses to use more prepaid balance than remains", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const [prepaidRow] = (
      await pool.query<{ id: number }>(
        `SELECT id FROM sp_prepaid_charges WHERE company_id = $1 ORDER BY id DESC LIMIT 1`,
        [spCompanyId]
      )
    ).rows;
    const container = await spAgent.post("/api/sp/containers").send({
      supplierName: "Overdraw Supplier",
      containerNumber: `${TEST_PREFIX}-CONT-OVR`,
      invoiceNumber: `${TEST_PREFIX}-INV-OVR`,
      invoiceDate: today,
      invoiceTotalUsd: 100,
      discountPct: 0,
      freightEstimateUsd: 0,
      lines: [
        {
          articleCode: `${TEST_PREFIX}-ITEM`,
          description: "over",
          qty: 5,
          unitRateUsd: 20,
          stockItemId: spStockItemId,
        },
      ],
    });
    expect(container.status).toBe(200);

    const offload = await spAgent.post("/api/sp/offload").send({
      containerId: container.body.id,
      offloadDate: today,
      locationId: spLocationId,
      // 40 of 120 remains after the previous test; ask for 41.
      chargeLines: [{ chargeType: "prepaid_used", prepaidChargeId: String(prepaidRow.id), amountUsd: 41 }],
    });
    expect(offload.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(offload.body)).toMatch(/remaining/);
    const [row] = await db.select().from(spOffloads).where(eq(spOffloads.containerId, container.body.id));
    expect(row).toBeUndefined();
  });
});

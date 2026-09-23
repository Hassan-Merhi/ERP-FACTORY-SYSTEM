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
    await pool.query(`DELETE FROM ledger_accounts WHERE company_id = $1`, [spCompanyId]);
    await pool.query(`DELETE FROM locations WHERE company_id = $1`, [spCompanyId]);
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

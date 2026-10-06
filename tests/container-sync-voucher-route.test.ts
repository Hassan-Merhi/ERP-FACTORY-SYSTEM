/**
 * POST /api/containers/:id/sync-voucher rewrites each purchase order's
 * voucher to the PO's current total: the debit leg and the credit leg both
 * move to the new amount, and a container outside the active company is
 * refused.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "csyncv";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let supplierId: number;

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

  const [supplier] = await db
    .insert(schema.suppliers)
    .values({
      code: `${TEST_PREFIX.toUpperCase()}SUP`,
      legalName: `${TEST_PREFIX} Supplier`,
      email: `${TEST_PREFIX}@example.test`,
    })
    .returning();
  supplierId = supplier.id;
  await pool.query("UPDATE suppliers SET company_id = $1 WHERE id = $2", [ctx.companyId, supplierId]);
}, 120000);

afterAll(async () => {
  await pool.query(
    `DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE voucher_number LIKE $1)`,
    [`${TEST_PREFIX}-%`]
  );
  await pool.query(`DELETE FROM purchase_orders WHERE po_number LIKE $1`, [`${TEST_PREFIX}-%`]);
  await pool.query(`DELETE FROM vouchers WHERE voucher_number LIKE $1`, [`${TEST_PREFIX}-%`]);
  await pool.query(`DELETE FROM containers WHERE container_number LIKE $1`, [`${TEST_PREFIX}-%`]);
  await pool.query(`DELETE FROM suppliers WHERE id = $1`, [supplierId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("POST /api/containers/:id/sync-voucher", () => {
  it("moves both legs of the purchase voucher to the PO total", async () => {
    const [container] = await db
      .insert(schema.containers)
      .values({ companyId: ctx.companyId, containerNumber: `${TEST_PREFIX}-C1`, supplierId, importDate: "2026-01-01" })
      .returning();
    const [voucher] = await db
      .insert(schema.vouchers)
      .values({
        companyId: ctx.companyId,
        voucherType: "Purchase",
        voucherNumber: `${TEST_PREFIX}-PV1`,
        voucherDate: "2026-01-05",
        description: `${TEST_PREFIX}-C1 Supplier`,
        totalAmount: "100.00",
        currency: "USD",
      })
      .returning();
    await db.insert(schema.voucherEntries).values([
      { voucherId: voucher.id, ledgerAccountId: ctx.cashAccountId, debitAmount: "100.00", creditAmount: "0" },
      { voucherId: voucher.id, supplierId, debitAmount: "0", creditAmount: "100.00" },
    ]);
    await db.insert(schema.purchaseOrders).values({
      companyId: ctx.companyId,
      poNumber: `${TEST_PREFIX}-PO1`,
      containerId: container.id,
      supplierId,
      voucherId: voucher.id,
      itemsTotal: "0.10",
      freight: "0.20",
      freightPaidBy: "supplier",
    });

    const response = await agent.post(`/api/containers/${container.id}/sync-voucher`).send({});

    expect(response.status).toBe(200);
    expect(response.body.updatedLocalVouchers).toBe(1);
    const [row] = await db.select().from(schema.vouchers).where(eq(schema.vouchers.id, voucher.id));
    expect(row.totalAmount).toBe("0.30");
    const entries = await db
      .select()
      .from(schema.voucherEntries)
      .where(eq(schema.voucherEntries.voucherId, voucher.id))
      .orderBy(schema.voucherEntries.id);
    expect(entries.map((e) => [e.debitAmount, e.creditAmount])).toEqual([
      ["0.30", "0.00"],
      ["0.00", "0.30"],
    ]);
  });

  it("refuses a container that does not exist in this company", async () => {
    expect((await agent.post(`/api/containers/999999999/sync-voucher`).send({})).status).toBe(404);
  });
});

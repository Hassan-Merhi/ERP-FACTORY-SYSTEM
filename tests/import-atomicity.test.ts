import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "phase25imp";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let supplierId = 0;

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);

  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  expect(login.status).toBe(200);
  const selected = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  expect(selected.status).toBe(200);

  const supplier = await pool.query<{ id: number }>(
    `INSERT INTO suppliers (company_id, code, legal_name, email, opening_balance, active)
     VALUES ($1, $2, $3, $4, '0', true)
     RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-SUP`, `${TEST_PREFIX} Supplier`, `${TEST_PREFIX}@example.test`]
  );
  supplierId = supplier.rows[0].id;
}, 60_000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 30_000);

async function importFootprint(containerNumber: string, fileHash: string) {
  const [containers, purchaseOrders, importLogs] = await Promise.all([
    pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM containers WHERE container_number = $1", [
      containerNumber,
    ]),
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM purchase_orders
       WHERE company_id = $1 AND po_number LIKE $2`,
      [ctx.companyId, `${TEST_PREFIX.toUpperCase()}-PO%`]
    ),
    pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM import_logs WHERE file_hash = $1", [fileHash]),
  ]);

  return {
    containers: Number(containers.rows[0].count),
    purchaseOrders: Number(purchaseOrders.rows[0].count),
    importLogs: Number(importLogs.rows[0].count),
  };
}

describe("Phase 25 — PO import validation and atomic rejection", () => {
  it("rejects malformed money before creating container, PO, or import-log rows", async () => {
    const nonce = Date.now();
    const containerNumber = `${TEST_PREFIX.toUpperCase()}-BAD-${nonce}`;
    const poNumber = `${TEST_PREFIX.toUpperCase()}-PO-BAD-${nonce}`;
    const fileHash = `${TEST_PREFIX}-bad-money-${nonce}`;

    expect(await importFootprint(containerNumber, fileHash)).toEqual({
      containers: 0,
      purchaseOrders: 0,
      importLogs: 0,
    });

    const response = await agent.post("/api/po-import/import").send({
      fileHash,
      fileName: `${TEST_PREFIX}-bad-money.xlsx`,
      containerNumber,
      supplierId,
      importDate: "2026-09-15",
      freightPaidBy: "supplier",
      preview: [
        {
          containerNumber,
          itemsTotal: 100,
          chargesTotal: 0,
          grandTotal: 100,
          itemsCount: 1,
          charges: {
            freight: 0,
            surcharge: 0,
            fumigation: 0,
            documentCharges: 0,
            discount: 0,
            otherCharges: 0,
          },
          items: [
            {
              poNumber,
              stockItemId: ctx.stockItemIds[0],
              barcode: `${TEST_PREFIX}-ITEM1`,
              itemName: "Test Item 1",
              quantity: 10,
              rate: "not-a-number",
              lineTotal: 100,
              currency: "USD",
            },
          ],
        },
      ],
    });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe("Validation failed");
    expect(response.body.errors).toEqual(expect.arrayContaining([expect.stringMatching(/quantity, rate and line total/i)]));
    expect(await importFootprint(containerNumber, fileHash)).toEqual({
      containers: 0,
      purchaseOrders: 0,
      importLogs: 0,
    });
  });

  it("rejects unreadable container charges without writing partial import state", async () => {
    const nonce = Date.now() + 1;
    const containerNumber = `${TEST_PREFIX.toUpperCase()}-CHARGE-${nonce}`;
    const poNumber = `${TEST_PREFIX.toUpperCase()}-PO-CHG-${nonce}`;
    const fileHash = `${TEST_PREFIX}-bad-charge-${nonce}`;

    const response = await agent.post("/api/po-import/import").send({
      fileHash,
      fileName: `${TEST_PREFIX}-bad-charge.xlsx`,
      containerNumber,
      supplierId,
      importDate: "2026-09-15",
      freightPaidBy: "supplier",
      preview: [
        {
          containerNumber,
          itemsTotal: 100,
          chargesTotal: 10,
          grandTotal: 110,
          itemsCount: 1,
          charges: {
            freight: "bad-freight",
            surcharge: 0,
            fumigation: 0,
            documentCharges: 0,
            discount: 0,
            otherCharges: 0,
          },
          items: [
            {
              poNumber,
              stockItemId: ctx.stockItemIds[0],
              barcode: `${TEST_PREFIX}-ITEM1`,
              itemName: "Test Item 1",
              quantity: 10,
              rate: 10,
              lineTotal: 100,
              currency: "USD",
            },
          ],
        },
      ],
    });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe("Validation failed");
    expect(response.body.errors).toEqual(expect.arrayContaining([expect.stringMatching(/charge.*not a number/i)]));
    expect(await importFootprint(containerNumber, fileHash)).toEqual({
      containers: 0,
      purchaseOrders: 0,
      importLogs: 0,
    });
  });
});

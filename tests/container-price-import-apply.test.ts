/**
 * POST /api/containers/:id/price-import/apply reprices purchase-order lines
 * and re-totals the container.
 *
 *   - Line totals are exact: 1.3 units at 0.35 is 0.455, stored as 0.46 (the
 *     float product stored 0.45).
 *   - Only lines on this container's purchase orders are touched. The route
 *     took line ids straight from the body, so it repriced any company's
 *     line, and for another company's container it zeroed that container's
 *     totals.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "cpriceimp";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let foreignCompanyId: number;
let supplierId: number;
let seq = 0;

async function seedContainer(companyId: number) {
  seq += 1;
  const [container] = await db
    .insert(schema.containers)
    .values({
      companyId,
      containerNumber: `${TEST_PREFIX}-C${seq}`,
      supplierId,
      importDate: "2026-01-01",
      itemsTotal: "10.00",
      chargesTotal: "2.00",
      grandTotal: "12.00",
    })
    .returning();
  const [po] = await db
    .insert(schema.purchaseOrders)
    .values({
      companyId,
      poNumber: `${TEST_PREFIX}-PO${seq}`,
      containerId: container.id,
      supplierId,
      itemsTotal: "10.00",
      freight: "2.00",
    })
    .returning();
  const [line] = await db
    .insert(schema.poLineItems)
    .values({
      poId: po.id,
      stockItemId: ctx.stockItemIds[0],
      itemName: "Line",
      quantity: "1.300",
      rate: "7.69",
      lineTotal: "10.00",
    })
    .returning();
  return { container, po, line };
}

async function lineRow(id: number) {
  const [row] = await db.select().from(schema.poLineItems).where(eq(schema.poLineItems.id, id));
  return row;
}

async function containerRow(id: number) {
  const [row] = await db.select().from(schema.containers).where(eq(schema.containers.id, id));
  return row;
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

  const company = await pool.query<{ id: number }>(
    `INSERT INTO companies (code, name, company_type, active, base_currency)
     VALUES ($1, $2, 'erp', true, 'USD') RETURNING id`,
    [`${TEST_PREFIX.toUpperCase()}X`, `${TEST_PREFIX}_ForeignCompany`]
  );
  foreignCompanyId = company.rows[0].id;

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
    `DELETE FROM po_line_items WHERE po_id IN (SELECT id FROM purchase_orders WHERE po_number LIKE $1)`,
    [`${TEST_PREFIX}-%`]
  );
  await pool.query(`DELETE FROM purchase_orders WHERE po_number LIKE $1`, [`${TEST_PREFIX}-%`]);
  await pool.query(`DELETE FROM containers WHERE container_number LIKE $1`, [`${TEST_PREFIX}-%`]);
  await pool.query(`DELETE FROM companies WHERE id = $1`, [foreignCompanyId]);
  await pool.query(`DELETE FROM suppliers WHERE id = $1`, [supplierId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("POST /api/containers/:id/price-import/apply", () => {
  it("reprices lines exactly and re-totals the purchase order and container", async () => {
    const { container, po, line } = await seedContainer(ctx.companyId);

    const response = await agent
      .post(`/api/containers/${container.id}/price-import/apply`)
      .send({ rows: [{ lineItemIds: [line.id], newRate: 0.35 }] });

    expect(response.status).toBe(200);
    expect(response.body.updated).toBe(1);
    expect(await lineRow(line.id)).toMatchObject({ rate: "0.35", lineTotal: "0.46" });
    const [poRow] = await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, po.id));
    expect(poRow.itemsTotal).toBe("0.46");
    expect(await containerRow(container.id)).toMatchObject({
      itemsTotal: "0.46",
      chargesTotal: "2.00",
      grandTotal: "2.46",
    });
  });

  it("leaves another company's line untouched when its id is sent with this container", async () => {
    const mine = await seedContainer(ctx.companyId);
    const foreign = await seedContainer(foreignCompanyId);

    const response = await agent
      .post(`/api/containers/${mine.container.id}/price-import/apply`)
      .send({ rows: [{ lineItemIds: [foreign.line.id], newRate: 999 }] });

    expect(response.status).toBe(200);
    expect(response.body.updated).toBe(0);
    expect(await lineRow(foreign.line.id)).toMatchObject({ rate: "7.69", lineTotal: "10.00" });
  });

  it("refuses another company's container without touching its totals", async () => {
    const foreign = await seedContainer(foreignCompanyId);

    const response = await agent
      .post(`/api/containers/${foreign.container.id}/price-import/apply`)
      .send({ rows: [{ lineItemIds: [foreign.line.id], newRate: 1 }] });

    expect(response.status).toBe(404);
    expect(await containerRow(foreign.container.id)).toMatchObject({ itemsTotal: "10.00", grandTotal: "12.00" });
    expect(await lineRow(foreign.line.id)).toMatchObject({ rate: "7.69" });
  });
});

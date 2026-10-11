import request from "supertest";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import { ensurePriorityScanSchema } from "../server/startup/priorityScanSchema";
import { closeTestServer, cleanupTestData, seedTestData, type TestContext } from "./setup";

const PREFIX = "autopriority";
let ctx: TestContext;
let agent: request.SuperAgentTest;

beforeAll(async () => {
  await ensurePriorityScanSchema(pool);
  ctx = await seedTestData(PREFIX);
  agent = request.agent(ctx.app);
  const login = await agent
    .post("/api/auth/login")
    .send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
  expect(login.status).toBe(200);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
});

afterAll(async () => {
  if (ctx?.companyId) {
    await pool.query("DELETE FROM factory_priority_auto_allocations WHERE company_id = $1", [ctx.companyId]);
    await pool.query("DELETE FROM factory_priority_scan_history WHERE company_id = $1", [ctx.companyId]);
    await pool.query("DELETE FROM customer_order_priority_scan_configs WHERE company_id = $1", [ctx.companyId]);
  }
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60000);

describe("Automatic Priority Printing and Loading", () => {
  it("defaults OFF, routes a reprinted unallocated bale once, and restores #1 after removal", async () => {
    const initial = await agent.get("/api/factory/automatic-priority-mode");
    expect(initial.status).toBe(200);
    expect(initial.body.enabled).toBe(false);

    const customer = await pool.query<{ id: number }>(
      "INSERT INTO customers (company_id, code, legal_name) VALUES ($1,$2,$3) RETURNING id",
      [ctx.companyId, `${PREFIX}-C`, "Priority Printing Customer"]
    );
    const customerId = customer.rows[0].id;
    const articleCode = `${PREFIX}-PANTS`;

    const newProforma = async (article: string): Promise<number> => {
      const result = await pool.query<{ id: number }>(
        "INSERT INTO customer_proformas (company_id, customer_id, name, is_active) VALUES ($1,$2,$3,TRUE) RETURNING id",
        [ctx.companyId, customerId, `${PREFIX}-${article}`]
      );
      await pool.query(
        "INSERT INTO customer_proforma_lines (proforma_id, article_code, product_name, quantity, price_per_bale) VALUES ($1,$2,$3,1,'10.00')",
        [result.rows[0].id, article, article]
      );
      return result.rows[0].id;
    };
    const firstProforma = await newProforma(articleCode);
    const nextProforma = await newProforma(`${PREFIX}-OTHER`);
    const newLoading = async (proformaId: number) => {
      const result = await pool.query<{ id: number }>(
        "INSERT INTO customer_orders (company_id, customer_id, order_date, status, proforma_id_used) VALUES ($1,$2,'2026-10-09','LOADING',$3) RETURNING id",
        [ctx.companyId, customerId, proformaId]
      );
      return result.rows[0].id;
    };
    const firstOrderId = await newLoading(firstProforma);
    const secondOrderId = await newLoading(nextProforma);
    const configure = async (orderId: number, color: string, priority: number) =>
      agent
        .put(`/api/factory/customer-orders/${orderId}/loading-list/priority-scan-config`)
        .send({ color, priority, enabled: true });
    expect((await configure(firstOrderId, "#B22222", 1)).status).toBe(200);
    expect((await configure(secondOrderId, "#6A5ACD", 2)).status).toBe(200);

    const ref = `${PREFIX.toUpperCase()}-001`;
    const bale = await pool.query<{ id: number }>(
      `INSERT INTO factory_bales
        (company_id, bale_code, reference_number, article_code, product_name,
         erp_location_id, weight_kg, cost_per_kg, total_cost, status)
       VALUES ($1,$2,$2,$3,'Adult Jogger Pant',$4,'40.000','1.00','40.00','IN_STOCK')
       RETURNING id`,
      [ctx.companyId, ref, articleCode, ctx.locationId]
    );
    const baleId = bale.rows[0].id;

    expect((await agent.put("/api/factory/automatic-priority-mode").send({ enabled: true })).status).toBe(200);
    const print = await agent.post("/api/bale-label-prints/reprint").send({ baleId });
    expect(print.status).toBe(200);
    expect(print.body.priorityAllocation).toMatchObject({
      baleId,
      orderId: firstOrderId,
      color: "#B22222",
      priority: 1,
      existing: false,
    });

    const secondPrint = await agent.post("/api/bale-label-prints/reprint").send({ baleId });
    expect(secondPrint.status).toBe(200);
    expect(secondPrint.body.priorityAllocation).toMatchObject({
      baleId,
      orderId: firstOrderId,
      color: "#B22222",
      priority: 1,
      existing: true,
    });
    const linkage = await pool.query<{ id: number }>(
      "SELECT id FROM customer_order_bales WHERE order_id = $1 AND bale_id = $2",
      [firstOrderId, baleId]
    );
    expect(linkage.rows).toHaveLength(1);

    // Full proforma causes Red to auto-complete, leaving Blue at #1.
    const afterFulfilled = await agent.get("/api/factory/customer-orders/loading-list/priority-scan-configs");
    expect(afterFulfilled.body.find((r: { orderId: number }) => r.orderId === firstOrderId).enabled).toBe(false);

    // A loading-bale removal preserves historical evidence, releases the unique
    // active allocation, and returns the previously completed loading to #1.
    const remove = await agent.delete(`/api/factory/customer-orders/${firstOrderId}/bales/${linkage.rows[0].id}`);
    expect(remove.status).toBe(200);
    const afterRemoval = await agent.get("/api/factory/customer-orders/loading-list/priority-scan-configs");
    const red = afterRemoval.body.find((r: { orderId: number }) => r.orderId === firstOrderId);
    expect(red.enabled).toBe(true);
    expect(red.priority).toBe(1);
    const autoRows = await pool.query<{ reversed_at: string | null }>(
      "SELECT reversed_at FROM factory_priority_auto_allocations WHERE company_id=$1 AND bale_id=$2",
      [ctx.companyId, baleId]
    );
    expect(autoRows.rows).toHaveLength(1);
    expect(autoRows.rows[0].reversed_at).not.toBeNull();

    // OFF stops only FUTURE automation; it does not erase permanent evidence.
    expect((await agent.put("/api/factory/automatic-priority-mode").send({ enabled: false })).status).toBe(200);
    expect((await agent.get("/api/factory/automatic-priority-mode")).body.enabled).toBe(false);
    const noAllocation = await agent.post("/api/bale-label-prints/reprint").send({ baleId });
    expect(noAllocation.status).toBe(200);
    expect(noAllocation.body.priorityAllocation).toBeNull();
  });
});

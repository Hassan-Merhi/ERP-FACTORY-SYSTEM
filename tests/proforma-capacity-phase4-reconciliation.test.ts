import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, pool } from "../server/db";
import { ensureCanonicalStockMovementJournal } from "../server/services/inventory/ensureCanonicalStockMovementJournal";
import { ensureFinancialOperationRequests } from "../server/services/accounting/ensureFinancialOperationRequests";
import { syncProformaReservations } from "../server/routes/factory/_stockReservationHelper";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "phase4cap";
let ctx: TestContext;
let agent: request.SuperAgentTest;
let customerId: number;
let proformaId: number;
let currentOrderId: number;

async function addBale(orderId: number, code: string, suffix: string, status = "SOLD") {
  const bale = await pool.query<{ id: number }>(
    `INSERT INTO factory_bales
       (company_id, bale_code, reference_number, article_code, product_name, weight_kg, cost_per_kg, total_cost, status)
     VALUES ($1, $2, $2, $3, 'Phase 4 Product', '30.000', '1.00', '30.00', $4)
     RETURNING id`,
    [ctx.companyId, `${PREFIX}-${suffix}`, code, status]
  );
  await pool.query(
    `INSERT INTO customer_order_bales
       (order_id, bale_id, bale_reference, location_id, weight, article_code, price_used)
     VALUES ($1, $2, $3, $4, '30.000', $5, '10.00')`,
    [orderId, bale.rows[0].id, `${PREFIX}-${suffix}`, ctx.locationId, code]
  );
}

beforeAll(async () => {
  // cleanupTestData removes rows from runtime-managed tables that drizzle push
  // does not create, so make those shared fixture teardown dependencies available.
  await ensureCanonicalStockMovementJournal(pool);
  await ensureFinancialOperationRequests(pool);
  ctx = await seedTestData(PREFIX);
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

  const customer = await pool.query<{ id: number }>(
    `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, $3) RETURNING id`,
    [ctx.companyId, `${PREFIX}-CUSTOMER`, "Phase 4 Customer"]
  );
  customerId = customer.rows[0].id;
  const proforma = await pool.query<{ id: number }>(
    `INSERT INTO customer_proformas (company_id, customer_id, name, is_active) VALUES ($1, $2, $3, true) RETURNING id`,
    [ctx.companyId, customerId, "Phase 4 Proforma"]
  );
  proformaId = proforma.rows[0].id;
  await pool.query(
    `INSERT INTO customer_proforma_lines (proforma_id, article_code, product_name, quantity, price_per_bale)
     VALUES ($1, 'PH4-A', 'Phase 4 Product', 3, '10.00'), ($1, ' ph4-a ', 'Phase 4 Product', 2, '10.00')`,
    [proformaId]
  );

  const orders = await pool.query<{ id: number; status: string }>(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, proforma_id_used, status, location_id)
     VALUES ($1,$2,'2026-09-10',$3,'VERIFIED',$4),
            ($1,$2,'2026-09-10',$3,'LOADING',$4),
            ($1,$2,'2026-09-10',$3,'CANCELLED',$4)
     RETURNING id,status`,
    [ctx.companyId, customerId, proformaId, ctx.locationId]
  );
  const verifiedId = orders.rows.find((row) => row.status === "VERIFIED")!.id;
  currentOrderId = orders.rows.find((row) => row.status === "LOADING")!.id;
  const cancelledId = orders.rows.find((row) => row.status === "CANCELLED")!.id;
  await addBale(verifiedId, "ph4-a", "verified-1");
  await addBale(verifiedId, "PH4-A", "verified-2");
  await addBale(verifiedId, " PH4-A ", "verified-3");
  await addBale(currentOrderId, "PH4-A", "current-1", "IN_STOCK");
  await addBale(cancelledId, "PH4-A", "cancelled-1", "IN_STOCK");
}, 120000);

afterAll(async () => {
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60000);

describe("Phase 4 proforma reconciliation", () => {
  it("exposes requested/current/sibling/total/remaining from the authoritative endpoint", async () => {
    const response = await agent.get(
      `/api/factory/customer-proformas/${proformaId}/capacity?currentOrderId=${currentOrderId}`
    );
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.body).toEqual(
      expect.objectContaining({
        proformaId,
        requestedTotalQty: 5,
        currentOrderLoadedTotalQty: 1,
        siblingLoadedTotalQty: 3,
        totalConsumedQty: 4,
        remainingTotalQty: 1,
      })
    );
    expect(response.body.articles).toEqual([
      expect.objectContaining({
        normalizedArticleCode: "ph4-a",
        requestedQty: 5,
        currentOrderLoadedQty: 1,
        siblingLoadedQty: 3,
        totalConsumedQty: 4,
        remainingQty: 1,
        productName: "Phase 4 Product",
      }),
    ]);
  });

  it("reconciles duplicate/case variants and includes finalized history while ignoring cancelled orders", async () => {
    await syncProformaReservations(db, ctx.companyId, proformaId);
    const rows = await pool.query<{ article_code: string; reserved_qty: number }>(
      `SELECT article_code, reserved_qty FROM proforma_stock_reservations WHERE company_id=$1 AND proforma_id=$2`,
      [ctx.companyId, proformaId]
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toEqual(expect.objectContaining({ reserved_qty: 1 }));
  });

  it("does not subtract in-loading quantity twice from free-to-promise stock", async () => {
    const response = await agent.get("/api/factory/v2/stock-allocation");
    expect(response.status).toBe(200);
    const row = response.body.stockTruth.find(
      (entry: { articleCode: string }) => entry.articleCode.trim().toLowerCase() === "ph4-a"
    );
    expect(row).toEqual(expect.objectContaining({ reservedNotYetLoaded: 1 }));
    expect(row.freeToPromise).toBe(Math.max(0, row.inStock - 1));
  });
});

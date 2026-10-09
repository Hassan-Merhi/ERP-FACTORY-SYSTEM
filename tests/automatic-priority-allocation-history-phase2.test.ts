/**
 * Phase 2 integration contract — intentionally not executed here.
 * Claude owns running these tests and all CI on the single feature PR.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { db, pool } from "../server/db";
import { ensurePriorityScanSchema } from "../server/startup/priorityScanSchema";
import {
  reversePriorityAllocationForDeletedBaleTx,
} from "../server/routes/factory/customer-orders/priorityAutoAllocation";
import { PRIORITY_SCAN_LOCK_NAMESPACE } from "../server/routes/factory/customer-orders/priorityScanQueue";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "aprh2";
const HISTORY_URL = "/api/factory/customer-orders/loading-list/priority-allocation-history";
const PRINT_PREFLIGHT = "/api/factory/customer-orders/loading-list/automatic-print-preflight";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let baleId: number;
let orderId: number;
let otherCompanyId: number | null = null;
let referenceNumber: string;
let originalHistoryId: number;

beforeAll(async () => {
  await ensurePriorityScanSchema(pool);
  ctx = await seedTestData(PREFIX);
  agent = request.agent(ctx.app);
  await pool.query("UPDATE companies SET company_type = 'factory' WHERE id = $1", [ctx.companyId]);
  await pool.query("UPDATE user_company_roles SET role = 'Admin' WHERE user_id = $1 AND company_id = $2",
    [ctx.userId, ctx.companyId]);
  const login = await agent.post("/api/auth/login").send({
    username: `${PREFIX}_testuser`, password: "testpassword123",
  });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
  const active = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  if (active.status !== 200) throw new Error(`Company selection failed: ${active.status}`);

  const customer = await pool.query<{ id: number }>(
    "INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, $3) RETURNING id",
    [ctx.companyId, `${PREFIX}-customer`, "Phase 2 Customer"]
  );
  const order = await pool.query<{ id: number }>(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status)
     VALUES ($1, $2, '2026-10-09', 'LOADING') RETURNING id`,
    [ctx.companyId, customer.rows[0].id]
  );
  orderId = order.rows[0].id;
  referenceNumber = `${PREFIX}-B-01`;
  const bale = await pool.query<{ id: number }>(
    `INSERT INTO factory_bales
       (company_id, bale_code, reference_number, article_code, product_name,
        erp_location_id, weight_kg, cost_per_kg, total_cost, status)
     VALUES ($1, $2, $2, 'P2-PANT', 'Adult Jogger Pant', $3, '42', '1', '42', 'IN_STOCK')
     RETURNING id`,
    [ctx.companyId, referenceNumber, ctx.locationId]
  );
  baleId = bale.rows[0].id;

  const history = await pool.query<{ id: string }>(
    `INSERT INTO factory_priority_scan_history
       (company_id, order_id, bale_id, reference_number, article_code, product_name,
        priority, color, business_date, scanned_by, assigned_by_user_id, allocation_source)
     VALUES ($1, $2, $3, $4, 'P2-PANT', 'Adult Jogger Pant',
             1, '#dc2626', '2026-10-09', 'Original Loader', $5, 'stock-entry')
     RETURNING id`,
    [ctx.companyId, orderId, baleId, referenceNumber, ctx.userId]
  );
  originalHistoryId = Number(history.rows[0].id);
  await pool.query(
    `INSERT INTO factory_priority_auto_allocations
       (company_id, bale_id, order_id, reference_number, priority, color, allocation_source,
        article_code, assigned_by_user_id, assigned_by_name, history_id)
     VALUES ($1, $2, $3, $4, 1, '#dc2626', 'stock-entry',
             'P2-PANT', $5, 'Original Loader', $6)`,
    [ctx.companyId, baleId, orderId, referenceNumber, ctx.userId, originalHistoryId]
  );
  await pool.query(
    `INSERT INTO customer_order_priority_scan_configs
       (company_id, order_id, color, color_key, priority, enabled)
     VALUES ($1, $2, '#2563eb', '#2563eb', 8, FALSE)`,
    [ctx.companyId, orderId]
  );
}, 120000);

afterAll(async () => {
  if (ctx?.companyId) {
    await pool.query("DELETE FROM factory_priority_auto_allocations WHERE company_id = $1", [ctx.companyId]);
    await pool.query("DELETE FROM factory_priority_scan_history WHERE company_id = $1", [ctx.companyId]);
    await pool.query("DELETE FROM customer_order_priority_scan_configs WHERE company_id = $1", [ctx.companyId]);
  }
  if (otherCompanyId) {
    await pool.query("DELETE FROM factory_priority_scan_history WHERE company_id = $1", [otherCompanyId]);
  }
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60000);

describe("Phase 2: immutable company-scoped Priority Scan allocation timeline", () => {
  it("returns original loading, priority, color, actor and timestamp despite a changed queue", async () => {
    const res = await agent.get(HISTORY_URL).query({ baleId });
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      baleId, orderId, referenceNumber, articleCode: "P2-PANT",
      originalPriority: 1, originalColor: "#dc2626",
      assignedByName: "Original Loader", assignedByUserId: ctx.userId,
      allocationSource: "stock-entry", active: true,
    });
    expect(res.body.items[0].assignedAt).toBeTruthy();
  });

  it("preserves the original assigned color for reprints after mode is switched OFF", async () => {
    // The company has never enabled automatic mode. Reading the saved
    // allocation must precede the OFF check, without creating a new record.
    const res = await agent.post(PRINT_PREFLIGHT).send({ referenceNumber });
    expect(res.status).toBe(200);
    expect(res.body.priorityAllocation).toMatchObject({
      orderId, baleId, color: "#dc2626", priority: 1, existing: true,
    });
    const rows = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM factory_priority_auto_allocations WHERE company_id = $1 AND bale_id = $2",
      [ctx.companyId, baleId]
    );
    expect(rows.rows[0].count).toBe("1");
  });

  it("does not duplicate the active allocation or history on repeated ON-mode reprints", async () => {
    const on = await agent.put("/api/factory/automatic-priority-mode").send({ enabled: true });
    expect(on.status).toBe(200);
    for (let attempt = 0; attempt < 3; attempt++) {
      const reprint = await agent.post(PRINT_PREFLIGHT).send({ referenceNumber });
      expect(reprint.status).toBe(200);
      expect(reprint.body.priorityAllocation).toMatchObject({
        baleId, orderId, color: "#dc2626", priority: 1, existing: true,
      });
    }
    const snapshot = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM factory_priority_auto_allocations WHERE company_id = $1 AND bale_id = $2 AND reversed_at IS NULL",
      [ctx.companyId, baleId]
    );
    const timeline = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM factory_priority_scan_history WHERE company_id = $1 AND bale_id = $2",
      [ctx.companyId, baleId]
    );
    expect(snapshot.rows[0].count).toBe("1");
    expect(timeline.rows[0].count).toBe("1");

    await expect(pool.query(
      `INSERT INTO factory_priority_auto_allocations
         (company_id, bale_id, order_id, reference_number, priority, color, allocation_source)
       VALUES ($1, $2, $3, $4, 1, '#dc2626', 'reprint')`,
      [ctx.companyId, baleId, orderId, referenceNumber]
    )).rejects.toMatchObject({ code: "23505" });

    const off = await agent.put("/api/factory/automatic-priority-mode").send({ enabled: false });
    expect(off.status).toBe(200);
  });

  it("rejects unbounded or malformed queries", async () => {
    for (const query of [
      {}, { baleId: "NaN" }, { orderId: -1 },
      { baleId, limit: 101 }, { baleId, beforeId: "wrong" },
      { referenceNumber: "" },
    ]) {
      const res = await agent.get(HISTORY_URL).query(query);
      expect(res.status).toBe(400);
    }
  });

  it("marks a reversal without losing original allocation evidence", async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, ${ctx.companyId})`);
      await reversePriorityAllocationForDeletedBaleTx(tx, {
        companyId: ctx.companyId, baleId, actor: "Supervisor",
        actorId: ctx.userId, reason: "Physical bale deleted",
      });
    });

    const res = await agent.get(HISTORY_URL).query({ referenceNumber });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      originalPriority: 1, originalColor: "#dc2626",
      assignedByName: "Original Loader",
      reversedBy: "Supervisor", reversedByUserId: ctx.userId,
      reversalReason: "Physical bale deleted", active: false,
    });
    expect(res.body.items[0].reversedAt).toBeTruthy();

    const reprint = await agent.post(PRINT_PREFLIGHT).send({ referenceNumber });
    expect(reprint.status).toBe(200);
    expect(reprint.body.priorityAllocation).toBeNull();
  });

  it("retains both an archived event and a later manual assignment with cursor pagination", async () => {
    await pool.query(
      `INSERT INTO factory_priority_scan_history
         (company_id, order_id, bale_id, reference_number, priority, color,
          business_date, scanned_by, allocation_source)
       VALUES ($1, $2, $3, $4, 2, '#2563eb',
               '2026-10-09', 'Manual Loader', 'manual')`,
      [ctx.companyId, orderId, baleId, referenceNumber]
    );
    const first = await agent.get(HISTORY_URL).query({ orderId, limit: 1 });
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(1);
    expect(first.body.items[0]).toMatchObject({
      originalPriority: 2, originalColor: "#2563eb", allocationSource: "manual",
    });
    expect(first.body.nextCursor).toBeTruthy();

    const older = await agent.get(HISTORY_URL).query({ baleId, beforeId: first.body.nextCursor, limit: 1 });
    expect(older.status).toBe(200);
    expect(older.body.items).toHaveLength(1);
    expect(older.body.items[0]).toMatchObject({
      id: originalHistoryId, originalPriority: 1, originalColor: "#dc2626", active: false,
    });
  });

  it("never returns another company's allocation, even for a matching reference", async () => {
    const company = await pool.query<{ id: number }>(
      `INSERT INTO companies (code, name, base_currency, company_type)
       VALUES ('APRH2ALT', '${PREFIX}-other-company', 'USD', 'factory') RETURNING id`
    );
    otherCompanyId = company.rows[0].id;
    await pool.query(
      `INSERT INTO factory_priority_scan_history
         (company_id, order_id, bale_id, reference_number, priority, color, business_date, allocation_source)
       VALUES ($1, 99999, 99999, $2, 77, '#000000', '2026-10-09', 'manual')`,
      [otherCompanyId, referenceNumber]
    );
    const res = await agent.get(HISTORY_URL).query({ referenceNumber });
    expect(res.status).toBe(200);
    expect(res.body.items.every((item: { originalPriority: number }) => item.originalPriority !== 77)).toBe(true);
  });
});

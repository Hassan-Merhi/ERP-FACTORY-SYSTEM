import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "phase23race";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let poId = 0;
let containerId = 0;

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
  const supplierId = supplier.rows[0].id;

  const container = await pool.query<{ id: number }>(
    `INSERT INTO containers
       (company_id, container_number, supplier_id, status, import_date, items_total, charges_total, grand_total)
     VALUES ($1, $2, $3, 'OTW', '2026-09-15', '0', '0', '0')
     RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX.toUpperCase()}-CONT`, supplierId]
  );
  containerId = container.rows[0].id;

  const po = await pool.query<{ id: number }>(
    `INSERT INTO purchase_orders
       (company_id, po_number, container_id, supplier_id, currency, items_total,
        freight, surcharge, fumigation, document_charges, discount, other_charges, status)
     VALUES ($1, $2, $3, $4, 'USD', '0', '0', '0', '0', '0', '0', '0', 'Open')
     RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX.toUpperCase()}-PO`, containerId, supplierId]
  );
  poId = po.rows[0].id;
}, 60_000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 30_000);

describe("Phase 23 — aggregate concurrency guards", () => {
  it("rejects a purchase-order edit while the same container lifecycle lock is held", async () => {
    const lockClient = await pool.connect();
    try {
      const locked = await lockClient.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1, $2) AS locked",
        [ctx.companyId, containerId]
      );
      expect(locked.rows[0]?.locked).toBe(true);

      const response = await agent.patch(`/api/purchase-orders/${poId}`).send({
        items: [],
      });

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: "CONTAINER_WRITE_IN_PROGRESS" });
    } finally {
      await lockClient.query("SELECT pg_advisory_unlock($1, $2)", [ctx.companyId, containerId]);
      lockClient.release();
    }
  });

  it("allows the purchase-order edit guard to release its lifecycle lock after a completed request", async () => {
    const response = await agent.patch(`/api/purchase-orders/${poId}`).send({
      items: [],
    });
    expect(response.status).not.toBe(409);

    const probe = await pool.connect();
    try {
      const locked = await probe.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1, $2) AS locked",
        [ctx.companyId, containerId]
      );
      expect(locked.rows[0]?.locked).toBe(true);
      await probe.query("SELECT pg_advisory_unlock($1, $2)", [ctx.companyId, containerId]);
    } finally {
      probe.release();
    }
  });

  it("rejects a simultaneous Supplier Partner offload on the same company/container key", async () => {
    await pool.query("UPDATE companies SET company_type = 'supplier_partner' WHERE id = $1", [ctx.companyId]);
    const spContainerId = containerId + 1_000_000;

    const lockClient = await pool.connect();
    try {
      const locked = await lockClient.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1, $2) AS locked",
        [ctx.companyId, spContainerId]
      );
      expect(locked.rows[0]?.locked).toBe(true);

      const response = await agent.post("/api/sp/offload").send({
        containerId: spContainerId,
        locationId: ctx.locationId,
        offloadDate: "2026-09-15",
        chargeLines: [],
      });

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: "SP_OFFLOAD_IN_PROGRESS" });
    } finally {
      await lockClient.query("SELECT pg_advisory_unlock($1, $2)", [ctx.companyId, spContainerId]);
      lockClient.release();
    }
  });
});

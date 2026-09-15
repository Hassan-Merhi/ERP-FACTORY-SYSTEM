/**
 * Phase 3 backend coverage — Factory read-route success paths.
 *
 * The highest uncovered read module in the last valid backend coverage report
 * is /api/factory/suppliers/with-balances. This suite builds a real factory
 * tenant, supplier, OTW container and transporter in PostgreSQL, then exercises
 * the list/detail/balance reads through normal authenticated HTTP requests.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "p3facrd";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let factoryCompanyId: number;
let supplierId: number;
let containerId: number;
let transporterId: number;

beforeAll(async () => {
  // Start with the normal integration fixture so auth, roles and permissions
  // are created through the same path used by the rest of the backend suite.
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);

  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status} ${login.text}`);

  const company = await pool.query<{ id: number }>(
    `INSERT INTO companies (code, name, company_type, active, base_currency)
     VALUES ($1, $2, 'factory', true, 'USD')
     RETURNING id`,
    ["P3FCRD", `${TEST_PREFIX}_FactoryCompany`]
  );
  factoryCompanyId = company.rows[0].id;

  await pool.query(
    `INSERT INTO user_company_roles
       (user_id, company_id, role, can_delete_records, can_sell_negative_stock)
     VALUES ($1, $2, 'Admin', true, true)`,
    [ctx.userId, factoryCompanyId]
  );
  await pool.query(
    `INSERT INTO user_security_permissions (user_id, company_id, permission, granted_by)
     SELECT user_id, $2, permission, granted_by
       FROM user_security_permissions
      WHERE user_id = $1 AND company_id = $3
     ON CONFLICT (user_id, company_id, permission) DO NOTHING`,
    [ctx.userId, factoryCompanyId, ctx.companyId]
  );

  const selected = await agent.post("/api/auth/set-company").send({ companyId: factoryCompanyId });
  if (selected.status !== 200) {
    throw new Error(`Factory company selection failed: ${selected.status} ${selected.text}`);
  }

  const supplier = await agent.post("/api/factory/suppliers").send({
    name: `${TEST_PREFIX}_Supplier`,
    currencyCode: "USD",
  });
  if (supplier.status !== 200 || !supplier.body?.id) {
    throw new Error(`Supplier seed failed: ${supplier.status} ${supplier.text}`);
  }
  supplierId = Number(supplier.body.id);

  const container = await pool.query<{ id: number }>(
    `INSERT INTO factory_containers
       (company_id, supplier_id, container_number, total_kg, rate_per_kg, currency_code, status)
     VALUES ($1, $2, $3, '1000.000', '2.50', 'USD', 'PENDING')
     RETURNING id`,
    [factoryCompanyId, supplierId, `${TEST_PREFIX.toUpperCase()}-CONT`]
  );
  containerId = container.rows[0].id;

  const transporter = await agent.post("/api/factory/transporters").send({
    name: `${TEST_PREFIX}_Transporter`,
    phone: "+260000000000",
    notes: "Phase 3 seeded transporter",
  });
  if (transporter.status !== 200 || !transporter.body?.id) {
    throw new Error(`Transporter seed failed: ${transporter.status} ${transporter.text}`);
  }
  transporterId = Number(transporter.body.id);
}, 120000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 120000);

describe("Phase 3 Factory read success paths", () => {
  it("lists the seeded factory supplier", async () => {
    const response = await agent.get("/api/factory/suppliers");

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.some((row: { id?: number }) => row.id === supplierId)).toBe(true);
  });

  it("executes the highest-ranked supplier with-balances read against a real OTW container", async () => {
    const response = await agent.get("/api/factory/suppliers/with-balances?includeOtw=true");

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);

    const supplier = response.body.find((row: { id?: number }) => row.id === supplierId) as
      | {
          id: number;
          totalContainers: number;
          pendingContainers: number;
          totalKg: string;
          totalValue: string;
          fxUnresolved: boolean;
        }
      | undefined;

    expect(supplier).toBeDefined();
    expect(supplier?.totalContainers).toBe(1);
    expect(supplier?.pendingContainers).toBe(1);
    expect(Number(supplier?.totalKg)).toBeCloseTo(1000, 3);
    expect(Number(supplier?.totalValue)).toBeCloseTo(2500, 2);
    expect(supplier?.fxUnresolved).toBe(false);
  });

  it("reads the same supplier through the single-balance endpoint", async () => {
    const response = await agent.get(`/api/factory/suppliers/${supplierId}/balance`);

    expect(response.status).toBe(200);
    expect(Number(response.body.balance)).toBeCloseTo(2500, 2);
    expect(Number(response.body.outstandingUsd)).toBeCloseTo(2500, 2);
    expect(response.body.fxUnresolved).toBe(false);
  });

  it("returns the seeded direct container for the supplier", async () => {
    const response = await agent.get(`/api/factory/suppliers/${supplierId}/direct-containers`);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.some((row: { id?: number }) => row.id === containerId)).toBe(true);
  });

  it("lists the seeded factory transporter with a zero opening activity balance", async () => {
    const response = await agent.get("/api/factory/transporters");

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    const transporter = response.body.find((row: { id?: number }) => row.id === transporterId);
    expect(transporter).toMatchObject({
      id: transporterId,
      totalCharged: 0,
      totalPaid: 0,
      outstanding: 0,
    });
  });

  it("reads the seeded factory transporter detail and its empty statement", async () => {
    const response = await agent.get(`/api/factory/transporters/${transporterId}`);

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(transporterId);
    expect(Array.isArray(response.body.transactions)).toBe(true);
    expect(response.body.transactions).toHaveLength(0);
    expect(response.body.totalCharged).toBe(0);
    expect(response.body.totalPaid).toBe(0);
    expect(response.body.outstanding).toBe(0);
  });

  it("keeps every read fixture tenant-scoped in PostgreSQL", async () => {
    const rows = await pool.query<{
      supplier_company_id: number;
      container_company_id: number;
      transporter_company_id: number;
    }>(
      `SELECT
         (SELECT company_id FROM factory_suppliers WHERE id = $1) AS supplier_company_id,
         (SELECT company_id FROM factory_containers WHERE id = $2) AS container_company_id,
         (SELECT company_id FROM factory_transporters WHERE id = $3) AS transporter_company_id`,
      [supplierId, containerId, transporterId]
    );

    expect(rows.rows[0]).toEqual({
      supplier_company_id: factoryCompanyId,
      container_company_id: factoryCompanyId,
      transporter_company_id: factoryCompanyId,
    });
  });
});

/**
 * Behavioural coverage for the factory supplier CRUD write routes.
 *
 * All seven were guard-only: `npm run audit:write-routes` showed nothing but
 * `tests/write-route-guard-sweep.test.ts` naming them, so the only thing
 * asserted about them was that they refuse an anonymous caller. They sit on
 * `factory_suppliers`, which the net-position report reads to compute what the
 * company owes, and one of them hard-deletes through `factory_raw_stock` and
 * `factory_containers`.
 *
 * The properties worth holding here are the ones a refactor would quietly
 * break:
 *
 *   - every route is scoped to the session's company, so a supplier belonging
 *     to another company is a 404 rather than a silent cross-tenant write;
 *   - DELETE is a soft delete and keeps the row, because the balance history
 *     hanging off it still has to resolve;
 *   - `DELETE .../permanent` is the one that really removes data, and it must
 *     take the supplier's containers and raw stock with it rather than orphan
 *     rows that later sum into a balance nobody can explain.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "supcrud";

let ctx: TestContext;
let agent: request.SuperAgentTest;

/** A supplier owned by a different company, for the isolation checks. */
let foreignCompanyId: number;
let foreignSupplierId: number;

async function createSupplier(name: string, extra: Record<string, unknown> = {}) {
  const response = await agent.post("/api/factory/suppliers").send({ name, ...extra });
  if (response.status !== 200) throw new Error(`Seed supplier failed: ${response.status} ${response.text}`);
  return response.body as { id: number; name: string; isActive: boolean; openingBalance: string | null };
}

async function supplierRow(id: number) {
  const result = await pool.query<{
    id: number;
    is_active: boolean | null;
    opening_balance: string | null;
    is_broker: boolean | null;
    parent_id: number | null;
  }>(`SELECT id, is_active, opening_balance, is_broker, parent_id FROM factory_suppliers WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
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
    `INSERT INTO companies (code, name, company_type, base_currency)
     VALUES ($1, $2, 'factory', 'USD') RETURNING id`,
    [`${TEST_PREFIX}FGN`, `${TEST_PREFIX}_ForeignCompany`]
  );
  foreignCompanyId = company.rows[0].id;

  const foreign = await pool.query<{ id: number }>(
    `INSERT INTO factory_suppliers (company_id, name) VALUES ($1, $2) RETURNING id`,
    [foreignCompanyId, `${TEST_PREFIX}_foreign_supplier`]
  );
  foreignSupplierId = foreign.rows[0].id;
}, 120000);

afterAll(async () => {
  await pool.query(`DELETE FROM factory_suppliers WHERE company_id = $1`, [foreignCompanyId]);
  await pool.query(`DELETE FROM companies WHERE id = $1`, [foreignCompanyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("POST /api/factory/suppliers", () => {
  it("files the supplier under the session's company", async () => {
    const response = await agent.post("/api/factory/suppliers").send({ name: `${TEST_PREFIX}_scoped` });

    expect(response.status).toBe(200);
    const row = await pool.query<{ company_id: number }>(`SELECT company_id FROM factory_suppliers WHERE id = $1`, [
      response.body.id,
    ]);
    expect(row.rows[0].company_id).toBe(ctx.companyId);
  });

  it("refuses a body that names a company the session cannot reach", async () => {
    // The handler overwrites companyId from the session anyway, so this would
    // be harmless — but the request is turned away before it gets there, which
    // is the stronger guarantee and the one worth pinning.
    const response = await agent
      .post("/api/factory/suppliers")
      .send({ name: `${TEST_PREFIX}_cross`, companyId: foreignCompanyId });

    expect(response.status).toBe(403);
    const rows = await pool.query(`SELECT id FROM factory_suppliers WHERE company_id = $1 AND name = $2`, [
      foreignCompanyId,
      `${TEST_PREFIX}_cross`,
    ]);
    expect(rows.rowCount).toBe(0);
  });

  it("rejects a supplier with no name", async () => {
    const response = await agent.post("/api/factory/suppliers").send({});
    expect(response.status).toBe(400);
  });
});

describe("PATCH /api/factory/suppliers/:id", () => {
  it("updates a supplier in the session's company", async () => {
    const supplier = await createSupplier(`${TEST_PREFIX}_patch`);
    const response = await agent.patch(`/api/factory/suppliers/${supplier.id}`).send({ contactPerson: "Amal" });

    expect(response.status).toBe(200);
    expect(response.body.contactPerson).toBe("Amal");
  });

  it("does not touch a supplier owned by another company", async () => {
    const before = await supplierRow(foreignSupplierId);
    const response = await agent.patch(`/api/factory/suppliers/${foreignSupplierId}`).send({ name: "hijacked" });

    expect(response.status).toBe(404);
    expect(await supplierRow(foreignSupplierId)).toEqual(before);
  });

  it("rejects a non-numeric id", async () => {
    const response = await agent.patch("/api/factory/suppliers/not-an-id").send({ name: "x" });
    expect(response.status).toBe(400);
  });
});

describe("DELETE /api/factory/suppliers/:id", () => {
  it("deactivates the supplier without removing the row", async () => {
    const supplier = await createSupplier(`${TEST_PREFIX}_soft`);
    const response = await agent.delete(`/api/factory/suppliers/${supplier.id}`);

    expect(response.status).toBe(200);
    // The row has to survive: container and payment history still points at it,
    // and the net-position report resolves supplier names through it.
    const row = await supplierRow(supplier.id);
    expect(row).not.toBeNull();
    expect(row?.is_active).toBe(false);
  });

  it("does not deactivate a supplier owned by another company", async () => {
    const response = await agent.delete(`/api/factory/suppliers/${foreignSupplierId}`);

    expect(response.status).toBe(404);
    expect((await supplierRow(foreignSupplierId))?.is_active).not.toBe(false);
  });
});

describe("PATCH /api/factory/suppliers/:id/reactivate", () => {
  it("puts a deactivated supplier back", async () => {
    const supplier = await createSupplier(`${TEST_PREFIX}_reactivate`);
    await agent.delete(`/api/factory/suppliers/${supplier.id}`);
    expect((await supplierRow(supplier.id))?.is_active).toBe(false);

    const response = await agent.patch(`/api/factory/suppliers/${supplier.id}/reactivate`);

    expect(response.status).toBe(200);
    expect((await supplierRow(supplier.id))?.is_active).toBe(true);
  });

  it("does not reactivate across companies", async () => {
    const response = await agent.patch(`/api/factory/suppliers/${foreignSupplierId}/reactivate`);
    expect(response.status).toBe(404);
  });
});

describe("PATCH /api/factory/suppliers/:id/opening-balance", () => {
  it("overwrites the opening balance with the value sent", async () => {
    const supplier = await createSupplier(`${TEST_PREFIX}_ob`);
    const response = await agent
      .patch(`/api/factory/suppliers/${supplier.id}/opening-balance`)
      .send({ openingBalance: "1250.75" });

    expect(response.status).toBe(200);
    // This value is added straight into the supplier's balance by the
    // net-position report, so it must land as sent rather than accumulate.
    expect(Number((await supplierRow(supplier.id))?.opening_balance)).toBeCloseTo(1250.75, 2);

    await agent.patch(`/api/factory/suppliers/${supplier.id}/opening-balance`).send({ openingBalance: "-40" });
    expect(Number((await supplierRow(supplier.id))?.opening_balance)).toBeCloseTo(-40, 2);
  });

  it("rejects a missing or non-numeric opening balance", async () => {
    const supplier = await createSupplier(`${TEST_PREFIX}_ob_bad`);

    expect((await agent.patch(`/api/factory/suppliers/${supplier.id}/opening-balance`).send({})).status).toBe(400);
    expect(
      (await agent.patch(`/api/factory/suppliers/${supplier.id}/opening-balance`).send({ openingBalance: "abc" }))
        .status
    ).toBe(400);
    // A rejected request must leave the stored balance alone.
    expect((await supplierRow(supplier.id))?.opening_balance ?? "0").toMatch(/^0(\.0+)?$/);
  });

  it("does not set an opening balance across companies", async () => {
    const response = await agent
      .patch(`/api/factory/suppliers/${foreignSupplierId}/opening-balance`)
      .send({ openingBalance: "999" });

    expect(response.status).toBe(404);
    expect((await supplierRow(foreignSupplierId))?.opening_balance ?? "0").toMatch(/^0(\.0+)?$/);
  });
});

describe("PATCH /api/factory/suppliers/:id/set-broker", () => {
  it("sets and clears the broker flag", async () => {
    const supplier = await createSupplier(`${TEST_PREFIX}_broker`);

    expect(
      (await agent.patch(`/api/factory/suppliers/${supplier.id}/set-broker`).send({ isBroker: true })).status
    ).toBe(200);
    expect((await supplierRow(supplier.id))?.is_broker).toBe(true);

    expect(
      (await agent.patch(`/api/factory/suppliers/${supplier.id}/set-broker`).send({ isBroker: false })).status
    ).toBe(200);
    expect((await supplierRow(supplier.id))?.is_broker).toBe(false);
  });

  it("requires a boolean rather than coercing a truthy value", async () => {
    const supplier = await createSupplier(`${TEST_PREFIX}_broker_bad`);
    const response = await agent.patch(`/api/factory/suppliers/${supplier.id}/set-broker`).send({ isBroker: "yes" });

    expect(response.status).toBe(400);
    expect((await supplierRow(supplier.id))?.is_broker).not.toBe(true);
  });

  it("refuses to make a linked child supplier a broker", async () => {
    const parent = await createSupplier(`${TEST_PREFIX}_parent`);
    const child = await createSupplier(`${TEST_PREFIX}_child`, { parentId: parent.id });

    const response = await agent.patch(`/api/factory/suppliers/${child.id}/set-broker`).send({ isBroker: true });

    // A broker consolidates its children's balances. Letting a child also be a
    // broker would make the net-position rollup count it on both sides.
    expect(response.status).toBe(400);
    expect((await supplierRow(child.id))?.is_broker).not.toBe(true);
  });
});

describe("DELETE /api/factory/suppliers/:id/permanent", () => {
  // Phase 19 (B), PE6: a supplier with history is refused and nothing is
  // removed (the delete used to cascade through containers and raw stock with
  // no transaction or audit, orphaning their journals).
  it("refuses a supplier with containers and raw stock, removing nothing", async () => {
    const supplier = await createSupplier(`${TEST_PREFIX}_permanent`);

    const container = await pool.query<{ id: number }>(
      `INSERT INTO factory_containers (company_id, supplier_id, container_number, total_kg, rate_per_kg, currency_code)
       VALUES ($1, $2, $3, '1000', '2.5', 'USD') RETURNING id`,
      [ctx.companyId, supplier.id, `${TEST_PREFIX}-CONT-1`]
    );
    const containerId = container.rows[0].id;

    await pool.query(
      `INSERT INTO factory_raw_stock (company_id, container_id, received_kg, cost_per_kg, offloaded_at)
       VALUES ($1, $2, '1000', '2.5', now())`,
      [ctx.companyId, containerId]
    );

    const response = await agent.delete(`/api/factory/suppliers/${supplier.id}/permanent`);
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: "FACTORY_SUPPLIER_HAS_HISTORY",
      history: { containers: 1, rawStock: 1 },
    });

    expect(await supplierRow(supplier.id)).not.toBeNull();
    const containers = await pool.query(`SELECT id FROM factory_containers WHERE id = $1`, [containerId]);
    expect(containers.rowCount).toBe(1);
    const rawStock = await pool.query(`SELECT id FROM factory_raw_stock WHERE container_id = $1`, [containerId]);
    expect(rawStock.rowCount).toBe(1);
  });

  it("does not hard-delete a supplier owned by another company", async () => {
    const response = await agent.delete(`/api/factory/suppliers/${foreignSupplierId}/permanent`);

    expect(response.status).toBe(404);
    expect(await supplierRow(foreignSupplierId)).not.toBeNull();
  });
});

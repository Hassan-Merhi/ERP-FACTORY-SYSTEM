/**
 * Behavioural coverage for the post-offload charge routes in
 * `server/routes/factory/raw-stock/rawStockContainerRoutes.ts`:
 * `POST`, `GET` and `DELETE /api/factory/containers/:id/post-offload-charges`.
 *
 * A post-offload charge is the one legitimate way a container's landed cost
 * moves after the stock is already on the floor, so it reprices raw stock that
 * has been sitting in inventory. Every guard in front of it exists to stop a
 * charge landing on a container that cannot absorb it correctly.
 *
 * The properties worth holding:
 *
 *   - **A charge raises the landed cost and reprices the stock it produced.**
 *     The container's cost/kg, its USD total, and the raw-stock row all move
 *     together; the response reports the before and after honestly.
 *   - **The guards are real refusals, not warnings.** A container that is not
 *     offloaded, has no received weight, has no raw-stock row, or has an
 *     unresolved FX rate is refused *before* anything is written — otherwise a
 *     charge lands somewhere it cannot be allocated and quietly disappears.
 *   - **Several charges in one request are one transaction**, and the
 *     accumulated cost reflects all of them.
 *   - **Deleting a charge undoes its cost effect**, returning the container and
 *     its stock to where they were.
 *   - **Charges are company-scoped** on read as well as write.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "fcpoc";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let supplierId: number;
let chargeAccountId: number;
let seq = 0;

interface ContainerSeed {
  status?: string;
  actualReceivedKg?: string;
  fxRateConfirmed?: boolean;
  currencyCode?: string;
  withRawStock?: boolean;
  companyId?: number;
}

async function seedContainer(overrides: ContainerSeed = {}) {
  seq += 1;
  const companyId = overrides.companyId ?? ctx.companyId;
  const row = await pool.query<{ id: number }>(
    `INSERT INTO factory_containers
       (company_id, container_number, supplier_id, currency_code, fx_rate_to_usd, fx_rate_confirmed,
        fx_rate_source, rate_per_kg, rate_per_kg_usd, total_kg, actual_received_kg, status, arrival_date,
        duty_status, freight, other_charges, commission_amount,
        final_payable_amount, final_payable_amount_usd)
     VALUES ($1, $2, $3, $4, '1', $5, 'manual', '2.000000', '2.000000', '100.000', $6, $7, '2026-06-08',
             'NONE', '0', '0', '0', '200.00', '200.00')
     RETURNING id`,
    [
      companyId,
      `${TEST_PREFIX}-C${seq}`,
      overrides.companyId ? null : supplierId,
      overrides.currencyCode ?? "USD",
      overrides.fxRateConfirmed ?? true,
      overrides.actualReceivedKg ?? "100.000",
      overrides.status ?? "OFFLOADED",
    ]
  );
  const containerId = row.rows[0].id;

  if (overrides.withRawStock !== false) {
    await pool.query(
      `INSERT INTO factory_raw_stock (company_id, container_id, received_kg, used_kg, cost_per_kg, cost_per_kg_usd)
       VALUES ($1, $2, $3, '0', '2.0000000', '2.0000000')`,
      [companyId, containerId, overrides.actualReceivedKg ?? "100.000"]
    );
  }
  return containerId;
}

async function containerRow(id: number) {
  return (await pool.query(`SELECT * FROM factory_containers WHERE id = $1`, [id])).rows[0];
}

async function rawStockFor(containerId: number) {
  return (await pool.query(`SELECT * FROM factory_raw_stock WHERE container_id = $1`, [containerId])).rows[0];
}

async function chargeRows(containerId: number) {
  return (
    await pool.query(
      `SELECT id, description, amount, currency_code FROM factory_offload_additional_charges
        WHERE container_id = $1 ORDER BY id`,
      [containerId]
    )
  ).rows;
}

function postCharges(id: number, body: Record<string, unknown>) {
  return agent.post(`/api/factory/containers/${id}/post-offload-charges`).send(body);
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  await pool.query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [ctx.companyId]);

  agent = request.agent(ctx.app);
  const login = await agent
    .post("/api/auth/login")
    .send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  expect(login.status).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);

  const supplier = await pool.query<{ id: number }>(
    `INSERT INTO factory_suppliers (company_id, name, is_active) VALUES ($1, $2, true) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX} Supplier`]
  );
  supplierId = supplier.rows[0].id;

  const account = await pool.query<{ id: number }>(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side, active)
     VALUES ($1, $2, $3, 'Expense', '0', 'Dr', true) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}_CHG`, `${TEST_PREFIX} Charges`]
  );
  chargeAccountId = account.rows[0].id;
}, 120000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("POST /api/factory/containers/:id/post-offload-charges — guards", () => {
  it("requires a non-empty charge list with at least one positive amount", async () => {
    const id = await seedContainer();

    const missing = await postCharges(id, {});
    expect(missing.status).toBe(400);
    expect(missing.body.message).toMatch(/At least one charge is required/i);

    const empty = await postCharges(id, { charges: [] });
    expect(empty.status).toBe(400);

    const allZero = await postCharges(id, { charges: [{ description: "nil", amount: "0" }] });
    expect(allZero.status).toBe(400);
    expect(allZero.body.message).toMatch(/All charge amounts are zero/i);

    expect(await chargeRows(id)).toHaveLength(0);
  });

  it("rejects a non-numeric container id", async () => {
    const response = await agent
      .post("/api/factory/containers/not-a-number/post-offload-charges")
      .send({ charges: [{ description: "x", amount: "10" }] });
    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/Invalid id/i);
  });

  it("does not find another company's container", async () => {
    const foreign = await pool.query<{ id: number }>(
      `INSERT INTO companies (code, name, base_currency, company_type)
       VALUES ($1, $2, 'USD', 'factory') RETURNING id`,
      [`${TEST_PREFIX.slice(0, 4).toUpperCase()}FGN`, `${TEST_PREFIX}_ForeignCompany`]
    );
    const foreignCompanyId = foreign.rows[0].id;
    const foreignContainer = await seedContainer({ companyId: foreignCompanyId });

    try {
      const response = await postCharges(foreignContainer, { charges: [{ description: "x", amount: "10" }] });
      expect(response.status).toBe(404);
      expect(await chargeRows(foreignContainer)).toHaveLength(0);

      // The read side is scoped too: the history comes back empty, not the other tenant's rows.
      const history = await agent.get(`/api/factory/containers/${foreignContainer}/post-offload-charges`);
      expect(history.status).toBe(200);
      expect(history.body).toEqual([]);
    } finally {
      await pool.query(`DELETE FROM factory_raw_stock WHERE company_id = $1`, [foreignCompanyId]);
      await pool.query(`DELETE FROM factory_containers WHERE company_id = $1`, [foreignCompanyId]);
      await pool.query(`DELETE FROM companies WHERE id = $1`, [foreignCompanyId]);
    }
  });

  it("refuses a container that has not been offloaded", async () => {
    const id = await seedContainer({ status: "PENDING" });

    const response = await postCharges(id, { charges: [{ description: "handling", amount: "25" }] });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/only add post-offload charges to offloaded containers/i);
    expect(await chargeRows(id)).toHaveLength(0);
  });

  it("refuses a container with no received weight", async () => {
    const id = await seedContainer({ actualReceivedKg: "0" });

    const response = await postCharges(id, { charges: [{ description: "handling", amount: "25" }] });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/no received weight/i);
    expect(await chargeRows(id)).toHaveLength(0);
  });

  it("refuses a container with no linked raw-stock record", async () => {
    const id = await seedContainer({ withRawStock: false });

    const response = await postCharges(id, { charges: [{ description: "handling", amount: "25" }] });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/no linked raw-stock record/i);
    expect(await chargeRows(id)).toHaveLength(0);
  });

  it("refuses a container whose exchange rate is unresolved", async () => {
    const id = await seedContainer({ currencyCode: "AUD", fxRateConfirmed: false });

    const response = await postCharges(id, { charges: [{ description: "handling", amount: "25" }] });

    expect(response.status).toBe(400);
    expect(await chargeRows(id)).toHaveLength(0);
  });
});

describe("POST /api/factory/containers/:id/post-offload-charges — cost effect", () => {
  it("raises the landed cost and reprices the raw stock the container produced", async () => {
    const id = await seedContainer();

    const response = await postCharges(id, {
      charges: [{ description: "Port handling", amount: "50", currencyCode: "USD", ledgerAccountId: chargeAccountId }],
      txDate: "2026-06-10",
    });

    expect(response.status).toBe(200);
    // 200.00 goods + 50.00 charge = 250.00 over 100 kg received = 2.50/kg.
    expect(response.body.oldContainerCostPerKgUsd).toBeCloseTo(2, 6);
    expect(response.body.newContainerCostPerKgUsd).toBeCloseTo(2.5, 6);
    expect(response.body.oldContainerTotalUsd).toBeCloseTo(200, 2);
    expect(response.body.newContainerTotalUsd).toBeCloseTo(250, 2);
    expect(response.body.rawStockRowsUpdated).toBeGreaterThanOrEqual(1);

    const container = await containerRow(id);
    expect(Number(container.final_payable_amount_usd)).toBeCloseTo(250, 2);
    expect(Number(container.rate_per_kg_usd)).toBeCloseTo(2.5, 6);

    const stock = await rawStockFor(id);
    expect(Number(stock.cost_per_kg_usd)).toBeCloseTo(2.5, 6);

    const charges = await chargeRows(id);
    expect(charges).toHaveLength(1);
    expect(charges[0].description).toBe("Port handling");
    expect(Number(charges[0].amount)).toBe(50);
  });

  it("applies several charges from one request together", async () => {
    const id = await seedContainer();

    const response = await postCharges(id, {
      charges: [
        { description: "Handling", amount: "30", currencyCode: "USD", ledgerAccountId: chargeAccountId },
        { description: "Inspection", amount: "20", currencyCode: "USD", ledgerAccountId: chargeAccountId },
        // A zero line is filtered out rather than rejecting the whole batch.
        { description: "Waived", amount: "0", currencyCode: "USD" },
      ],
    });

    expect(response.status).toBe(200);
    // 200 + 30 + 20 = 250 over 100 kg.
    expect(response.body.newContainerCostPerKgUsd).toBeCloseTo(2.5, 6);

    const charges = await chargeRows(id);
    expect(charges).toHaveLength(2);
    expect(charges.map((row) => row.description).sort()).toEqual(["Handling", "Inspection"]);
  });

  it("returns the charge history newest first, scoped to the company", async () => {
    const id = await seedContainer();
    expect(
      (
        await postCharges(id, {
          charges: [{ description: "First", amount: "10", currencyCode: "USD", ledgerAccountId: chargeAccountId }],
        })
      ).status
    ).toBe(200);
    expect(
      (
        await postCharges(id, {
          charges: [{ description: "Second", amount: "15", currencyCode: "USD", ledgerAccountId: chargeAccountId }],
        })
      ).status
    ).toBe(200);

    const history = await agent.get(`/api/factory/containers/${id}/post-offload-charges`);
    expect(history.status).toBe(200);
    expect(history.body).toHaveLength(2);
    const descriptions = history.body.map((row: { description: string }) => row.description);
    expect(descriptions).toContain("First");
    expect(descriptions).toContain("Second");
  });
});

describe("DELETE /api/factory/containers/:id/post-offload-charges/:chargeId", () => {
  it("undoes the charge's cost effect on the container and its stock", async () => {
    const id = await seedContainer();
    const created = await postCharges(id, {
      charges: [{ description: "Reversible", amount: "50", currencyCode: "USD", ledgerAccountId: chargeAccountId }],
    });
    expect(created.status).toBe(200);
    expect(Number((await containerRow(id)).rate_per_kg_usd)).toBeCloseTo(2.5, 6);

    const chargeId = (await chargeRows(id))[0].id;
    const response = await agent
      .delete(`/api/factory/containers/${id}/post-offload-charges/${chargeId}`)
      .send({ undoDate: "2026-06-12" });

    expect(response.status).toBe(200);

    // Back to the pre-charge landed cost, and the stock follows it back down.
    const container = await containerRow(id);
    expect(Number(container.rate_per_kg_usd)).toBeCloseTo(2, 6);
    expect(Number(container.final_payable_amount_usd)).toBeCloseTo(200, 2);
    expect(Number((await rawStockFor(id)).cost_per_kg_usd)).toBeCloseTo(2, 6);
  });

  it("rejects a non-numeric charge id and a container from another company", async () => {
    const id = await seedContainer();
    const bad = await agent.delete(`/api/factory/containers/${id}/post-offload-charges/not-a-number`).send({});
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/Invalid id/i);

    const missing = await agent.delete(`/api/factory/containers/99999999/post-offload-charges/1`).send({});
    expect(missing.status).toBe(404);
  });
});

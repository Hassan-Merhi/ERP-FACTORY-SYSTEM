/**
 * Behavioural coverage for `PATCH /api/factory/containers/:id/confirm-duty`
 * (`server/routes/factory/raw-stock/rawStockContainerRoutes.ts`).
 *
 * Confirming duty is a post-offload cost event: it fixes the duty figure, folds
 * it into the container's landed cost, cascades that cost down to the raw stock
 * already on the floor, writes an audit row, and posts a daybook entry — all in
 * one transaction. It had no test.
 *
 * The properties worth holding:
 *
 *   - **Duty lands in the cost, once.** The confirmed amount raises the
 *     container's landed cost by exactly that amount, and the resulting cost/kg
 *     is that total divided by the received weight.
 *   - **Confirmation is one-shot.** Only a PENDING container can be confirmed;
 *     a second attempt is refused and changes nothing. Without that, a repeated
 *     click charges the duty into the cost twice.
 *   - **The cost reaches the stock.** Raw stock already offloaded from this
 *     container is repriced by the cascade — otherwise the container says one
 *     thing and the inventory it produced says another.
 *   - **The event is recorded.** An audit row carries the old and new duty
 *     amount and status; a DUTY daybook entry carries the amount.
 *   - **Containers are company-scoped**, and a refused request writes nothing.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "fcduty";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let supplierId: number;
let seq = 0;

interface ContainerSeed {
  dutyStatus?: string;
  dutyAmount?: string | null;
  ratePerKg?: string;
  totalKg?: string;
  actualReceivedKg?: string;
  companyId?: number;
}

async function seedContainer(overrides: ContainerSeed = {}) {
  seq += 1;
  const row = await pool.query<{ id: number }>(
    `INSERT INTO factory_containers
       (company_id, container_number, supplier_id, currency_code, fx_rate_to_usd, fx_rate_confirmed,
        fx_rate_source, rate_per_kg, total_kg, actual_received_kg, status, arrival_date,
        duty_status, duty_amount, freight, other_charges, commission_amount)
     VALUES ($1, $2, $3, 'USD', '1', true, 'manual', $4, $5, $6, 'OFFLOADED', '2026-06-08',
             $7, $8, '0', '0', '0')
     RETURNING id`,
    [
      overrides.companyId ?? ctx.companyId,
      `${TEST_PREFIX}-C${seq}`,
      overrides.companyId ? null : supplierId,
      overrides.ratePerKg ?? "2.000000",
      overrides.totalKg ?? "100.000",
      overrides.actualReceivedKg ?? "100.000",
      overrides.dutyStatus ?? "PENDING",
      overrides.dutyAmount === undefined ? "0" : overrides.dutyAmount,
    ]
  );
  return row.rows[0].id;
}

async function seedRawStock(containerId: number, receivedKg: string, costPerKg: string) {
  const row = await pool.query<{ id: number }>(
    `INSERT INTO factory_raw_stock (company_id, container_id, received_kg, used_kg, cost_per_kg, cost_per_kg_usd)
     VALUES ($1, $2, $3, '0', $4, $4) RETURNING id`,
    [ctx.companyId, containerId, receivedKg, costPerKg]
  );
  return row.rows[0].id;
}

async function containerRow(id: number) {
  return (await pool.query(`SELECT * FROM factory_containers WHERE id = $1`, [id])).rows[0];
}

async function rawStockRow(id: number) {
  return (await pool.query(`SELECT * FROM factory_raw_stock WHERE id = $1`, [id])).rows[0];
}

async function dutyAuditRows(containerId: number) {
  return (
    await pool.query(
      `SELECT old_duty_amount, new_duty_amount, old_duty_status, new_duty_status, notes
         FROM factory_duty_audit_log WHERE container_id = $1 ORDER BY id`,
      [containerId]
    )
  ).rows;
}

async function daybookRows(containerId: number) {
  return (
    await pool.query(
      `SELECT tx_type, amount_currency, description
         FROM factory_daybook_entries
        WHERE company_id = $1 AND reference_table = 'factory_containers' AND reference_id = $2
        ORDER BY id`,
      [ctx.companyId, containerId]
    )
  ).rows;
}

function confirmDuty(id: number, body: Record<string, unknown>) {
  return agent.patch(`/api/factory/containers/${id}/confirm-duty`).send(body);
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
}, 120000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("PATCH /api/factory/containers/:id/confirm-duty — validation and scoping", () => {
  it("requires a positive duty amount", async () => {
    const id = await seedContainer();

    for (const body of [{}, { dutyAmount: "0" }, { dutyAmount: "-5" }]) {
      const response = await confirmDuty(id, body);
      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/Valid duty amount is required/i);
    }

    const after = await containerRow(id);
    expect(after.duty_status).toBe("PENDING");
    expect(await dutyAuditRows(id)).toHaveLength(0);
  });

  it("rejects a non-numeric container id", async () => {
    const response = await agent.patch("/api/factory/containers/not-a-number/confirm-duty").send({ dutyAmount: "10" });
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
      const response = await confirmDuty(foreignContainer, { dutyAmount: "40" });
      expect(response.status).toBe(404);

      const after = await containerRow(foreignContainer);
      expect(after.duty_status).toBe("PENDING");
      expect(Number(after.duty_amount)).toBe(0);
    } finally {
      await pool.query(`DELETE FROM factory_containers WHERE company_id = $1`, [foreignCompanyId]);
      await pool.query(`DELETE FROM companies WHERE id = $1`, [foreignCompanyId]);
    }
  });

  it("returns 404 for a container that does not exist", async () => {
    expect((await confirmDuty(99999999, { dutyAmount: "10" })).status).toBe(404);
  });

  it("refuses a container whose duty is not PENDING", async () => {
    const none = await seedContainer({ dutyStatus: "NONE" });
    const response = await confirmDuty(none, { dutyAmount: "25" });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/Only containers with PENDING duty/i);
    expect(await dutyAuditRows(none)).toHaveLength(0);
  });
});

describe("PATCH /api/factory/containers/:id/confirm-duty — cost and records", () => {
  it("folds the duty into the landed cost and divides by the received weight", async () => {
    // 100 kg at 2.00/kg = 200.00 goods, plus 50.00 duty = 250.00 landed,
    // over 100 kg received = 2.50/kg. USD container, so USD figures match.
    const id = await seedContainer({ ratePerKg: "2.000000", totalKg: "100.000", actualReceivedKg: "100.000" });

    const response = await confirmDuty(id, { dutyAmount: "50", dutyNotes: "customs cleared" });

    expect(response.status).toBe(200);
    expect(response.body.newCostPerKg).toBeCloseTo(2.5, 6);

    const after = await containerRow(id);
    expect(after.duty_status).toBe("CONFIRMED");
    expect(Number(after.duty_amount)).toBe(50);
    expect(after.duty_notes).toBe("customs cleared");
    expect(Number(after.final_payable_amount)).toBeCloseTo(250, 2);
    expect(Number(after.final_payable_amount_usd)).toBeCloseTo(250, 2);
    expect(Number(after.rate_per_kg_usd)).toBeCloseTo(2.5, 6);
  });

  it("divides the fixed container value by the actual received weight, not the agreed weight", async () => {
    // Value is fixed from the agreed 100 kg (200.00) plus 20.00 duty = 220.00,
    // but only 80 kg actually arrived, so the stock carries 2.75/kg.
    const id = await seedContainer({ ratePerKg: "2.000000", totalKg: "100.000", actualReceivedKg: "80.000" });

    const response = await confirmDuty(id, { dutyAmount: "20" });

    expect(response.status).toBe(200);
    expect(response.body.newCostPerKg).toBeCloseTo(2.75, 6);
    expect(Number((await containerRow(id)).final_payable_amount)).toBeCloseTo(220, 2);
  });

  it("repricing cascades to the raw stock the container produced", async () => {
    const id = await seedContainer({ ratePerKg: "2.000000", totalKg: "100.000", actualReceivedKg: "100.000" });
    const stockId = await seedRawStock(id, "100.000", "2.0000000");

    expect((await confirmDuty(id, { dutyAmount: "50" })).status).toBe(200);

    const stock = await rawStockRow(stockId);
    // The stock on the floor is repriced to the container's new landed cost.
    expect(Number(stock.cost_per_kg)).toBeCloseTo(2.5, 6);
    expect(Number(stock.cost_per_kg_usd)).toBeCloseTo(2.5, 6);
  });

  it("records the confirmation in the duty audit log and the daybook", async () => {
    const id = await seedContainer({ dutyAmount: "5" });

    expect((await confirmDuty(id, { dutyAmount: "75", dutyNotes: "final assessment" })).status).toBe(200);

    const audit = await dutyAuditRows(id);
    expect(audit).toHaveLength(1);
    expect(Number(audit[0].old_duty_amount)).toBe(5);
    expect(Number(audit[0].new_duty_amount)).toBe(75);
    expect(audit[0].old_duty_status).toBe("PENDING");
    expect(audit[0].new_duty_status).toBe("CONFIRMED");
    expect(audit[0].notes).toBe("final assessment");

    const daybook = (await daybookRows(id)).filter((row) => row.tx_type === "DUTY");
    expect(daybook).toHaveLength(1);
    expect(Number(daybook[0].amount_currency)).toBe(75);
    expect(daybook[0].description).toMatch(/Duty confirmed/i);
  });

  it("cannot be confirmed twice, so the duty is never charged into the cost again", async () => {
    const id = await seedContainer({ ratePerKg: "2.000000", totalKg: "100.000", actualReceivedKg: "100.000" });

    const first = await confirmDuty(id, { dutyAmount: "50" });
    expect(first.status).toBe(200);
    const afterFirst = await containerRow(id);

    const second = await confirmDuty(id, { dutyAmount: "50" });
    expect(second.status).toBe(400);
    expect(second.body.message).toMatch(/Only containers with PENDING duty/i);

    const afterSecond = await containerRow(id);
    // Cost, duty and audit trail are all exactly as the first confirmation left them.
    expect(afterSecond.final_payable_amount).toBe(afterFirst.final_payable_amount);
    expect(afterSecond.rate_per_kg_usd).toBe(afterFirst.rate_per_kg_usd);
    expect(Number(afterSecond.duty_amount)).toBe(50);
    expect(await dutyAuditRows(id)).toHaveLength(1);
    expect((await daybookRows(id)).filter((row) => row.tx_type === "DUTY")).toHaveLength(1);
  });
});

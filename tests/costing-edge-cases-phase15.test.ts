import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "p15cost";
let ctx: TestContext;
let agent: request.SuperAgentTest;
let supplierId: number;
let existingContainerId: number;

async function makeContainer(input: {
  suffix: string;
  totalKg: string;
  ratePerKg: string;
  currencyCode?: string;
  fxRateToUsd?: string;
  supplierId?: number | null;
}) {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO factory_containers
       (company_id, container_number, supplier_id, total_kg, rate_per_kg,
        currency_code, fx_rate_to_usd, fx_rate_confirmed, status,
        final_payable_amount, final_payable_amount_usd, duty_status, duty_amount)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true, 'RECEIVED', '0', '0', 'NONE', '0')
     RETURNING id`,
    [
      ctx.companyId,
      `${TEST_PREFIX}-${input.suffix}-${Date.now()}`.slice(0, 50),
      input.supplierId === undefined ? supplierId : input.supplierId,
      input.totalKg,
      input.ratePerKg,
      input.currencyCode ?? "USD",
      input.fxRateToUsd ?? "1",
    ]
  );
  return Number(result.rows[0].id);
}

async function supplierLockedRate() {
  const result = await pool.query<{ current_raw_material_cost_per_kg_usd: string | null }>(
    `SELECT current_raw_material_cost_per_kg_usd FROM factory_suppliers WHERE id = $1`,
    [supplierId]
  );
  return Number(result.rows[0].current_raw_material_cost_per_kg_usd || 0);
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  await pool.query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [ctx.companyId]);

  agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  expect(login.status).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);

  const supplier = await pool.query<{ id: number }>(
    `INSERT INTO factory_suppliers
       (company_id, name, opening_balance, is_active, current_raw_material_cost_per_kg_usd)
     VALUES ($1, $2, '0', true, '2.00000000')
     RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX} Supplier`]
  );
  supplierId = Number(supplier.rows[0].id);

  const existing = await pool.query<{ id: number }>(
    `INSERT INTO factory_containers
       (company_id, container_number, supplier_id, total_kg, declared_kg, actual_received_kg,
        rate_per_kg, rate_per_kg_usd, currency_code, fx_rate_to_usd, fx_rate_confirmed,
        status, final_payable_amount, final_payable_amount_usd, duty_status, duty_amount)
     VALUES ($1, $2, $3, '100', '100', '100', '2', '2', 'USD', '1', true,
             'OFFLOADED', '200', '200', 'NONE', '0')
     RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-existing`, supplierId]
  );
  existingContainerId = Number(existing.rows[0].id);
  await pool.query(
    `INSERT INTO factory_raw_stock
       (company_id, container_id, received_kg, used_kg, cost_per_kg, cost_per_kg_usd)
     VALUES ($1, $2, '100', '0', '2', '2')`,
    [ctx.companyId, existingContainerId]
  );
}, 120_000);

afterAll(async () => {
  await pool.query(
    `DELETE FROM factory_mix_batch_sources
      WHERE mix_batch_id IN (SELECT id FROM factory_mix_batches WHERE company_id = $1)`,
    [ctx.companyId]
  );
  await pool.query(`DELETE FROM factory_mix_batches WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_container_receipts WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_daybook_entries WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_raw_stock WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_offload_additional_charges WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_container_commissions WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_containers WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_suppliers WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60_000);

describe("Phase 15 costing edge cases", () => {
  it.each([undefined, "0", "-1", "NaN", "Infinity"])(
    "rejects invalid received weight %s before creating stock or receipt evidence",
    async (receivedKg) => {
      const containerId = await makeContainer({
        suffix: `bad-${String(receivedKg)}`,
        totalKg: "100",
        ratePerKg: "3",
      });
      const payload: Record<string, unknown> = {
        containerId: String(containerId),
        costPerKg: "3",
        currencyCode: "USD",
        fxRateToUsd: "1",
        offloadDate: "2026-09-14",
      };
      if (receivedKg !== undefined) payload.receivedKg = receivedKg;

      const response = await agent.post("/api/factory/raw-stock/offload").send(payload);
      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/receivedKg must be a positive finite number/i);
      expect(
        (await pool.query(`SELECT id FROM factory_raw_stock WHERE container_id = $1`, [containerId])).rowCount
      ).toBe(0);
      expect(
        (await pool.query(`SELECT id FROM factory_container_receipts WHERE container_id = $1`, [containerId])).rowCount
      ).toBe(0);
    },
    60_000
  );

  it("locks the supplier moving average on the first partial receipt and does not reprice it on continuation receipts", async () => {
    const mixBatch = await pool.query<{ id: number }>(
      `INSERT INTO factory_mix_batches
         (company_id, batch_code, total_weight_kg, used_kg, cost_per_kg, total_cost, status)
       VALUES ($1, $2, '10', '0', '0', '0', 'ACTIVE')
       RETURNING id`,
      [ctx.companyId, `${TEST_PREFIX}-mix-${Date.now()}`]
    );
    const mixBatchId = Number(mixBatch.rows[0].id);
    const containerId = await makeContainer({ suffix: "partial", totalKg: "100", ratePerKg: "3" });

    const first = await agent.post("/api/factory/raw-stock/offload").send({
      containerId: String(containerId),
      receivedKg: "40",
      costPerKg: "3",
      currencyCode: "USD",
      fxRateToUsd: "1",
      offloadDate: "2026-09-14",
      idempotencyKey: `${TEST_PREFIX}-partial-1`,
      mixBatchAllocations: [{ mixBatchId: String(mixBatchId), weightKg: "10" }],
    });
    expect(first.status).toBe(200);

    const rawAfterFirst = await pool.query<{ received_kg: string; cost_per_kg_usd: string }>(
      `SELECT received_kg, cost_per_kg_usd FROM factory_raw_stock WHERE container_id = $1`,
      [containerId]
    );
    expect(rawAfterFirst.rowCount).toBe(1);
    expect(Number(rawAfterFirst.rows[0].received_kg)).toBeCloseTo(40, 3);
    expect(Number(rawAfterFirst.rows[0].cost_per_kg_usd)).toBeCloseTo(7.5, 6);

    const expectedLockedRate = (100 * 2 + 40 * 7.5) / 140;
    const lockedAfterFirst = await supplierLockedRate();
    expect(lockedAfterFirst).toBeCloseTo(expectedLockedRate, 8);

    const source = await pool.query<{
      source_type: string;
      supplier_id: number;
      inventory_supplier_id: number;
      weight_kg: string;
      cost_per_kg: string;
      total_cost: string;
    }>(
      `SELECT source_type, supplier_id, inventory_supplier_id, weight_kg, cost_per_kg, total_cost
         FROM factory_mix_batch_sources
        WHERE mix_batch_id = $1 AND container_id = $2`,
      [mixBatchId, containerId]
    );
    expect(source.rowCount).toBe(1);
    expect(source.rows[0].source_type).toBe("SUPPLIER_FIFO");
    expect(Number(source.rows[0].supplier_id)).toBe(supplierId);
    expect(Number(source.rows[0].inventory_supplier_id)).toBe(supplierId);
    expect(Number(source.rows[0].cost_per_kg)).toBeCloseTo(expectedLockedRate, 6);
    expect(Number(source.rows[0].total_cost)).toBeCloseTo(10 * expectedLockedRate, 5);

    const second = await agent.post("/api/factory/raw-stock/offload").send({
      containerId: String(containerId),
      receivedKg: "60",
      costPerKg: "3",
      currencyCode: "USD",
      fxRateToUsd: "1",
      offloadDate: "2026-09-15",
      idempotencyKey: `${TEST_PREFIX}-partial-2`,
    });
    expect(second.status).toBe(200);

    const rawAfterSecond = await pool.query<{ received_kg: string; cost_per_kg_usd: string }>(
      `SELECT received_kg, cost_per_kg_usd FROM factory_raw_stock WHERE container_id = $1`,
      [containerId]
    );
    expect(Number(rawAfterSecond.rows[0].received_kg)).toBeCloseTo(100, 3);
    expect(Number(rawAfterSecond.rows[0].cost_per_kg_usd)).toBeCloseTo(7.5, 6);
    expect(await supplierLockedRate()).toBeCloseTo(lockedAfterFirst, 8);

    const receipts = await pool.query<{
      received_kg: string;
      cumulative_received_kg: string;
      fixed_cost_per_kg_usd: string;
    }>(
      `SELECT received_kg, cumulative_received_kg, fixed_cost_per_kg_usd
         FROM factory_container_receipts
        WHERE container_id = $1
        ORDER BY id`,
      [containerId]
    );
    expect(receipts.rows).toHaveLength(2);
    expect(receipts.rows.map((row) => Number(row.received_kg))).toEqual([40, 60]);
    expect(receipts.rows.map((row) => Number(row.cumulative_received_kg))).toEqual([40, 100]);
    expect(receipts.rows.every((row) => Math.abs(Number(row.fixed_cost_per_kg_usd) - 7.5) < 0.000001)).toBe(true);
  }, 120_000);

  it("preserves multi-currency FX precision in landed cost and stored charge evidence", async () => {
    const containerId = await makeContainer({
      suffix: "fx",
      totalKg: "1000",
      ratePerKg: "1",
      currencyCode: "EUR",
      fxRateToUsd: "1.23456789",
      supplierId: null,
    });

    const response = await agent.post("/api/factory/raw-stock/offload").send({
      containerId: String(containerId),
      receivedKg: "1000",
      costPerKg: "1",
      currencyCode: "EUR",
      fxRateToUsd: "1.23456789",
      freight: "100",
      freightCurrencyCode: "GBP",
      freightFxRate: "1.25",
      freightAccountId: String(ctx.cashAccountId),
      otherCharges: "50",
      otherChargesCurrencyCode: "EUR",
      otherChargesFxRate: "1.23456789",
      otherChargesAccountId: String(ctx.cashAccountId),
      dutyStatus: "CONFIRMED",
      dutyAmount: "10",
      dutyAccountId: String(ctx.cashAccountId),
      additionalCharges: [
        {
          description: "USD inspection",
          amount: "20",
          currencyCode: "USD",
          fxRateToUsd: "1",
          ledgerAccountId: String(ctx.cashAccountId),
        },
      ],
      offloadDate: "2026-09-14",
      idempotencyKey: `${TEST_PREFIX}-fx`,
    });
    expect(response.status).toBe(200);

    const expectedUsd = 1000 * 1 * 1.23456789 + 100 * 1.25 + 50 * 1.23456789 + 10 * 1.23456789 + 20;
    const container = await pool.query<{
      fx_rate_to_usd: string;
      fx_rate_to_usd_offload: string;
      final_payable_amount_usd: string;
      rate_per_kg_usd: string;
    }>(
      `SELECT fx_rate_to_usd, fx_rate_to_usd_offload, final_payable_amount_usd, rate_per_kg_usd
         FROM factory_containers
        WHERE id = $1`,
      [containerId]
    );
    expect(Number(container.rows[0].fx_rate_to_usd)).toBeCloseTo(1.23456789, 8);
    expect(Number(container.rows[0].fx_rate_to_usd_offload)).toBeCloseTo(1.23456789, 8);
    // final_payable_amount_usd is persisted at four decimal places; validate the
    // persisted contract rather than asking the rounded column for more precision
    // than its schema can represent.
    expect(Number(container.rows[0].final_payable_amount_usd)).toBeCloseTo(expectedUsd, 4);
    expect(Number(container.rows[0].rate_per_kg_usd)).toBeCloseTo(expectedUsd / 1000, 6);

    const raw = await pool.query<{ cost_per_kg_usd: string }>(
      `SELECT cost_per_kg_usd FROM factory_raw_stock WHERE container_id = $1`,
      [containerId]
    );
    expect(Number(raw.rows[0].cost_per_kg_usd)).toBeCloseTo(expectedUsd / 1000, 6);

    const charge = await pool.query<{ currency_code: string; fx_rate_to_usd: string; fx_rate_confirmed: boolean }>(
      `SELECT currency_code, fx_rate_to_usd, fx_rate_confirmed
         FROM factory_offload_additional_charges
        WHERE container_id = $1 AND description = 'USD inspection'`,
      [containerId]
    );
    expect(charge.rowCount).toBe(1);
    expect(charge.rows[0].currency_code).toBe("USD");
    expect(Number(charge.rows[0].fx_rate_to_usd)).toBeCloseTo(1, 8);
    expect(charge.rows[0].fx_rate_confirmed).toBe(true);
  }, 120_000);
});

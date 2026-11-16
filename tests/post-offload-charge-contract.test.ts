import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "p1415chg";
let ctx: TestContext;
let agent: request.SuperAgentTest;
let supplierId: number;
let containerId: number;
let mixBatchId: number;

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

  const container = await pool.query<{ id: number }>(
    `INSERT INTO factory_containers
       (company_id, container_number, supplier_id, total_kg, rate_per_kg,
        currency_code, fx_rate_to_usd, fx_rate_confirmed, status,
        final_payable_amount, final_payable_amount_usd, duty_status, duty_amount)
     VALUES ($1, $2, $3, '100', '2', 'USD', '1', true, 'RECEIVED', '0', '0', 'NONE', '0')
     RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-CNT`, supplierId]
  );
  containerId = Number(container.rows[0].id);

  const batch = await pool.query<{ id: number }>(
    `INSERT INTO factory_mix_batches
       (company_id, batch_code, total_weight_kg, used_kg, cost_per_kg, total_cost, status)
     VALUES ($1, $2, '20', '0', '2', '40', 'ACTIVE')
     RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-MIX`]
  );
  mixBatchId = Number(batch.rows[0].id);

  const offload = await agent.post("/api/factory/raw-stock/offload").send({
    containerId: String(containerId),
    receivedKg: "100",
    costPerKg: "2",
    currencyCode: "USD",
    fxRateToUsd: "1",
    offloadDate: "2026-09-14",
    idempotencyKey: `${TEST_PREFIX}-offload`,
    mixBatchAllocations: [{ mixBatchId: String(mixBatchId), weightKg: "20" }],
  });
  expect(offload.status).toBe(200);
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
  await pool.query(`DELETE FROM factory_offload_additional_charges WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_raw_stock WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_container_commissions WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_containers WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_suppliers WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60_000);

describe("Phases 14-15 post-offload charge lifecycle", () => {
  it("adds a post-offload charge with balanced accounting and a cost-only cascade", async () => {
    const beforeRaw = await pool.query<{ received_kg: string; used_kg: string; cost_per_kg_usd: string }>(
      `SELECT received_kg, used_kg, cost_per_kg_usd
         FROM factory_raw_stock
        WHERE container_id = $1`,
      [containerId]
    );
    expect(beforeRaw.rowCount).toBe(1);
    expect(Number(beforeRaw.rows[0].received_kg)).toBeCloseTo(100, 3);
    expect(Number(beforeRaw.rows[0].cost_per_kg_usd)).toBeCloseTo(2, 6);

    const beforeSource = await pool.query<{ weight_kg: string; cost_per_kg: string; total_cost: string }>(
      `SELECT weight_kg, cost_per_kg, total_cost
         FROM factory_mix_batch_sources
        WHERE mix_batch_id = $1 AND container_id = $2`,
      [mixBatchId, containerId]
    );
    expect(beforeSource.rowCount).toBe(1);
    const sourceRateAtConsumption = Number(beforeSource.rows[0].cost_per_kg);

    const response = await agent.post(`/api/factory/containers/${containerId}/post-offload-charges`).send({
      txDate: "2026-09-15",
      charges: [
        {
          description: "Phase 14 post-offload handling",
          amount: "100",
          currencyCode: "USD",
          ledgerAccountId: String(ctx.cashAccountId),
        },
      ],
    });
    expect(response.status).toBe(200);
    expect(response.body.oldContainerCostPerKgUsd).toBeCloseTo(2, 6);
    expect(response.body.newContainerCostPerKgUsd).toBeCloseTo(3, 6);
    expect(response.body.rawStockRowsUpdated).toBe(1);
    expect(response.body.supplierLockedRateNew).toBeGreaterThan(response.body.supplierLockedRateOld);

    const afterRaw = await pool.query<{ received_kg: string; used_kg: string; cost_per_kg_usd: string }>(
      `SELECT received_kg, used_kg, cost_per_kg_usd
         FROM factory_raw_stock
        WHERE container_id = $1`,
      [containerId]
    );
    expect(Number(afterRaw.rows[0].received_kg)).toBeCloseTo(Number(beforeRaw.rows[0].received_kg), 3);
    expect(Number(afterRaw.rows[0].used_kg)).toBeCloseTo(Number(beforeRaw.rows[0].used_kg), 3);
    expect(Number(afterRaw.rows[0].cost_per_kg_usd)).toBeCloseTo(3, 6);

    const charge = await pool.query<{
      id: number;
      amount: string;
      currency_code: string;
      fx_rate_to_usd: string;
      daybook_entry_id: number | null;
      voucher_id: number | null;
      supplier_locked_rate_before: string | null;
      supplier_locked_rate_after: string | null;
    }>(
      `SELECT id, amount, currency_code, fx_rate_to_usd, daybook_entry_id, voucher_id,
              supplier_locked_rate_before, supplier_locked_rate_after
         FROM factory_offload_additional_charges
        WHERE company_id = $1 AND container_id = $2 AND description = $3`,
      [ctx.companyId, containerId, "Phase 14 post-offload handling"]
    );
    expect(charge.rowCount).toBe(1);
    expect(Number(charge.rows[0].amount)).toBeCloseTo(100, 2);
    expect(charge.rows[0].currency_code).toBe("USD");
    expect(Number(charge.rows[0].fx_rate_to_usd)).toBeCloseTo(1, 8);
    expect(charge.rows[0].daybook_entry_id).not.toBeNull();
    expect(charge.rows[0].voucher_id).not.toBeNull();
    expect(Number(charge.rows[0].supplier_locked_rate_after)).toBeGreaterThan(
      Number(charge.rows[0].supplier_locked_rate_before)
    );

    const voucherEntries = await pool.query<{ debit_amount: string; credit_amount: string }>(
      `SELECT debit_amount, credit_amount FROM voucher_entries WHERE voucher_id = $1`,
      [charge.rows[0].voucher_id]
    );
    expect(voucherEntries.rowCount).toBe(2);
    const debit = voucherEntries.rows.reduce((sum, row) => sum + Number(row.debit_amount || 0), 0);
    const credit = voucherEntries.rows.reduce((sum, row) => sum + Number(row.credit_amount || 0), 0);
    expect(debit).toBeCloseTo(100, 2);
    expect(credit).toBeCloseTo(100, 2);

    // Supplier-backed mix sources are cost snapshots at the consumption event.
    // A later landed-cost correction must not rewrite that historical source or
    // any quantity field, even though current raw stock and supplier value move.
    const afterSource = await pool.query<{ weight_kg: string; cost_per_kg: string }>(
      `SELECT weight_kg, cost_per_kg
         FROM factory_mix_batch_sources
        WHERE mix_batch_id = $1 AND container_id = $2`,
      [mixBatchId, containerId]
    );
    expect(Number(afterSource.rows[0].weight_kg)).toBeCloseTo(Number(beforeSource.rows[0].weight_kg), 3);
    expect(Number(afterSource.rows[0].cost_per_kg)).toBeCloseTo(sourceRateAtConsumption, 6);
  }, 120_000);
});

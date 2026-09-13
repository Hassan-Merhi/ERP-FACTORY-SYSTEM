/**
 * Concurrency coverage for POST /api/factory/containers/:id/reverse-offload.
 *
 * Reversing an offload is destructive accounting: it removes the raw stock the
 * offload created, unwinds the offload's vouchers and daybook rows, subtracts
 * this container's value out of the supplier's locked cost rate, and re-posts the
 * container's pre-offload freight voucher. Two reversals that both see the
 * container as OFFLOADED do all of it twice — most visibly as a supplier locked
 * rate corrected a second time against stock that is already gone, and a second
 * freight voucher for one container.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "revconc";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let supplierId: number;
let reversedContainerId: number;
let survivingContainerId: number;
// A second supplier and container so the durable-retry case can run a complete
// reversal of its own without disturbing the locked-rate arithmetic above.
let retrySupplierId: number;
let retryContainerId: number;

async function lockedRate(): Promise<number> {
  const { rows } = await pool.query<{ current_raw_material_cost_per_kg_usd: string | null }>(
    `SELECT current_raw_material_cost_per_kg_usd FROM factory_suppliers WHERE id = $1`,
    [supplierId]
  );
  return Number(rows[0]?.current_raw_material_cost_per_kg_usd ?? 0);
}

async function freightVouchers() {
  const { rows } = await pool.query<{ id: number; total_amount: string }>(
    `SELECT id, total_amount FROM vouchers
     WHERE company_id = $1 AND voucher_number = $2
     ORDER BY id`,
    [ctx.companyId, `FACTORY-FREIGHT-${reversedContainerId}`]
  );
  return rows;
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  // The route lives in the factory tree, which resolves its company from the
  // factory session scope.
  await pool.query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [ctx.companyId]);

  agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status} ${login.text}`);
  const selected = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  if (selected.status !== 200) throw new Error(`Company selection failed: ${selected.status} ${selected.text}`);

  // Stored locked rate of 3.00 over 200 kg of remaining stock is $600 of supplier
  // raw-material value. Reversing the 100 kg @ $2 container once leaves $400 over
  // 100 kg — a rate of 4.00. Correcting a second time against stock that is
  // already gone leaves 0 kg and a rate of 0, which is what this test pins.
  const supplier = await pool.query<{ id: number }>(
    `INSERT INTO factory_suppliers
       (company_id, name, opening_balance, is_active, current_raw_material_cost_per_kg_usd)
     VALUES ($1, $2, '0', true, '3.00000000')
     RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX} Supplier`]
  );
  supplierId = supplier.rows[0].id;

  const reversed = await pool.query<{ id: number }>(
    `INSERT INTO factory_containers
       (company_id, container_number, supplier_id, total_kg, actual_received_kg,
        currency_code, fx_rate_to_usd, fx_rate_confirmed, status, pre_offload_status,
        pre_offload_freight, pre_offload_freight_account_id, pre_offload_freight_currency_code,
        freight_own_account_id, pre_offload_other_charges, pre_offload_commission_amount)
     VALUES ($1, $2, $3, '100', '100', 'USD', '1', true, 'OFFLOADED', 'ARRIVED',
             '50', $4, 'USD', $5, '0', '0')
     RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-REVERSED`, supplierId, ctx.salesAccountId, ctx.cashAccountId]
  );
  reversedContainerId = reversed.rows[0].id;

  const surviving = await pool.query<{ id: number }>(
    `INSERT INTO factory_containers
       (company_id, container_number, supplier_id, total_kg, actual_received_kg,
        currency_code, fx_rate_to_usd, fx_rate_confirmed, status)
     VALUES ($1, $2, $3, '100', '100', 'USD', '1', true, 'OFFLOADED')
     RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-SURVIVING`, supplierId]
  );
  survivingContainerId = surviving.rows[0].id;

  await pool.query(
    `INSERT INTO factory_raw_stock
       (company_id, container_id, received_kg, used_kg, cost_per_kg, cost_per_kg_usd)
     VALUES ($1, $2, '100', '0', '2', '2'),
            ($1, $3, '100', '0', '4', '4')`,
    [ctx.companyId, reversedContainerId, survivingContainerId]
  );

  const retrySupplier = await pool.query<{ id: number }>(
    `INSERT INTO factory_suppliers
       (company_id, name, opening_balance, is_active, current_raw_material_cost_per_kg_usd)
     VALUES ($1, $2, '0', true, '5.00000000')
     RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX} Retry Supplier`]
  );
  retrySupplierId = retrySupplier.rows[0].id;

  const retryContainer = await pool.query<{ id: number }>(
    `INSERT INTO factory_containers
       (company_id, container_number, supplier_id, total_kg, actual_received_kg,
        currency_code, fx_rate_to_usd, fx_rate_confirmed, status, pre_offload_status,
        pre_offload_freight, pre_offload_freight_account_id, pre_offload_freight_currency_code,
        freight_own_account_id, pre_offload_other_charges, pre_offload_commission_amount)
     VALUES ($1, $2, $3, '50', '50', 'USD', '1', true, 'OFFLOADED', 'ARRIVED',
             '30', $4, 'USD', $5, '0', '0')
     RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-RETRY`, retrySupplierId, ctx.salesAccountId, ctx.cashAccountId]
  );
  retryContainerId = retryContainer.rows[0].id;

  await pool.query(
    `INSERT INTO factory_raw_stock
       (company_id, container_id, received_kg, used_kg, cost_per_kg, cost_per_kg_usd)
     VALUES ($1, $2, '50', '0', '5', '5')`,
    [ctx.companyId, retryContainerId]
  );
}, 120000);

afterAll(async () => {
  await pool.query(`DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`, [
    ctx.companyId,
  ]);
  await pool.query(`DELETE FROM vouchers WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_raw_stock WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_container_receipts WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_mix_batch_sources WHERE container_id = ANY($1::int[])`, [
    [reversedContainerId, survivingContainerId, retryContainerId],
  ]);
  await pool.query(`DELETE FROM factory_offload_additional_charges WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_container_commissions WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_daybook_entries WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_containers WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_suppliers WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM financial_operation_requests WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("factory container reverse-offload concurrency", () => {
  it("unwinds one offload once when two reversals race", async () => {
    const responses = await Promise.all([
      agent.post(`/api/factory/containers/${reversedContainerId}/reverse-offload`).send({}),
      agent.post(`/api/factory/containers/${reversedContainerId}/reverse-offload`).send({}),
    ]);

    const accepted = responses.filter((response) => response.status === 200);
    const rejected = responses.filter((response) => response.status === 400);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].body.message).toContain("Only OFFLOADED or PARTIALLY_RECEIVED containers can be reversed");

    // The reversed container's raw stock is gone; the others are untouched.
    const remaining = await pool.query<{ container_id: number }>(
      `SELECT container_id FROM factory_raw_stock WHERE company_id = $1 ORDER BY container_id`,
      [ctx.companyId]
    );
    const remainingIds = remaining.rows.map((row) => Number(row.container_id));
    expect(remainingIds).not.toContain(reversedContainerId);
    expect(remainingIds).toContain(survivingContainerId);

    // One correction to the supplier's locked rate: $400 over the 100 kg that is
    // still on hand. A second correction divides by 0 kg and zeroes the rate.
    expect(await lockedRate()).toBeCloseTo(4, 6);

    // The pre-offload freight voucher is restored exactly once, and it balances.
    const restored = await freightVouchers();
    expect(restored).toHaveLength(1);
    expect(Number(restored[0].total_amount)).toBeCloseTo(50, 2);

    const legs = await pool.query<{ debit: string; credit: string }>(
      `SELECT COALESCE(SUM(debit_amount::numeric), 0)::text AS debit,
              COALESCE(SUM(credit_amount::numeric), 0)::text AS credit
       FROM voucher_entries WHERE voucher_id = $1`,
      [restored[0].id]
    );
    expect(Number(legs.rows[0].debit)).toBeCloseTo(50, 2);
    expect(Number(legs.rows[0].credit)).toBeCloseTo(50, 2);

    const container = await pool.query<{ status: string; freight: string | null }>(
      `SELECT status, freight FROM factory_containers WHERE id = $1`,
      [reversedContainerId]
    );
    expect(container.rows[0].status).toBe("ARRIVED");
    expect(Number(container.rows[0].freight)).toBeCloseTo(50, 2);
  }, 60000);

  it("replays a retried reversal instead of unwinding it again", async () => {
    const clientRequestId = "revconc-retry-identity";
    const url = `/api/factory/containers/${retryContainerId}/reverse-offload`;

    const first = await agent.post(url).send({ clientRequestId });
    expect(first.status).toBe(200);

    // A client that never saw the response retransmits the same identity. The
    // stored outcome is returned instead of the reversal running again, so the
    // retry reports success rather than "already reversed".
    const retry = await agent.post(url).send({ clientRequestId });
    expect(retry.status).toBe(200);
    expect(retry.body.message).toBe(first.body.message);

    const restored = await pool.query<{ id: number }>(
      `SELECT id FROM vouchers WHERE company_id = $1 AND voucher_number = $2`,
      [ctx.companyId, `FACTORY-FREIGHT-${retryContainerId}`]
    );
    expect(restored.rows).toHaveLength(1);

    const remaining = await pool.query<{ container_id: number }>(
      `SELECT container_id FROM factory_raw_stock WHERE company_id = $1`,
      [ctx.companyId]
    );
    expect(remaining.rows.map((row) => Number(row.container_id))).not.toContain(retryContainerId);

    // The retry supplier's single container is gone, so its locked rate is reset
    // once; the first supplier's rate is untouched by this test.
    const retryRate = await pool.query<{ current_raw_material_cost_per_kg_usd: string | null }>(
      `SELECT current_raw_material_cost_per_kg_usd FROM factory_suppliers WHERE id = $1`,
      [retrySupplierId]
    );
    expect(Number(retryRate.rows[0].current_raw_material_cost_per_kg_usd)).toBeCloseTo(0, 6);
    expect(await lockedRate()).toBeCloseTo(4, 6);
  }, 60000);
});

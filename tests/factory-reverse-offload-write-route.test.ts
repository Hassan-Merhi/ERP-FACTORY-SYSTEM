/**
 * Behavioural coverage for POST /api/factory/containers/:id/reverse-offload.
 *
 * Reversal is a destructive accounting/stock operation: it removes the raw
 * stock created by the offload, removes offload-time vouchers, restores the
 * container's pre-offload state, and removes this container from the supplier's
 * locked-cost calculation. The guard sweep only proves authentication; these
 * assertions pin the actual unwind.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "revwr";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let supplierId: number;
let containerId: number;
let offloadVoucherId: number;

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  // This route is mounted inside the factory tree. Keep the fixture helper
  // generic and promote this one company explicitly instead of adding another
  // permanent prefix exception to tests/setup.ts.
  await pool.query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [ctx.companyId]);

  agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
  const selected = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  if (selected.status !== 200) throw new Error(`Company selection failed: ${selected.status}`);

  const supplier = await pool.query<{ id: number }>(
    `INSERT INTO factory_suppliers
       (company_id, name, opening_balance, is_active, current_raw_material_cost_per_kg_usd)
     VALUES ($1, $2, '0', true, '2.00000000')
     RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX} Supplier`]
  );
  supplierId = supplier.rows[0].id;

  const container = await pool.query<{ id: number }>(
    `INSERT INTO factory_containers
       (company_id, container_number, supplier_id, total_kg, actual_received_kg,
        currency_code, fx_rate_to_usd, status, pre_offload_status,
        pre_offload_freight, pre_offload_freight_currency_code,
        pre_offload_other_charges, pre_offload_commission_amount)
     VALUES ($1, $2, $3, '100', '100', 'USD', '1', 'OFFLOADED', 'ARRIVED',
             '0', 'USD', '0', '0')
     RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-CNT-1`, supplierId]
  );
  containerId = container.rows[0].id;

  await pool.query(
    `INSERT INTO factory_raw_stock
       (company_id, container_id, received_kg, used_kg, cost_per_kg, cost_per_kg_usd)
     VALUES ($1, $2, '100', '0', '2', '2')`,
    [ctx.companyId, containerId]
  );

  const voucher = await pool.query<{ id: number }>(
    `INSERT INTO vouchers
       (company_id, voucher_number, voucher_type, voucher_date, description,
        total_amount, currency, source_module, optional)
     VALUES ($1, $2, 'Journal', '2026-06-15', $3, '10', 'USD', 'FACTORY', false)
     RETURNING id`,
    [ctx.companyId, `FACTORY-FREIGHT-${containerId}-TEST`, `${TEST_PREFIX} offload freight`]
  );
  offloadVoucherId = voucher.rows[0].id;
  await pool.query(
    `INSERT INTO voucher_entries
       (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
     VALUES ($1, $2, '10', '0', $4),
            ($1, $3, '0', '10', $4)`,
    [offloadVoucherId, ctx.cashAccountId, ctx.salesAccountId, `${TEST_PREFIX} offload freight`]
  );
}, 120000);

afterAll(async () => {
  await pool.query(`DELETE FROM voucher_entries WHERE voucher_id = $1`, [offloadVoucherId]);
  await pool.query(`DELETE FROM vouchers WHERE id = $1`, [offloadVoucherId]);
  await pool.query(`DELETE FROM factory_raw_stock WHERE container_id = $1`, [containerId]);
  await pool.query(`DELETE FROM factory_container_receipts WHERE container_id = $1`, [containerId]);
  await pool.query(`DELETE FROM factory_mix_batch_sources WHERE container_id = $1`, [containerId]);
  await pool.query(`DELETE FROM factory_offload_additional_charges WHERE container_id = $1`, [containerId]);
  await pool.query(`DELETE FROM factory_container_commissions WHERE container_id = $1`, [containerId]);
  await pool.query(`DELETE FROM factory_containers WHERE id = $1`, [containerId]);
  await pool.query(`DELETE FROM factory_suppliers WHERE id = $1`, [supplierId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("POST /api/factory/containers/:id/reverse-offload", () => {
  it("unwinds raw stock and offload accounting, restores the snapshot, and refuses a repeat", async () => {
    const response = await agent.post(`/api/factory/containers/${containerId}/reverse-offload`).send({});
    expect(response.status).toBe(200);

    expect((await pool.query(`SELECT id FROM factory_raw_stock WHERE container_id = $1`, [containerId])).rowCount).toBe(
      0
    );

    const container = await pool.query<{
      status: string;
      actual_received_kg: string | null;
      declared_kg: string | null;
      freight: string;
      pre_offload_status: string | null;
      pre_offload_freight: string | null;
      final_payable_amount: string | null;
      rate_per_kg_usd: string | null;
    }>(
      `SELECT status, actual_received_kg, declared_kg, freight,
              pre_offload_status, pre_offload_freight,
              final_payable_amount, rate_per_kg_usd
       FROM factory_containers WHERE id = $1`,
      [containerId]
    );
    expect(container.rows[0].status).toBe("ARRIVED");
    expect(container.rows[0].actual_received_kg).toBeNull();
    expect(container.rows[0].declared_kg).toBeNull();
    expect(Number(container.rows[0].freight)).toBeCloseTo(0, 2);
    expect(container.rows[0].pre_offload_status).toBeNull();
    expect(container.rows[0].pre_offload_freight).toBeNull();
    expect(container.rows[0].final_payable_amount).toBeNull();
    expect(container.rows[0].rate_per_kg_usd).toBeNull();

    // This supplier had only this one raw-stock row. Removing the row means no
    // remaining raw-material value exists, so the authoritative locked rate is
    // reset to zero instead of leaving the deleted container's $2/kg behind.
    const supplier = await pool.query<{ current_raw_material_cost_per_kg_usd: string | null }>(
      `SELECT current_raw_material_cost_per_kg_usd FROM factory_suppliers WHERE id = $1`,
      [supplierId]
    );
    expect(Number(supplier.rows[0].current_raw_material_cost_per_kg_usd)).toBeCloseTo(0, 8);

    // Offload-time financials are part of the same unwind.
    expect(
      (await pool.query(`SELECT id FROM vouchers WHERE id = $1 AND deleted_at IS NULL`, [offloadVoucherId])).rowCount
    ).toBe(0);
    expect(
      (
        await pool.query(
          `SELECT ve.id FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id AND v.deleted_at IS NULL WHERE ve.voucher_id = $1`,
          [offloadVoucherId]
        )
      ).rowCount
    ).toBe(0);

    // The restored status closes the destructive path immediately. Keeping this
    // assertion in the same test makes it independent of test execution order.
    const repeated = await agent.post(`/api/factory/containers/${containerId}/reverse-offload`).send({});
    expect(repeated.status).toBe(400);
    expect(repeated.body.message).toContain("Only OFFLOADED or PARTIALLY_RECEIVED containers can be reversed");
  });
});

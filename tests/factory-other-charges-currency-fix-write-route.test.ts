/**
 * Behavioural coverage for POST /api/factory/admin/fix-other-charges-currency.
 *
 * The repair rewrites persisted charge currency and replaces accounting
 * vouchers. A successful response is not enough: the replacement must be USD
 * at a 1:1 rate and must preserve the two account legs and amount.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "ocfx";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let containerId: number;
let chargeAccountId: number;
let chargeId: number;
let oldVoucherId: number;

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  await pool.query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [ctx.companyId]);

  agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
  const selected = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  if (selected.status !== 200) throw new Error(`Company selection failed: ${selected.status}`);

  const account = await pool.query<{ id: number }>(
    `INSERT INTO ledger_accounts
       (company_id, code, name, account_type, opening_balance, opening_balance_side, active)
     VALUES ($1, $2, $3, 'Liability', '0', 'Cr', true)
     RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}_CHARGE`, `${TEST_PREFIX} Charge Counterparty`]
  );
  chargeAccountId = account.rows[0].id;

  const container = await pool.query<{ id: number }>(
    `INSERT INTO factory_containers
       (company_id, container_number, currency_code, fx_rate_to_usd,
        fx_rate_confirmed, status, other_charges, other_charges_currency_code, arrival_date)
     VALUES ($1, $2, 'EUR', '1.10', true, 'ARRIVED', '25', 'EUR', '2026-06-05')
     RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-CNT-1`]
  );
  containerId = container.rows[0].id;

  const charge = await pool.query<{ id: number }>(
    `INSERT INTO factory_container_other_charges
       (company_id, container_id, description, amount, currency_code,
        fx_rate_to_usd, fx_rate_confirmed, ledger_account_id)
     VALUES ($1, $2, $3, '25', 'EUR', '1.10', true, $4)
     RETURNING id`,
    [ctx.companyId, containerId, `${TEST_PREFIX} Handling`, chargeAccountId]
  );
  chargeId = charge.rows[0].id;

  const voucher = await pool.query<{ id: number }>(
    `INSERT INTO vouchers
       (company_id, voucher_number, voucher_type, voucher_date, description,
        total_amount, currency, exchange_rate, source_module, optional)
     VALUES ($1, $2, 'Journal', '2026-06-05', $3, '25', 'EUR', '1.10', 'FACTORY', false)
     RETURNING id`,
    [ctx.companyId, `FACTORY-OC-${containerId}-${chargeId}-OLD`, `${TEST_PREFIX} old charge voucher`]
  );
  oldVoucherId = voucher.rows[0].id;
  // The old voucher is legacy-shaped (native EUR in the USD columns), as history
  // left it: the currency trigger v2 (wave 17 D) refuses a new such line, so it is
  // written with the triggers off.
  const legacy = await pool.connect();
  try {
    await legacy.query("BEGIN");
    await legacy.query("SET LOCAL session_replication_role = replica");
    await legacy.query(
      `INSERT INTO voucher_entries
         (voucher_id, company_id, ledger_account_id, debit_amount, credit_amount, narration)
       VALUES ($1, $5, $2, '25', '0', $3),
              ($1, $5, $4, '0', '25', $3)`,
      [oldVoucherId, ctx.cashAccountId, `${TEST_PREFIX} old charge`, chargeAccountId, ctx.companyId]
    );
    await legacy.query("COMMIT");
  } catch (error) {
    await legacy.query("ROLLBACK");
    throw error;
  } finally {
    legacy.release();
  }
}, 120000);

afterAll(async () => {
  const voucherIds = await pool.query<{ id: number }>(
    `SELECT id FROM vouchers WHERE company_id = $1 AND voucher_number LIKE $2`,
    [ctx.companyId, `FACTORY-OC-${containerId}-%`]
  );
  for (const voucher of voucherIds.rows) {
    await pool.query(`DELETE FROM voucher_entries WHERE voucher_id = $1`, [voucher.id]);
  }
  await pool.query(`DELETE FROM vouchers WHERE company_id = $1 AND voucher_number LIKE $2`, [
    ctx.companyId,
    `FACTORY-OC-${containerId}-%`,
  ]);
  await pool.query(`DELETE FROM factory_container_other_charges WHERE container_id = $1`, [containerId]);
  await pool.query(`DELETE FROM factory_containers WHERE id = $1`, [containerId]);
  await pool.query(`DELETE FROM ledger_accounts WHERE id = $1`, [chargeAccountId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("POST /api/factory/admin/fix-other-charges-currency", () => {
  it("converts the persisted charge to USD and replaces its voucher at 1:1", async () => {
    const response = await agent.post("/api/factory/admin/fix-other-charges-currency").send({
      containerIds: [containerId],
    });
    expect(response.status).toBe(200);
    expect(response.body.fixed).toBe(1);

    const container = await pool.query<{ other_charges_currency_code: string | null }>(
      `SELECT other_charges_currency_code FROM factory_containers WHERE id = $1`,
      [containerId]
    );
    expect(container.rows[0].other_charges_currency_code).toBe("USD");

    const charge = await pool.query<{ currency_code: string | null; amount: string }>(
      `SELECT currency_code, amount FROM factory_container_other_charges WHERE id = $1`,
      [chargeId]
    );
    expect(charge.rows[0].currency_code).toBe("USD");
    expect(Number(charge.rows[0].amount)).toBeCloseTo(25, 2);

    // The old non-USD posting must not coexist with the replacement.
    expect(
      (await pool.query(`SELECT id FROM vouchers WHERE id = $1 AND deleted_at IS NULL`, [oldVoucherId])).rowCount
    ).toBe(0);
    expect(
      (
        await pool.query(
          `SELECT ve.id FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id AND v.deleted_at IS NULL WHERE ve.voucher_id = $1`,
          [oldVoucherId]
        )
      ).rowCount
    ).toBe(0);

    const replacement = await pool.query<{
      id: number;
      currency: string;
      exchange_rate: string | null;
      total_amount: string;
    }>(
      `SELECT id, currency, exchange_rate, total_amount
       FROM vouchers
       WHERE company_id = $1 AND voucher_number LIKE $2
       ORDER BY id DESC LIMIT 1`,
      [ctx.companyId, `FACTORY-OC-${containerId}-${chargeId}-%`]
    );
    expect(replacement.rowCount).toBe(1);
    expect(replacement.rows[0].currency).toBe("USD");
    expect(Number(replacement.rows[0].exchange_rate)).toBeCloseTo(1, 8);
    expect(Number(replacement.rows[0].total_amount)).toBeCloseTo(25, 2);

    const legs = await pool.query<{
      ledger_account_id: number | null;
      debit_amount: string;
      credit_amount: string;
    }>(
      `SELECT ledger_account_id, debit_amount, credit_amount
       FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
      [replacement.rows[0].id]
    );
    expect(legs.rows).toHaveLength(2);

    const payable = await pool.query<{ id: number }>(
      `SELECT id FROM ledger_accounts WHERE company_id = $1 AND code = 'FACTORY_CHARGES_PAYABLE' AND deleted_at IS NULL`,
      [ctx.companyId]
    );
    expect(payable.rowCount).toBe(1);
    expect(legs.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ledger_account_id: payable.rows[0].id,
          debit_amount: "25.00",
          credit_amount: "0.00",
        }),
        expect.objectContaining({
          ledger_account_id: chargeAccountId,
          debit_amount: "0.00",
          credit_amount: "25.00",
        }),
      ])
    );
  });

  it("rejects an empty repair request", async () => {
    const response = await agent.post("/api/factory/admin/fix-other-charges-currency").send({ containerIds: [] });
    expect(response.status).toBe(400);
  });
});

/**
 * Behavioural coverage for POST /api/factory/containers/:id/other-charges/sync.
 *
 * Sync is replacement semantics: the submitted charge set becomes the whole
 * persisted set and the matching FACTORY-OC vouchers are rebuilt. Tests pin
 * both the ledger direction and the no-duplicate invariant across an edit.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "ocsync";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let containerId: number;
let handlingAccountId: number;
let inspectionAccountId: number;

async function voucherRows() {
  return (
    await pool.query<{ id: number; total_amount: string; currency: string }>(
      `SELECT id, total_amount, currency
       FROM vouchers
       WHERE company_id = $1 AND voucher_number LIKE $2 AND deleted_at IS NULL
       ORDER BY id`,
      [ctx.companyId, `FACTORY-OC-${containerId}-%`]
    )
  ).rows;
}

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

  const accounts = await pool.query<{ id: number }>(
    `INSERT INTO ledger_accounts
       (company_id, code, name, account_type, opening_balance, opening_balance_side, active)
     VALUES
       ($1, $2, $3, 'Liability', '0', 'Cr', true),
       ($1, $4, $5, 'Liability', '0', 'Cr', true)
     RETURNING id`,
    [
      ctx.companyId,
      `${TEST_PREFIX}_HANDLING`,
      `${TEST_PREFIX} Handling Counterparty`,
      `${TEST_PREFIX}_INSPECTION`,
      `${TEST_PREFIX} Inspection Counterparty`,
    ]
  );
  handlingAccountId = accounts.rows[0].id;
  inspectionAccountId = accounts.rows[1].id;

  const container = await pool.query<{ id: number }>(
    `INSERT INTO factory_containers
       (company_id, container_number, currency_code, fx_rate_to_usd,
        fx_rate_confirmed, status, other_charges, arrival_date)
     VALUES ($1, $2, 'USD', '1', true, 'ARRIVED', '0', '2026-06-08')
     RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-CNT-1`]
  );
  containerId = container.rows[0].id;
}, 120000);

afterAll(async () => {
  const vouchers = await voucherRows();
  for (const voucher of vouchers) {
    await pool.query(`DELETE FROM voucher_entries WHERE voucher_id = $1`, [voucher.id]);
  }
  await pool.query(`DELETE FROM vouchers WHERE company_id = $1 AND voucher_number LIKE $2`, [
    ctx.companyId,
    `FACTORY-OC-${containerId}-%`,
  ]);
  await pool.query(`DELETE FROM factory_container_other_charges WHERE container_id = $1`, [containerId]);
  await pool.query(`DELETE FROM factory_containers WHERE id = $1`, [containerId]);
  await pool.query(`DELETE FROM ledger_accounts WHERE id = ANY($1::int[])`, [[handlingAccountId, inspectionAccountId]]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("POST /api/factory/containers/:id/other-charges/sync", () => {
  it("posts each charge once and replaces old rows/vouchers on edit", async () => {
    const created = await agent.post(`/api/factory/containers/${containerId}/other-charges/sync`).send({
      charges: [
        {
          description: "Handling",
          amount: "30.00",
          currencyCode: "USD",
          ledgerAccountId: handlingAccountId,
        },
        {
          description: "Inspection",
          amount: "20.00",
          currencyCode: "USD",
          ledgerAccountId: inspectionAccountId,
        },
      ],
    });
    expect(created.status).toBe(200);
    expect(created.body.total).toBe("50.00");

    const rows = await pool.query<{
      description: string;
      amount: string;
      currency_code: string;
      ledger_account_id: number;
    }>(
      `SELECT description, amount, currency_code, ledger_account_id
       FROM factory_container_other_charges
       WHERE company_id = $1 AND container_id = $2
       ORDER BY description`,
      [ctx.companyId, containerId]
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.map((r) => [r.description, Number(r.amount)])).toEqual([
      ["Handling", 30],
      ["Inspection", 20],
    ]);

    const container = await pool.query<{ other_charges: string }>(
      `SELECT other_charges FROM factory_containers WHERE id = $1`,
      [containerId]
    );
    expect(Number(container.rows[0].other_charges)).toBeCloseTo(50, 2);

    const firstVouchers = await voucherRows();
    expect(firstVouchers).toHaveLength(2);
    const firstVoucherIds = firstVouchers.map((v) => v.id);

    const payable = await pool.query<{ id: number }>(
      `SELECT id FROM ledger_accounts
       WHERE company_id = $1 AND code = 'FACTORY_CHARGES_PAYABLE' AND deleted_at IS NULL`,
      [ctx.companyId]
    );
    expect(payable.rowCount).toBe(1);

    for (const voucher of firstVouchers) {
      expect(voucher.currency).toBe("USD");
      const legs = await pool.query<{
        ledger_account_id: number | null;
        debit_amount: string;
        credit_amount: string;
      }>(
        `SELECT ledger_account_id, debit_amount, credit_amount
         FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
        [voucher.id]
      );
      expect(legs.rows).toHaveLength(2);
      const amount = Number(voucher.total_amount);
      const payableLeg = legs.rows.find((leg) => leg.ledger_account_id === payable.rows[0].id);
      expect(Number(payableLeg?.debit_amount)).toBeCloseTo(amount, 2);
      expect(Number(payableLeg?.credit_amount)).toBeCloseTo(0, 2);
    }

    const edited = await agent.post(`/api/factory/containers/${containerId}/other-charges/sync`).send({
      charges: [
        {
          description: "Handling revised",
          amount: "45.00",
          currencyCode: "USD",
          ledgerAccountId: handlingAccountId,
        },
      ],
    });
    expect(edited.status).toBe(200);
    expect(edited.body.total).toBe("45.00");

    const editedRows = await pool.query<{ description: string; amount: string }>(
      `SELECT description, amount FROM factory_container_other_charges
       WHERE company_id = $1 AND container_id = $2`,
      [ctx.companyId, containerId]
    );
    expect(editedRows.rows).toHaveLength(1);
    expect(editedRows.rows[0].description).toBe("Handling revised");
    expect(Number(editedRows.rows[0].amount)).toBeCloseTo(45, 2);

    const editedContainer = await pool.query<{ other_charges: string }>(
      `SELECT other_charges FROM factory_containers WHERE id = $1`,
      [containerId]
    );
    expect(Number(editedContainer.rows[0].other_charges)).toBeCloseTo(45, 2);

    // Replacement semantics: both old vouchers and their entries are gone,
    // leaving exactly one posting for the one remaining charge.
    for (const oldId of firstVoucherIds) {
      expect((await pool.query(`SELECT id FROM vouchers WHERE id = $1 AND deleted_at IS NULL`, [oldId])).rowCount).toBe(
        0
      );
      expect(
        (
          await pool.query(
            `SELECT ve.id FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id AND v.deleted_at IS NULL WHERE ve.voucher_id = $1`,
            [oldId]
          )
        ).rowCount
      ).toBe(0);
    }
    const replacementVouchers = await voucherRows();
    expect(replacementVouchers).toHaveLength(1);
    expect(Number(replacementVouchers[0].total_amount)).toBeCloseTo(45, 2);
  });
});

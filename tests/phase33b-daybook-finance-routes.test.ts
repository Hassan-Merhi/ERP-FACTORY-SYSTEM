import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "phase33bday";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let sequence = 0;

async function createVoucher(): Promise<number> {
  sequence += 1;
  const result = await pool.query<{ id: number }>(
    `INSERT INTO vouchers
       (company_id, voucher_number, voucher_type, voucher_date, description, total_amount, currency)
     VALUES ($1, $2, 'Payment', '2026-09-17', $3, '75.00', 'USD')
     RETURNING id`,
    [ctx.companyId, `P33B-DAYBOOK-${sequence}`, `${TEST_PREFIX} synthetic voucher ${sequence}`],
  );
  return result.rows[0].id;
}

async function createManualEntry(txType = "PAYMENT"): Promise<number> {
  sequence += 1;
  const result = await pool.query<{ id: number }>(
    `INSERT INTO factory_daybook_entries
       (company_id, tx_date, tx_type, reference_id, reference_table, description,
        currency_code, amount_currency, fx_rate_to_usd, amount_usd)
     VALUES ($1, '2026-09-17', $2, NULL, 'manual', $3, 'USD', '50.00', '1', '50.00')
     RETURNING id`,
    [ctx.companyId, txType, `${TEST_PREFIX} Phase 33B entry ${sequence}`],
  );
  return result.rows[0].id;
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

  const selected = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  expect(selected.status).toBe(200);
}, 120_000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  await closeTestServer();
}, 120_000);

describe("Phase 33B factory daybook accounting routes", () => {
  it("materializes a synthetic voucher row before applying an audited edit", async () => {
    const voucherId = await createVoucher();

    const response = await agent.put(`/api/factory/daybook/-${voucherId}`).send({
      reason: "Correct synthetic payment narration",
      description: "Phase 33B corrected synthetic payment",
      txDate: "2026-09-18",
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      companyId: ctx.companyId,
      referenceId: voucherId,
      referenceTable: "vouchers",
      description: "Phase 33B corrected synthetic payment",
      txDate: "2026-09-18",
    });

    const daybook = await pool.query<{
      id: number;
      reference_id: number | null;
      description: string;
      tx_date: string;
    }>(
      `SELECT id, reference_id, description, tx_date::text
         FROM factory_daybook_entries
        WHERE company_id = $1 AND reference_table = 'vouchers' AND reference_id = $2`,
      [ctx.companyId, voucherId],
    );
    expect(daybook.rowCount).toBe(1);
    expect(daybook.rows[0]).toMatchObject({
      reference_id: voucherId,
      description: "Phase 33B corrected synthetic payment",
      tx_date: "2026-09-18",
    });

    const voucher = await pool.query<{ description: string; voucher_date: string }>(
      `SELECT description, voucher_date::text FROM vouchers WHERE id = $1`,
      [voucherId],
    );
    expect(voucher.rows[0]).toEqual({
      description: "Phase 33B corrected synthetic payment",
      voucher_date: "2026-09-18",
    });
  });

  it("returns the persisted audit history for an edited daybook entry", async () => {
    const entryId = await createManualEntry();

    const edit = await agent.put(`/api/factory/daybook/${entryId}`).send({
      reason: "Fix amount narration",
      description: "Phase 33B audited edit",
      amountCurrency: "55.00",
      amountUsd: "55.00",
    });
    expect(edit.status).toBe(200);

    const history = await agent.get(`/api/factory/daybook/${entryId}/edits`);
    expect(history.status).toBe(200);
    expect(Array.isArray(history.body)).toBe(true);
    expect(history.body.length).toBeGreaterThan(0);
    expect(history.body[0]).toMatchObject({
      daybookEntryId: entryId,
      reason: "Fix amount narration",
    });
    expect(String(history.body[0].beforeJson)).toContain("50.00");
    expect(String(history.body[0].afterJson)).toContain("55.00");
  });

  it("rejects invalid cost edits before any container-cost cascade", async () => {
    const entryId = await createManualEntry("PAYMENT");

    const missingReason = await agent
      .patch(`/api/factory/daybook/${entryId}/cost-edit`)
      .send({ newAmount: "40.00" });
    expect(missingReason.status).toBe(400);

    const negativeAmount = await agent
      .patch(`/api/factory/daybook/${entryId}/cost-edit`)
      .send({ newAmount: "-1", reason: "invalid negative cost" });
    expect(negativeAmount.status).toBe(400);

    const wrongType = await agent
      .patch(`/api/factory/daybook/${entryId}/cost-edit`)
      .send({ newAmount: "40.00", reason: "not a container cost" });
    expect(wrongType.status).toBe(400);
    expect(String(wrongType.body.message)).toContain("not a cost entry");

    const row = await pool.query<{ amount_currency: string; amount_usd: string }>(
      `SELECT amount_currency, amount_usd FROM factory_daybook_entries WHERE id = $1`,
      [entryId],
    );
    expect(Number(row.rows[0].amount_currency)).toBe(50);
    expect(Number(row.rows[0].amount_usd)).toBe(50);
  });
});

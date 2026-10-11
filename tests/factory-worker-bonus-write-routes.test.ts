/**
 * Behavioural coverage for the worker bonus write routes.
 *
 * A bonus is recorded pending, paid later against a cash account, and the
 * payment posts Dr the individual worker's bonus expense / Cr cash. Deleting a
 * paid bonus reverses the posting by removing the voucher it created.
 *
 * What is pinned here:
 *
 *   - **The expense side is split by worker name, never location.** Every paid
 *     worker bonus posts to `Bonus Expense - <Worker Name>` under the shared
 *     `Bonus Expense - Workers` group, including workers with no city.
 *   - **Paying is idempotent by status.** `/pay` only matches a bonus that is
 *     still `pending`, so paying twice cannot post the expense twice.
 *   - **Deleting a paid bonus takes its voucher with it.** There is no
 *     `voucher_id` column — the voucher is found by the `WBONUS-<id>-` naming
 *     convention — so a delete that missed it would leave the expense and the
 *     cash credit standing against a bonus that no longer exists.
 *   - **Both cross-company doors are shut.** The bonus row's worker id is
 *     checked against the company, and `/pay` also validates the nominated
 *     cash account belongs to the same company.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "wbonus";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let cityWorkerId: number;
let cityLessWorkerId: number;
let reservedNameWorkerId: number;

interface BonusRow {
  id: number;
  status: string;
  amount: string;
  cash_account_id: number | null;
  paid_date: string | null;
}

async function bonusRow(id: number): Promise<BonusRow | null> {
  const result = await pool.query<BonusRow>(
    `SELECT id, status, amount, cash_account_id, paid_date::text AS paid_date FROM worker_bonuses WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

async function bonusLegs(bonusId: number) {
  const result = await pool.query<{ ledger_account_id: number; debit_amount: string; credit_amount: string }>(
    `SELECT ve.ledger_account_id, ve.debit_amount, ve.credit_amount
     FROM voucher_entries ve
     JOIN vouchers v ON v.id = ve.voucher_id
     WHERE v.company_id = $1 AND v.voucher_number LIKE $2 AND v.deleted_at IS NULL
     ORDER BY ve.id`,
    [ctx.companyId, `WBONUS-${bonusId}-%`]
  );
  return result.rows;
}

async function bonusVoucherCount(bonusId: number): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM vouchers WHERE company_id = $1 AND voucher_number LIKE $2 AND deleted_at IS NULL`,
    [ctx.companyId, `WBONUS-${bonusId}-%`]
  );
  return Number(result.rows[0].count);
}

async function accountNamed(
  name: string
): Promise<{ id: number; account_type: string; parent_id: number | null } | null> {
  const result = await pool.query<{ id: number; account_type: string; parent_id: number | null }>(
    `SELECT id, account_type, parent_id FROM ledger_accounts WHERE company_id = $1 AND name = $2`,
    [ctx.companyId, name]
  );
  return result.rows[0] ?? null;
}

async function createBonus(workerId: number, amount: string, notes?: string): Promise<number> {
  const response = await agent
    .post("/api/factory/worker-bonuses")
    .send({ workerId, bonusDate: "2026-05-12", amount, notes });
  if (response.status !== 201) throw new Error(`Seed bonus failed: ${response.status} ${response.text}`);
  return response.body.id;
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

  const withCity = await pool.query<{ id: number }>(
    `INSERT INTO factory_workers (company_id, full_name, city) VALUES ($1, $2, $3) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX} City Worker`, "tripoli"]
  );
  cityWorkerId = withCity.rows[0].id;

  const withoutCity = await pool.query<{ id: number }>(
    `INSERT INTO factory_workers (company_id, full_name) VALUES ($1, $2) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX} Cityless Worker`]
  );
  cityLessWorkerId = withoutCity.rows[0].id;

  const reservedName = await pool.query<{ id: number }>(
    `INSERT INTO factory_workers (company_id, full_name) VALUES ($1, $2) RETURNING id`,
    [ctx.companyId, "Workers"]
  );
  reservedNameWorkerId = reservedName.rows[0].id;
}, 120000);

beforeEach(async () => {
  await pool.query(
    `DELETE FROM voucher_entries WHERE voucher_id IN
       (SELECT id FROM vouchers WHERE company_id = $1 AND voucher_number LIKE 'WBONUS-%')`,
    [ctx.companyId]
  );
  await pool.query(`DELETE FROM vouchers WHERE company_id = $1 AND voucher_number LIKE 'WBONUS-%'`, [ctx.companyId]);
  await pool.query(`DELETE FROM worker_bonuses WHERE company_id = $1`, [ctx.companyId]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM worker_bonuses WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_workers WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("POST /api/factory/worker-bonuses", () => {
  it("records the bonus pending, with nothing in the ledger yet", async () => {
    const bonusId = await createBonus(cityWorkerId, "150.00", `${TEST_PREFIX} eid`);

    const row = await bonusRow(bonusId);
    expect(row?.status).toBe("pending");
    expect(Number(row?.amount)).toBeCloseTo(150, 2);
    expect(row?.cash_account_id).toBeNull();
    // Recording a bonus is a promise, not a payment. Nothing may post until
    // someone nominates the cash it comes out of.
    expect(await bonusVoucherCount(bonusId)).toBe(0);
  });

  it("rejects a missing field or a non-positive amount", async () => {
    const bodies = [
      { bonusDate: "2026-05-12", amount: "10" },
      { workerId: cityWorkerId, amount: "10" },
      { workerId: cityWorkerId, bonusDate: "2026-05-12" },
      { workerId: cityWorkerId, bonusDate: "2026-05-12", amount: "0" },
      { workerId: cityWorkerId, bonusDate: "2026-05-12", amount: "-4" },
    ];
    for (const body of bodies) {
      expect((await agent.post("/api/factory/worker-bonuses").send(body)).status).toBe(400);
    }
  });

  it("refuses a worker from another company", async () => {
    const foreign = await pool.query<{ id: number }>(
      `SELECT id FROM factory_workers WHERE company_id <> $1 ORDER BY id LIMIT 1`,
      [ctx.companyId]
    );
    if (foreign.rowCount === 0) return;

    const response = await agent
      .post("/api/factory/worker-bonuses")
      .send({ workerId: foreign.rows[0].id, bonusDate: "2026-05-12", amount: "10" });

    expect(response.status).toBe(404);
  });
});

describe("POST /api/factory/worker-bonuses/:id/pay", () => {
  it("posts Dr Bonus Expense - <Worker Name> / Cr cash and groups the worker account", async () => {
    const bonusId = await createBonus(cityWorkerId, "90.00", `${TEST_PREFIX} payout`);

    const response = await agent
      .post(`/api/factory/worker-bonuses/${bonusId}/pay`)
      .send({ cashAccountId: ctx.cashAccountId, paidDate: "2026-05-20" });
    expect(response.status).toBe(200);

    const row = await bonusRow(bonusId);
    expect(row?.status).toBe("paid");
    expect(row?.cash_account_id).toBe(ctx.cashAccountId);
    expect(row?.paid_date).toBe("2026-05-20");

    const group = await accountNamed("Bonus Expense - Workers");
    const expenseAccount = await accountNamed(`Bonus Expense - ${TEST_PREFIX} City Worker`);
    expect(group).not.toBeNull();
    expect(expenseAccount).not.toBeNull();
    expect(expenseAccount?.account_type).toBe("Expense");
    expect(expenseAccount?.parent_id).toBe(group?.id);
    expect(await accountNamed("Bonus Expense - Tripoli")).toBeNull();

    const legs = await bonusLegs(bonusId);
    expect(legs).toHaveLength(2);
    const expenseLeg = legs.find((leg) => leg.ledger_account_id === expenseAccount?.id);
    const cashLeg = legs.find((leg) => leg.ledger_account_id === ctx.cashAccountId);
    expect(Number(expenseLeg?.debit_amount)).toBeCloseTo(90, 2);
    expect(Number(cashLeg?.credit_amount)).toBeCloseTo(90, 2);
  });

  it("uses the worker name even when the worker has no city", async () => {
    const bonusId = await createBonus(cityLessWorkerId, "40.00");

    const response = await agent
      .post(`/api/factory/worker-bonuses/${bonusId}/pay`)
      .send({ cashAccountId: ctx.cashAccountId });
    expect(response.status).toBe(200);

    const expenseAccount = await accountNamed(`Bonus Expense - ${TEST_PREFIX} Cityless Worker`);
    const legs = await bonusLegs(bonusId);
    expect(expenseAccount).not.toBeNull();
    expect(legs.find((leg) => leg.ledger_account_id === expenseAccount?.id)).toBeTruthy();
  });

  it("does not self-parent the group when a worker is literally named Workers", async () => {
    const bonusId = await createBonus(reservedNameWorkerId, "45.00");

    const response = await agent
      .post(`/api/factory/worker-bonuses/${bonusId}/pay`)
      .send({ cashAccountId: ctx.cashAccountId });
    expect(response.status).toBe(200);

    const group = await accountNamed("Bonus Expense - Workers");
    const detail = await accountNamed("Bonus Expense - Workers (Detail)");
    expect(group).not.toBeNull();
    expect(detail).not.toBeNull();
    expect(detail?.id).not.toBe(group?.id);
    expect(detail?.parent_id).toBe(group?.id);

    const legs = await bonusLegs(bonusId);
    expect(legs.find((leg) => leg.ledger_account_id === detail?.id)).toBeTruthy();
  });

  it("will not pay the same bonus twice", async () => {
    const bonusId = await createBonus(cityWorkerId, "25.00");
    await agent.post(`/api/factory/worker-bonuses/${bonusId}/pay`).send({ cashAccountId: ctx.cashAccountId });

    const second = await agent
      .post(`/api/factory/worker-bonuses/${bonusId}/pay`)
      .send({ cashAccountId: ctx.cashAccountId });

    // Matching only on `pending` is what stops a double-click posting the
    // expense twice against one bonus.
    expect(second.status).toBe(404);
    expect(await bonusVoucherCount(bonusId)).toBe(1);
  });

  it("requires a cash account, and one belonging to this company", async () => {
    const bonusId = await createBonus(cityWorkerId, "30.00");

    expect((await agent.post(`/api/factory/worker-bonuses/${bonusId}/pay`).send({})).status).toBe(400);

    const foreign = await pool.query<{ id: number }>(
      `SELECT id FROM ledger_accounts WHERE company_id <> $1 ORDER BY id LIMIT 1`,
      [ctx.companyId]
    );
    if (foreign.rowCount && foreign.rowCount > 0) {
      const response = await agent
        .post(`/api/factory/worker-bonuses/${bonusId}/pay`)
        .send({ cashAccountId: foreign.rows[0].id });
      expect(response.status).toBe(400);
    }

    expect((await bonusRow(bonusId))?.status).toBe("pending");
    expect(await bonusVoucherCount(bonusId)).toBe(0);
  });

  it("returns 404 for an unknown bonus", async () => {
    const response = await agent
      .post("/api/factory/worker-bonuses/99999999/pay")
      .send({ cashAccountId: ctx.cashAccountId });
    expect(response.status).toBe(404);
  });
});

describe("DELETE /api/factory/worker-bonuses/:id", () => {
  it("removes a pending bonus", async () => {
    const bonusId = await createBonus(cityWorkerId, "20.00");

    const response = await agent.delete(`/api/factory/worker-bonuses/${bonusId}`);
    expect(response.status).toBe(200);
    expect(await bonusRow(bonusId)).toBeNull();
  });

  it("reverses a paid bonus by removing its voucher and both legs", async () => {
    const bonusId = await createBonus(cityWorkerId, "60.00");
    await agent.post(`/api/factory/worker-bonuses/${bonusId}/pay`).send({ cashAccountId: ctx.cashAccountId });
    expect(await bonusLegs(bonusId)).toHaveLength(2);

    const response = await agent.delete(`/api/factory/worker-bonuses/${bonusId}`);
    expect(response.status).toBe(200);

    // The voucher is found by naming convention, not an FK. Missing it would
    // leave the expense and the cash credit standing against a bonus that no
    // longer exists.
    expect(await bonusRow(bonusId)).toBeNull();
    expect(await bonusVoucherCount(bonusId)).toBe(0);
    expect(await bonusLegs(bonusId)).toHaveLength(0);
  });

  it("returns 404 for an unknown bonus", async () => {
    expect((await agent.delete("/api/factory/worker-bonuses/99999999")).status).toBe(404);
  });
});

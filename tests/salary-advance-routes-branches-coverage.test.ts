/**
 * Salary advance routes (server/routes/employees/salaryAdvanceRoutes.ts) over
 * HTTP in one rolled-back company per test: reads, every create refusal
 * (body, unknown and another company's employee, missing cash account) and the
 * idempotent replay, worker reassignment refusals (role, ids, foreign or
 * non-worker target, repaid, closed period, optional or mismatched voucher)
 * and its voucher rename, deduction refusals and payoff, deletes across
 * companies, and the reconciliation of manual and payroll deductions.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { closeBooks, ledger } from "./helpers/dispatchFlowFixture";

const BASE = "/api/salary-advances";
let seq = 0;

async function world(w: FactoryWorld) {
  const employee = (companyId: number, first: string, type = "Worker") =>
    w.one(
      `INSERT INTO employees (company_id, code, first_name, last_name, employee_type, join_date)
       VALUES ($1, $2, $3, 'Worker', $4, '2025-01-01') RETURNING id`,
      [companyId, `${w.tag}E${++seq}`, first, type]
    );
  const advance = (
    employeeId: number,
    amount: string,
    remaining = amount,
    date = "2026-10-20",
    companyId = w.companyId
  ) =>
    w.one(
      `INSERT INTO salary_advances (company_id, employee_id, advance_date, amount, remaining_balance, is_opening_balance)
       VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id`,
      [companyId, employeeId, date, amount, remaining]
    );
  const other = await w.one(
    `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
    [`${w.tag}O`]
  );
  const from = await employee(w.companyId, "Original");
  const to = await employee(w.companyId, "Correct");
  const cash = await ledger(w, "CASH", "Cash");
  return { employee, advance, other, from, to, cash };
}

const balanceOf = async (w: FactoryWorld, id: number) =>
  (await w.q(`SELECT remaining_balance, fully_paid FROM salary_advances WHERE id = $1`, [id]))[0];

describe("salary advance create, read and delete", () => {
  it("refuses invalid bodies, unknown and foreign employees and a missing cash account, then creates and replays", () =>
    withFactoryWorld(async (w) => {
      const s = await world(w);
      const foreign = await s.employee(s.other, "Foreign");
      const body = {
        employeeId: s.from,
        advanceDate: "2026-10-29",
        amount: "60.00",
        notes: "",
        isOpeningBalance: false,
      };
      expect((await w.agent.post(BASE).send({ ...body, amount: undefined })).status).toBe(400);
      expect((await w.agent.post(BASE).send({ ...body, employeeId: 999999999 })).status).toBe(404);
      expect((await w.agent.post(BASE).send({ ...body, employeeId: foreign })).status).toBe(403);
      const noCash = await w.agent.post(BASE).send(body);
      expect(noCash.status).toBe(400);
      expect(noCash.body.message).toMatch(/Cash account is required/);

      const opening = await w.agent.post(BASE).send({ ...body, isOpeningBalance: true });
      expect(opening.status).toBe(201);
      expect(opening.body.voucherId).toBeNull();
      const request = { ...body, cashAccountId: s.cash, clientRequestId: `${w.tag}-adv-1` };
      const posted = await w.agent.post(BASE).send(request);
      expect(posted.status).toBe(201);
      expect(posted.body.voucherId).toBeTruthy();
      const replay = await w.agent.post(BASE).send(request);
      expect(replay.status).toBe(201);
      expect(replay.body.id).toBe(posted.body.id);

      const list = await w.agent.get(BASE);
      expect(list.body.map((a: { id: number }) => a.id).sort()).toEqual([opening.body.id, posted.body.id].sort());
      expect((await w.agent.get(`${BASE}/employee/abc`)).status).toBe(400);
      expect((await w.agent.get(`${BASE}/employee/${s.from}`)).body).toHaveLength(2);
      expect((await w.agent.get(`${BASE}/employee/${foreign}`)).body).toEqual([]);
    }));

  it("deletes only the active company's advances", () =>
    withFactoryWorld(async (w) => {
      const s = await world(w);
      const foreignAdvance = await s.advance(await s.employee(s.other, "Foreign"), "10", "10", "2026-10-20", s.other);
      const own = await s.advance(s.from, "10");
      expect((await w.agent.delete(`${BASE}/abc`)).status).toBe(400);
      expect((await w.agent.delete(`${BASE}/999999999`)).status).toBe(404);
      expect((await w.agent.delete(`${BASE}/${foreignAdvance}`)).status).toBe(403);
      expect(await balanceOf(w, foreignAdvance)).toBeTruthy();
      expect((await w.agent.delete(`${BASE}/${own}`)).status).toBe(200);
      expect(await balanceOf(w, own)).toBeUndefined();
    }));
});

describe("salary advance deductions and reconciliation", () => {
  it("refuses invalid, missing, paid and excessive deductions and pays off at cents", () =>
    withFactoryWorld(async (w) => {
      const s = await world(w);
      const id = await s.advance(s.from, "30.00");
      const paid = await s.advance(s.from, "5.00", "0");
      await w.q(`UPDATE salary_advances SET fully_paid = TRUE WHERE id = $1`, [paid]);
      const deduct = (target: number | string, body: Record<string, unknown>) =>
        w.agent.post(`${BASE}/${target}/deduction`).send(body);
      expect((await deduct("abc", {})).status).toBe(400);
      expect((await deduct(id, { payrollMonth: "2026-10" })).status).toBe(400);
      expect((await deduct(999999999, { payrollMonth: "2026-10", deductionAmount: "1" })).status).toBe(404);
      expect((await deduct(paid, { payrollMonth: "2026-10", deductionAmount: "1" })).body.message).toMatch(
        /fully paid/
      );
      expect((await deduct(id, { payrollMonth: "2026-10", deductionAmount: "31" })).body.message).toMatch(
        /cannot exceed/
      );
      const part = await deduct(id, { payrollMonth: "2026-10", deductionAmount: "10" });
      expect(part.body).toMatchObject({ newRemainingBalance: "20.00", fullyPaid: false });
      const rest = await deduct(id, { payrollMonth: "2026-11", deductionAmount: "20" });
      expect(rest.body).toMatchObject({ newRemainingBalance: "0.00", fullyPaid: true });
      const rows = await w.agent.get("/api/salary-advance-deductions");
      expect(rows.body).toHaveLength(2);
      expect(rows.body[0]).toMatchObject({ salaryAdvanceId: id, workerName: "Original Worker" });
    }));

  it("reconciles manual and paid-payroll deductions oldest first and corrects drift", () =>
    withFactoryWorld(async (w) => {
      const s = await world(w);
      const empty = await w.agent.post(`${BASE}/reconcile`);
      expect(empty.body).toEqual({ message: "Reconciliation complete. 0 advance(s) corrected.", fixed: 0 });
      const first = await s.advance(s.from, "50", "50", "2026-01-01");
      const second = await s.advance(s.from, "40", "40", "2026-02-01");
      const untouched = await s.advance(s.to, "25", "25");
      const drift = await s.advance(s.to, "10", "9.99", "2026-03-01");
      await w.q(
        `INSERT INTO salary_advance_deductions (salary_advance_id, payroll_month, deduction_amount) VALUES ($1, '2026-01', 20)`,
        [first]
      );
      const run = (status: string) =>
        w.one(
          `INSERT INTO erp_payroll_runs (company_id, date, created_at, status) VALUES ($1, '2026-03-31', '2026-03-31', $2) RETURNING id`,
          [w.companyId, status]
        );
      const item = (runId: number, employeeId: number, deduction: string) =>
        w.q(
          `INSERT INTO erp_payroll_run_items (run_id, employee_id, employee_name, base_salary, net_pay, deduction)
           VALUES ($1, $2, 'W', 100, 100, $3)`,
          [runId, employeeId, deduction]
        );
      const paidRun = await run("PAID");
      await item(paidRun, s.from, "45");
      await item(paidRun, s.to, "0");
      await item(await run("DRAFT"), s.from, "500");

      const res = await w.agent.post(`${BASE}/reconcile`);
      expect(res.status).toBe(200);
      // first: 50 - 20 manual - 30 payroll = 0; second: 40 - 15 payroll = 25; drift 9.99 -> 10.
      expect(res.body.fixed).toBe(3);
      expect(await balanceOf(w, first)).toEqual({ remaining_balance: "0.00", fully_paid: true });
      expect(await balanceOf(w, second)).toEqual({ remaining_balance: "25.00", fully_paid: false });
      expect(await balanceOf(w, untouched)).toEqual({ remaining_balance: "25.00", fully_paid: false });
      expect(await balanceOf(w, drift)).toEqual({ remaining_balance: "10.00", fully_paid: false });
      expect((await w.agent.post(`${BASE}/reconcile`)).body.fixed).toBe(0);
    }));
});

describe("salary advance worker reassignment", () => {
  it("refuses roles, malformed ids, missing advances, foreign or non-worker targets and repaid advances", () =>
    withFactoryWorld(async (w) => {
      const s = await world(w);
      const id = await s.advance(s.from, "15.00");
      const move = (target: number | string, body: unknown, agent = w.agent) =>
        agent.patch(`${BASE}/${target}/worker`).send(body as object);
      const manager = await w.agentFor("Manager");
      expect((await move(id, { employeeId: s.to }, manager)).status).toBe(403);
      expect((await move("abc", { employeeId: s.to })).body.message).toMatch(/Invalid salary advance ID/);
      expect((await move(id, { employeeId: "1" })).body.message).toMatch(/Select a valid worker/);
      expect((await move(999999999, { employeeId: s.to })).status).toBe(404);
      const foreign = await s.employee(s.other, "Foreign");
      const staff = await s.employee(w.companyId, "Clerk", "Staff");
      for (const employeeId of [foreign, staff]) {
        const res = await move(id, { employeeId });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/Worker not found/);
      }
      const same = await move(id, { employeeId: s.from });
      expect(same.status).toBe(200);
      expect(Number(same.body.employeeId)).toBe(s.from);

      const partly = await s.advance(s.from, "20.00", "15.00");
      expect((await move(partly, { employeeId: s.to })).status).toBe(409);
      await closeBooks(w, "2026-10-31");
      const closed = await move(id, { employeeId: s.to });
      expect(closed.status).toBe(409);
      expect(closed.body.message).toMatch(/closed accounting period/);
      const [row] = await w.q(`SELECT employee_id FROM salary_advances WHERE id = $1`, [id]);
      expect(Number(row.employee_id)).toBe(s.from);
    }));

  it("moves a posted advance with its voucher, and refuses optional or mismatched vouchers", () =>
    withFactoryWorld(async (w) => {
      const s = await world(w);
      const post = async (amount: string) => {
        const res = await w.agent.post(BASE).send({
          employeeId: s.from,
          advanceDate: "2026-10-29",
          amount,
          cashAccountId: s.cash,
          isOpeningBalance: false,
        });
        expect(res.status).toBe(201);
        return { id: res.body.id as number, voucherId: res.body.voucherId as number };
      };
      const moved = await post("60.00");
      const res = await w.agent.patch(`${BASE}/${moved.id}/worker`).send({ employeeId: s.to });
      expect(res.status).toBe(200);
      const [voucher] = await w.q(`SELECT description FROM vouchers WHERE id = $1`, [moved.voucherId]);
      expect(voucher.description).toBe("Salary advance for Correct Worker");

      const optional = await post("30.00");
      await w.q(`UPDATE vouchers SET optional = TRUE WHERE id = $1`, [optional.voucherId]);
      const opt = await w.agent.patch(`${BASE}/${optional.id}/worker`).send({ employeeId: s.to });
      expect(opt.status).toBe(409);

      const mismatch = await post("20.00");
      await w.q(`UPDATE salary_advances SET amount = 21, remaining_balance = 21 WHERE id = $1`, [mismatch.id]);
      const bad = await w.agent.patch(`${BASE}/${mismatch.id}/worker`).send({ employeeId: s.to });
      expect(bad.status).toBe(409);
      expect(bad.body.message).toMatch(/does not match/);
    }));
});

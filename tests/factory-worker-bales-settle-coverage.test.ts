/**
 * Factory worker bales list and settle-and-end through the real app in one
 * rolled-back transaction: date filters and another company's id in the query
 * or body, unknown and ended workers, ending without settlement, a join date
 * after the window, every pay basis (hourly, weekly, bi-weekly, daily, per
 * bale, per kg, monthly with and without attendance), prior payrolls and
 * outstanding advances, and the paid / approved settlement records.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const settle = (w: FactoryWorld, id: number | string, body: Record<string, unknown>) =>
  w.agent.post(`/api/factory/workers/${id}/settle-and-end`).send(body);

async function worker(w: FactoryWorld, fields: Record<string, string | null> = {}, companyId = w.companyId) {
  return w.one(
    `INSERT INTO factory_workers (company_id, full_name, active, base_salary, pay_frequency, salary_type, hourly_rate,
       weekly_salary, bi_weekly_salary, per_bale_rate, per_kg_rate, contract_start_date)
     VALUES ($1, 'Worker', TRUE, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      companyId,
      fields.base ?? "300",
      fields.freq ?? "Monthly",
      fields.type ?? "Monthly",
      fields.hourly ?? "0",
      fields.weekly ?? "0",
      fields.biweekly ?? "0",
      fields.bale ?? "0",
      fields.kg ?? "0",
      fields.start ?? null,
    ]
  );
}

async function bale(w: FactoryWorld, workerId: number, at: string, kg = "20", companyId = w.companyId) {
  return w.one(
    `INSERT INTO factory_bales (company_id, bale_code, reference_number, weight_kg, status, finalized_by, finalized_at)
     VALUES ($1, $2, $2, $3, 'IN_STOCK', $4, $5) RETURNING id`,
    [companyId, `${w.tag}-B${Math.random().toString(36).slice(2, 9)}`, kg, workerId, at]
  );
}

const window = { startDate: "2026-06-01", endDate: "2026-06-14" };

describe("worker bales", () => {
  it("lists a worker's finalized bales within dates and scopes by company", () =>
    withFactoryWorld(async (w) => {
      const id = await worker(w);
      await bale(w, id, "2026-06-02T10:00:00Z");
      await bale(w, id, "2026-07-02T10:00:00Z");
      expect((await w.agent.get(`/api/factory/workers/abc/bales`)).status).toBe(400);
      const all = await w.agent.get(`/api/factory/workers/${id}/bales`);
      expect(all.body).toHaveLength(2);
      const june = await w.agent.get(`/api/factory/workers/${id}/bales?startDate=2026-06-01&endDate=2026-06-30`);
      expect(june.body).toHaveLength(1);

      const other = await w.one(
        `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
        [`${w.tag}O`]
      );
      const stranger = await worker(w, {}, other);
      await bale(w, stranger, "2026-06-03T10:00:00Z", "20", other);
      const cross = await w.agent.get(`/api/factory/workers/${stranger}/bales?companyId=${other}`);
      expect(cross.status).toBe(403);
      expect((await w.agent.get(`/api/factory/workers/${stranger}/bales`)).body).toEqual([]);
    }));
});

describe("settle and end a worker contract", () => {
  it("refuses bad ids, other companies, ended workers and missing dates", () =>
    withFactoryWorld(async (w) => {
      expect((await settle(w, "abc", window)).status).toBe(400);
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
        [`${w.tag}P`]
      );
      const stranger = await worker(w, {}, other);
      expect((await settle(w, stranger, window)).status).toBe(404);
      expect((await settle(w, stranger, { ...window, companyId: other })).status).toBe(403);
      const id = await worker(w);
      expect((await settle(w, id, {})).body.message).toBe("startDate and endDate required");
      await w.q(`UPDATE factory_workers SET active = FALSE WHERE id = $1`, [id]);
      expect((await settle(w, id, window)).body.message).toBe("Worker contract already ended");
      const [row] = await w.q(`SELECT active FROM factory_workers WHERE id = $1`, [stranger]);
      expect(row.active).toBe(true);
    }));

  it("ends without settlement, and previews zero when the worker joined after the window", () =>
    withFactoryWorld(async (w) => {
      const late = await worker(w, { start: "2026-07-01" });
      const preview = await settle(w, late, { ...window, dryRun: true });
      expect(preview.body).toEqual({
        earned: "0.00",
        paid: "0.00",
        advances: "0.00",
        balance: "0.00",
        effectiveStart: "2026-07-01",
        dryRun: true,
      });
      const skipped = await settle(w, late, { skipSettlement: true, endDate: "2026-06-30" });
      expect(skipped.body).toEqual({ skipped: true, workerUpdated: true });
      const [row] = await w.q(`SELECT active, contract_end_date::text AS e FROM factory_workers WHERE id = $1`, [late]);
      expect(row).toEqual({ active: false, e: "2026-06-30" });
    }));

  it("computes earnings for each pay basis", () =>
    withFactoryWorld(async (w) => {
      const earned = async (fields: Record<string, string>, extra: Record<string, unknown> = {}) => {
        const id = await worker(w, fields);
        const res = await settle(w, id, { ...window, dryRun: true, ...extra });
        expect(res.status).toBe(200);
        return { id, earned: res.body.earned as string };
      };
      expect((await earned({ freq: "Hourly", hourly: "5" }, { hoursWorked: "10" })).earned).toBe("50.00");
      expect((await earned({ freq: "Hourly", hourly: "5" })).earned).toBe("0.00");
      expect((await earned({ freq: "Weekly", weekly: "70" })).earned).toBe("140.00");
      expect((await earned({ freq: "Bi-Weekly", biweekly: "140" })).earned).toBe("140.00");
      // 2026-06-01..14 holds ten weekdays.
      expect((await earned({ freq: "Daily", type: "Daily", base: "10" })).earned).toBe("100.00");

      const perBale = await worker(w, { type: "Per Bale", bale: "2" });
      await bale(w, perBale, "2026-06-03T10:00:00Z");
      await bale(w, perBale, "2026-06-04T10:00:00Z");
      expect((await settle(w, perBale, { ...window, dryRun: true })).body.earned).toBe("4.00");
      const perKg = await worker(w, { type: "Per KG", kg: "0.5" });
      await bale(w, perKg, "2026-06-03T10:00:00Z", "30");
      expect((await settle(w, perKg, { ...window, dryRun: true })).body.earned).toBe("15.00");

      const monthly = await worker(w, { base: "300" });
      const prorated = (await settle(w, monthly, { ...window, dryRun: true })).body.earned;
      await w.q(
        `INSERT INTO factory_attendance (company_id, worker_id, attendance_date, status) VALUES ($1, $2, '2026-06-02', 'Present')`,
        [w.companyId, monthly]
      );
      const attended = (await settle(w, monthly, { ...window, dryRun: true })).body.earned;
      expect(Number(prorated)).toBeGreaterThan(Number(attended));
      expect(Number(attended)).toBeGreaterThan(0);
    }));

  it("settles against prior payrolls and advances, recovering the advances", () =>
    withFactoryWorld(async (w) => {
      const id = await worker(w, { freq: "Weekly", weekly: "70" });
      await w.q(
        `INSERT INTO factory_payrolls (company_id, worker_id, period_start, period_end, net_salary, advances, deductions, status)
         VALUES ($1, $2, '2026-06-01', '2026-06-07', 40, 10, 5, 'PAID'), ($1, $2, '2026-06-01', '2026-06-07', 999, 0, 0, 'DRAFT')`,
        [w.companyId, id]
      );
      await w.q(
        `INSERT INTO factory_worker_advances (company_id, worker_id, amount, remaining_balance, advance_date)
         VALUES ($1, $2, 30, 25, '2026-05-01')`,
        [w.companyId, id]
      );
      const cash = await w.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'Till', 'Cash') RETURNING id`,
        [w.companyId, `${w.tag}-CA`]
      );
      const res = await settle(w, id, { ...window, payNow: true, cashAccountId: String(cash) });
      expect(res.body).toMatchObject({
        earned: "140.00",
        paid: "55.00",
        advances: "25.00",
        balance: "60.00",
        workerUpdated: true,
      });
      const [payroll] = await w.q(
        `SELECT status, net_salary::text AS net, cash_account_id, paid_at IS NOT NULL AS paid FROM factory_payrolls WHERE id = $1`,
        [res.body.settlementPayrollId]
      );
      expect(payroll).toEqual({ status: "PAID", net: "60.00", cash_account_id: cash, paid: true });
      const [advance] = await w.q(
        `SELECT fully_paid, remaining_balance::text AS r FROM factory_worker_advances WHERE worker_id = $1`,
        [id]
      );
      expect(advance).toEqual({ fully_paid: true, r: "0.00" });

      const reversed = await worker(w, { start: "2026-07-01" });
      const approved = await settle(w, reversed, window);
      expect(approved.body).toMatchObject({ earned: "0.00", balance: "0.00" });
      const [row] = await w.q(`SELECT status FROM factory_payrolls WHERE id = $1`, [approved.body.settlementPayrollId]);
      expect(row.status).toBe("APPROVED");
    }));

  it("refuses another company's cashAccountId and writes nothing; accepts its own", () =>
    withFactoryWorld(async (w) => {
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
        [`${w.tag}Q`]
      );
      const foreignCash = await w.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'Other Till', 'Cash') RETURNING id`,
        [other, `${w.tag}-QC`]
      );
      const id = await worker(w, { freq: "Weekly", weekly: "70" });
      for (const cashAccountId of [String(foreignCash), "abc"]) {
        const res = await settle(w, id, { ...window, cashAccountId });
        expect([res.status, res.body.message]).toEqual([404, "Cash account not found"]);
      }
      expect(await w.q(`SELECT 1 FROM factory_payrolls WHERE worker_id = $1`, [id])).toHaveLength(0);
      const [still] = await w.q(`SELECT active FROM factory_workers WHERE id = $1`, [id]);
      expect(still.active).toBe(true);

      const ownCash = await w.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'Till', 'Cash') RETURNING id`,
        [w.companyId, `${w.tag}-OC`]
      );
      const res = await settle(w, id, { ...window, cashAccountId: String(ownCash) });
      expect(res.status).toBe(200);
      const [row] = await w.q(`SELECT cash_account_id FROM factory_payrolls WHERE id = $1`, [
        res.body.settlementPayrollId,
      ]);
      expect(row.cash_account_id).toBe(ownCash);
    }));
});

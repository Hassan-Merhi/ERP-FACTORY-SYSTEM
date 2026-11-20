/**
 * POST /api/factory/advances/post-repayment-vouchers: the repayment-audit fix
 * that posts missing salary-deduction repayment journals. Real HTTP against a
 * rolled-back factory world: input and cash-account refusals, another
 * company's id in the body, the two repair cases (a paid advance with no
 * repayment row, and repayment rows with no voucher), already vouchered and
 * zero-amount rows, and a second run that posts nothing.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { ledger } from "./helpers/voucherReadFixture";

const URL = "/api/factory/advances/post-repayment-vouchers";

async function worker(w: FactoryWorld, name: string) {
  return w.one(`INSERT INTO factory_workers (company_id, full_name) VALUES ($1, $2) RETURNING id`, [w.companyId, name]);
}

async function advance(w: FactoryWorld, workerId: number, amount: string, remaining: string, paid: boolean) {
  return w.one(
    `INSERT INTO factory_worker_advances (company_id, worker_id, amount, remaining_balance, fully_paid, advance_date, repayment_type)
     VALUES ($1, $2, $3, $4, $5, '2026-04-01', 'salary_deduction') RETURNING id`,
    [w.companyId, workerId, amount, remaining, paid]
  );
}

async function repayment(w: FactoryWorld, advanceId: number, workerId: number, amount: string) {
  return w.one(
    `INSERT INTO factory_advance_repayments (company_id, advance_id, worker_id, repayment_date, amount)
     VALUES ($1, $2, $3, '2026-04-20', $4) RETURNING id`,
    [w.companyId, advanceId, workerId, amount]
  );
}

const repayVouchers = (w: FactoryWorld) =>
  w.q<{ voucher_number: string; voucher_date: string; total_amount: string }>(
    `SELECT voucher_number, voucher_date::text, total_amount::text FROM vouchers
     WHERE company_id = $1 AND voucher_number LIKE 'REPAY-SAL-%' ORDER BY voucher_number`,
    [w.companyId]
  );

describe("POST /api/factory/advances/post-repayment-vouchers", () => {
  it("refuses missing input and a cash account of another company without writing", async () => {
    await withFactoryWorld(async (w) => {
      const cash = await ledger(w, "Till", "Cash");
      expect((await w.agent.post(URL).send({ repaymentDate: "2026-05-01" })).body.message).toBe(
        "cashAccountId is required"
      );
      expect((await w.agent.post(URL).send({ cashAccountId: "abc", repaymentDate: "2026-05-01" })).status).toBe(400);
      const noDate = await w.agent.post(URL).send({ cashAccountId: cash });
      expect([noDate.status, noDate.body.message]).toEqual([400, "repaymentDate is required"]);
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
        [`${w.tag}X`]
      );
      const foreignCash = await w.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'Other Till', 'Cash') RETURNING id`,
        [other, `${w.tag}-OC`]
      );
      const foreign = await w.agent.post(URL).send({ cashAccountId: foreignCash, repaymentDate: "2026-05-01" });
      expect([foreign.status, foreign.body.message]).toEqual([400, "Cash account not found"]);
      const created = await w.q(`SELECT 1 FROM ledger_accounts WHERE company_id = $1 AND name LIKE 'Factory Work%'`, [
        w.companyId,
      ]);
      expect(created).toHaveLength(0);
    });
  });

  it("does not let a body companyId reach another company's books", async () => {
    await withFactoryWorld(async (w) => {
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
        [`${w.tag}Y`]
      );
      const foreignCash = await w.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'Other Till', 'Cash') RETURNING id`,
        [other, `${w.tag}-OY`]
      );
      const res = await w.agent
        .post(URL)
        .send({ companyId: other, cashAccountId: foreignCash, repaymentDate: "2026-05-01" });
      expect(res.status).toBe(403);
      const written = await w.q(`SELECT 1 FROM ledger_accounts WHERE company_id = $1 AND name LIKE 'Factory Work%'`, [
        other,
      ]);
      expect(written).toHaveLength(0);
    });
  });

  it("creates missing repayments and journals, skips vouchered and zero rows, and is idempotent", async () => {
    await withFactoryWorld(async (w) => {
      const cash = await ledger(w, "Till", "Cash");
      const amina = await worker(w, "Amina");
      const bilal = await worker(w, "Bilal");
      // Case B: fully paid, no repayment row.
      const paid = await advance(w, amina, "120.00", "0", true);
      // Case B skip: paid by balance but zero amount.
      await advance(w, amina, "0", "0", false);
      // Case A: repayment rows, one already vouchered under the receipt prefix.
      const open = await advance(w, bilal, "200.00", "50.00", false);
      const missing = await repayment(w, open, bilal, "80.00");
      const done = await repayment(w, open, bilal, "70.00");
      await w.q(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
         VALUES ($1, $2, 'Receipt', '2026-04-20', 70)`,
        [w.companyId, `RECEIPT-REPAY-${done}-1`]
      );
      // Not paid and no repayments: nothing to repair.
      await advance(w, bilal, "30.00", "30.00", false);

      const res = await w.agent.post(URL).send({ cashAccountId: cash, repaymentDate: "2026-05-01" });
      expect(res.status).toBe(200);
      expect(res.body.posted).toBe(2);

      const [created] = await w.q<{ id: number; amount: string; cash_account_id: number; notes: string }>(
        `SELECT id, amount::text, cash_account_id, notes FROM factory_advance_repayments WHERE advance_id = $1`,
        [paid]
      );
      expect(created).toMatchObject({
        amount: "120.00",
        cash_account_id: cash,
        notes: "Auto-created by Repayment Audit",
      });
      expect(await repayVouchers(w)).toEqual(
        [
          { voucher_number: `REPAY-SAL-${created.id}-1`, voucher_date: "2026-05-01", total_amount: "120.00" },
          { voucher_number: `REPAY-SAL-${missing}-1`, voucher_date: "2026-04-20", total_amount: "80.00" },
        ].sort((a, b) => a.voucher_number.localeCompare(b.voucher_number))
      );
      const legs = await w.q<{ name: string; debit: string; credit: string }>(
        `SELECT la.name, ve.debit_amount::text AS debit, ve.credit_amount::text AS credit
           FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id JOIN ledger_accounts la ON la.id = ve.ledger_account_id
          WHERE v.voucher_number = $1 ORDER BY ve.id`,
        [`REPAY-SAL-${missing}-1`]
      );
      expect(legs.map((l) => [l.name, Number(l.debit), Number(l.credit)])).toEqual([
        ["Factory Workers Salary Payable", 80, 0],
        ["Factory Worker Advances", 0, 80],
      ]);

      const again = await w.agent.post(URL).send({ cashAccountId: cash, repaymentDate: "2026-05-01" });
      expect([again.status, again.body.posted]).toEqual([200, 0]);
      expect(await repayVouchers(w)).toHaveLength(2);
    });
  });
});

import { getClientDate } from "../../../lib/dateUtils";
import { getErrorMessage } from "../../../lib/httpHandlers";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";

import { ledgerAccounts, voucherEntries, employees, factoryWorkers, vouchers } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { findOrCreateLedger } from "../../payroll/core/_helpers";

export function registerEmployeeAdvancesBonusRoutes(app: Express) {
  app.get("/api/factory/employee-advances", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { employeeId, status } = req.query as { employeeId?: string; status?: string };

      const empFilter = employeeId ? sql`AND ea.employee_id = ${parseInt(employeeId)}` : sql``;
      const paidFilter =
        status === "open" ? sql`AND ea.fully_paid = false` : status === "paid" ? sql`AND ea.fully_paid = true` : sql``;

      const result = await db.execute(sql`
        SELECT ea.*, e.first_name, e.last_name, e.code as employee_code,
               la.name as cash_account_name
        FROM employee_advances ea
        LEFT JOIN employees e ON e.id = ea.employee_id
        LEFT JOIN ledger_accounts la ON la.id = ea.cash_account_id
        WHERE ea.company_id = ${companyId}
          ${empFilter}
          ${paidFilter}
        ORDER BY ea.advance_date DESC, ea.id DESC
      `);
      res.json(result.rows);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  app.post("/api/factory/employee-advances", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { employeeId, advanceDate, amount, cashAccountId, notes } = req.body;
      if (!employeeId || !advanceDate || !amount)
        return res.status(400).json({ message: "employeeId, advanceDate, amount required" });
      const amt = parseFloat(amount);
      if (isNaN(amt) || amt <= 0) return res.status(400).json({ message: "Invalid amount" });

      const [emp] = await db
        .select()
        .from(employees)
        .where(and(eq(employees.id, parseInt(employeeId)), eq(employees.companyId, companyId)));
      if (!emp) return res.status(404).json({ message: "Employee not found" });

      const result = await db.execute(sql`
        INSERT INTO employee_advances (company_id, employee_id, advance_date, amount, remaining_balance, cash_account_id, notes, fully_paid)
        VALUES (${companyId}, ${parseInt(employeeId)}, ${advanceDate}, ${amt.toFixed(2)}, ${amt.toFixed(2)}, ${cashAccountId ? parseInt(cashAccountId) : null}, ${notes || null}, false)
        RETURNING *
      `);
      res.status(201).json(result.rows[0]);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  app.post("/api/factory/employee-advances/:id/repay", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const advId = parseInt(req.params.id);
      const { repaymentDate, amount, cashAccountId, notes } = req.body;
      const amt = parseFloat(amount);
      if (isNaN(amt) || amt <= 0) return res.status(400).json({ message: "Invalid amount" });

      const advResult = await db.execute(
        sql`SELECT * FROM employee_advances WHERE id = ${advId} AND company_id = ${companyId}`
      );
      const adv = advResult.rows[0] as { remaining_balance: string; employee_id: number } | undefined;
      if (!adv) return res.status(404).json({ message: "Advance not found" });

      const remaining = parseFloat(adv.remaining_balance) - amt;
      const fullyPaid = remaining <= 0;

      await db.execute(sql`
        INSERT INTO employee_advance_repayments (company_id, advance_id, employee_id, repayment_date, amount, cash_account_id, notes)
        VALUES (${companyId}, ${advId}, ${adv.employee_id}, ${repaymentDate}, ${amt.toFixed(2)}, ${cashAccountId ? parseInt(cashAccountId) : null}, ${notes || null})
      `);
      await db.execute(sql`
        UPDATE employee_advances SET remaining_balance = ${Math.max(0, remaining).toFixed(2)}, fully_paid = ${fullyPaid} WHERE id = ${advId}
      `);
      res.json({ message: "Repayment recorded", remaining: Math.max(0, remaining).toFixed(2) });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  app.get("/api/factory/employee-advance-repayments", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { advanceId } = req.query as { advanceId?: string };
      const advFilter = advanceId ? sql`AND r.advance_id = ${parseInt(advanceId)}` : sql``;
      const result = await db.execute(sql`
        SELECT r.*, e.first_name, e.last_name, ea.amount as advance_amount, ea.advance_date
        FROM employee_advance_repayments r
        LEFT JOIN employees e ON e.id = r.employee_id
        LEFT JOIN employee_advances ea ON ea.id = r.advance_id
        WHERE r.company_id = ${companyId}
          ${advFilter}
        ORDER BY r.repayment_date DESC
      `);
      res.json(result.rows);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  app.delete("/api/factory/employee-advances/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      await db.execute(
        sql`DELETE FROM employee_advance_repayments WHERE advance_id = ${parseInt(req.params.id)} AND company_id = ${companyId}`
      );
      await db.execute(
        sql`DELETE FROM employee_advances WHERE id = ${parseInt(req.params.id)} AND company_id = ${companyId}`
      );
      res.json({ message: "Advance deleted" });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ─── Employee Bonuses ─────────────────────────────────────────────────────────

  app.get("/api/factory/employee-bonuses", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { employeeId } = req.query as { employeeId?: string };
      const empFilter = employeeId ? sql`AND eb.employee_id = ${parseInt(employeeId)}` : sql``;
      const result = await db.execute(sql`
        SELECT eb.*, e.first_name, e.last_name, e.code as employee_code
        FROM employee_bonuses eb
        LEFT JOIN employees e ON e.id = eb.employee_id
        WHERE eb.company_id = ${companyId}
          ${empFilter}
        ORDER BY eb.bonus_date DESC, eb.id DESC
      `);
      res.json(result.rows);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  app.post("/api/factory/employee-bonuses", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { employeeId, bonusDate, amount, notes } = req.body;
      if (!employeeId || !bonusDate || !amount)
        return res.status(400).json({ message: "employeeId, bonusDate, amount required" });
      const amt = parseFloat(amount);
      if (isNaN(amt) || amt <= 0) return res.status(400).json({ message: "Invalid amount" });

      const [emp] = await db
        .select()
        .from(employees)
        .where(and(eq(employees.id, parseInt(employeeId)), eq(employees.companyId, companyId)));
      if (!emp) return res.status(404).json({ message: "Employee not found" });

      // Get or create PAYROLL_DEPOSIT_EXPENSE ledger account
      let [payrollExpenseAccount] = await db
        .select()
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.code, "PAYROLL_DEPOSIT_EXPENSE")));
      if (!payrollExpenseAccount) {
        [payrollExpenseAccount] = await db
          .insert(ledgerAccounts)
          .values({
            companyId,
            code: "PAYROLL_DEPOSIT_EXPENSE",
            name: "Payroll Deposit Expense",
            accountType: "Indirect Expense",
            openingBalance: "0",
            active: true,
          })
          .returning();
      }

      const voucherNumber = `EMP-BON-${Date.now()}`;
      const desc = notes || `Bonus for ${emp.firstName} ${emp.lastName}`;
      const [voucher] = await db
        .insert(vouchers)
        .values({
          companyId,
          voucherNumber,
          voucherType: "Journal",
          voucherDate: bonusDate,
          description: desc,
          totalAmount: amt.toFixed(2),
        })
        .returning();

      await db.insert(voucherEntries).values({
        voucherId: voucher.id,
        ledgerAccountId: payrollExpenseAccount.id,
        debitAmount: amt.toFixed(2),
        creditAmount: "0",
        narration: desc,
      });
      await db.insert(voucherEntries).values({
        voucherId: voucher.id,
        ledgerAccountId: null,
        employeeId: parseInt(employeeId),
        debitAmount: "0",
        creditAmount: amt.toFixed(2),
        narration: desc,
      });

      const newBalance = parseFloat(emp.currentBalance || "0") + amt;
      const newDeposits = parseFloat(emp.totalDeposits || "0") + amt;
      await db
        .update(employees)
        .set({ currentBalance: newBalance.toFixed(2), totalDeposits: newDeposits.toFixed(2) })
        .where(eq(employees.id, parseInt(employeeId)));

      const bonusResult = await db.execute(sql`
        INSERT INTO employee_bonuses (company_id, employee_id, bonus_date, amount, notes, voucher_id)
        VALUES (${companyId}, ${parseInt(employeeId)}, ${bonusDate}, ${amt.toFixed(2)}, ${notes || null}, ${voucher.id})
        RETURNING *
      `);
      res.status(201).json(bonusResult.rows[0]);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  app.delete("/api/factory/employee-bonuses/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const bonusResult = await db.execute(
        sql`SELECT * FROM employee_bonuses WHERE id = ${parseInt(req.params.id)} AND company_id = ${companyId}`
      );
      const bonus = bonusResult.rows[0] as
        { employee_id: number; amount: string; voucher_id: number | null } | undefined;
      if (!bonus) return res.status(404).json({ message: "Bonus not found" });

      // Reversing a bonus touches four rows, and all four have to move or none
      // of them may. This ran unwrapped and in the wrong order:
      // employee_bonuses.voucher_id references vouchers.id ON DELETE RESTRICT,
      // so the voucher delete raised 23503 *after* the employee's balance had
      // already been decremented and the voucher entries removed. The request
      // answered 500 while leaving the balance reduced, the bonus row present
      // and its voucher stripped of both legs — and every retry decremented the
      // balance again.
      await db.transaction(async (tx) => {
        const [emp] = await tx.select().from(employees).where(eq(employees.id, bonus.employee_id));
        if (emp) {
          const newBalance = parseFloat(emp.currentBalance || "0") - parseFloat(bonus.amount);
          const newDeposits = parseFloat(emp.totalDeposits || "0") - parseFloat(bonus.amount);
          await tx
            .update(employees)
            .set({ currentBalance: newBalance.toFixed(2), totalDeposits: newDeposits.toFixed(2) })
            .where(eq(employees.id, bonus.employee_id));
        }
        // The bonus row goes first so the voucher it references is free to drop.
        await tx.execute(
          sql`DELETE FROM employee_bonuses WHERE id = ${parseInt(req.params.id)} AND company_id = ${companyId}`
        );
        if (bonus.voucher_id) {
          await tx.execute(sql`DELETE FROM voucher_entries WHERE voucher_id = ${bonus.voucher_id}`);
          await tx.execute(sql`DELETE FROM vouchers WHERE id = ${bonus.voucher_id}`);
        }
      });
      res.json({ message: "Bonus deleted and reversed" });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ─── Worker Bonuses ───────────────────────────────────────────────────────────

  app.get("/api/factory/worker-bonuses", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId || req.session.factoryCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { workerId, status } = req.query as { workerId?: string; status?: string };
      const workerFilter = workerId ? sql`AND wb.worker_id = ${parseInt(workerId)}` : sql``;
      const statusFilter = status ? sql`AND wb.status = ${status}` : sql``;
      const result = await db.execute(sql`
        SELECT wb.id, wb.worker_id AS "workerId", wb.bonus_date AS "bonusDate",
          wb.amount, wb.notes, wb.status,
          wb.cash_account_id AS "cashAccountId", wb.paid_date AS "paidDate",
          fw.full_name as "workerName", fw.employee_code as "employeeCode",
          la.name as "cashAccountName"
        FROM worker_bonuses wb
        LEFT JOIN factory_workers fw ON fw.id = wb.worker_id
        LEFT JOIN ledger_accounts la ON la.id = wb.cash_account_id
        WHERE wb.company_id = ${companyId}
          ${workerFilter}
          ${statusFilter}
        ORDER BY wb.bonus_date DESC, wb.id DESC
      `);
      res.json(result.rows);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  app.post("/api/factory/worker-bonuses", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId || req.session.factoryCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { workerId, bonusDate, amount, notes } = req.body;
      if (!workerId || !bonusDate || !amount)
        return res.status(400).json({ message: "workerId, bonusDate, amount required" });
      const amt = parseFloat(amount);
      if (isNaN(amt) || amt <= 0) return res.status(400).json({ message: "Invalid amount" });
      // The worker is only reached through a join when the bonus is paid, and
      // that join does not scope by company — so an unchecked worker id here
      // ends up posting one company's bonus expense against another's employee.
      const [worker] = await db
        .select({ id: factoryWorkers.id })
        .from(factoryWorkers)
        .where(and(eq(factoryWorkers.id, parseInt(workerId)), eq(factoryWorkers.companyId, companyId)));
      if (!worker) return res.status(404).json({ message: "Worker not found" });
      const result = await db.execute(sql`
        INSERT INTO worker_bonuses (company_id, worker_id, bonus_date, amount, notes, status)
        VALUES (${companyId}, ${parseInt(workerId)}, ${bonusDate}, ${amt.toFixed(2)}, ${notes || null}, 'pending')
        RETURNING *
      `);
      res.status(201).json(result.rows[0]);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  app.post("/api/factory/worker-bonuses/:id/pay", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId || req.session.factoryCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { cashAccountId, paidDate } = req.body;
      if (!cashAccountId) return res.status(400).json({ message: "cashAccountId required" });
      const cashId = parseInt(cashAccountId);
      const payDate = paidDate || getClientDate(req);

      // The credit leg lands on whatever account this names, so an account from
      // another company would draw the payment out of their cash book.
      const [cashAcc] = await db
        .select({ id: ledgerAccounts.id })
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.id, cashId), eq(ledgerAccounts.companyId, companyId)));
      if (!cashAcc) return res.status(400).json({ message: "Cash account not found for this company" });

      // Fetch the bonus and worker name for accounting.
      const bonusRows = await db.execute(sql`
        SELECT wb.*, fw.full_name
        FROM worker_bonuses wb
        JOIN factory_workers fw ON fw.id = wb.worker_id
        WHERE wb.id = ${parseInt(req.params.id)} AND wb.company_id = ${companyId} AND wb.status = 'pending'
      `);
      if (!bonusRows.rows.length) return res.status(404).json({ message: "Bonus not found or already paid" });
      const wb = bonusRows.rows[0] as {
        amount: string | null;
        full_name: string | null;
        worker_id: number;
        notes: string | null;
      };
      const amt = parseFloat(wb.amount || "0");
      const workerName = (wb.full_name as string | null)?.trim() || `Worker #${wb.worker_id}`;

      // Bonus expense is tracked by worker, not location. Keep every worker account
      // grouped under the shared Bonus Expense - Workers header.
      const bonusGroup = await findOrCreateLedger(companyId, "Bonus Expense - Workers", "Expense", {
        subType: "Group",
      });
      await db.execute(sql`
        UPDATE ledger_accounts SET sub_type = 'Group'
        WHERE id = ${bonusGroup.id} AND (sub_type IS NULL OR sub_type <> 'Group')
      `);
      const expAcc = await findOrCreateLedger(companyId, `Bonus Expense - ${workerName}`, "Expense", {
        parentId: bonusGroup.id,
      });
      await db.execute(sql`
        UPDATE ledger_accounts SET parent_id = ${bonusGroup.id}
        WHERE id = ${expAcc.id} AND (parent_id IS NULL OR parent_id <> ${bonusGroup.id})
      `);

      // Mark bonus as paid and create journal entry in a transaction
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          UPDATE worker_bonuses SET status = 'paid', cash_account_id = ${cashId}, paid_date = ${payDate}
          WHERE id = ${parseInt(req.params.id)} AND company_id = ${companyId} AND status = 'pending'
        `);

        if (amt > 0) {
          const narration = wb.notes || `Bonus for ${workerName}`;
          const [bVoucher] = await tx
            .insert(vouchers)
            .values({
              companyId,
              voucherNumber: `WBONUS-${req.params.id}-${Date.now()}`,
              voucherType: "Journal",
              voucherDate: payDate,
              description: narration,
              totalAmount: amt.toFixed(2),
              currency: "USD",
              sourceModule: "FACTORY",
            })
            .returning();
          await tx.insert(voucherEntries).values([
            {
              voucherId: bVoucher.id,
              ledgerAccountId: expAcc.id,
              debitAmount: amt.toFixed(2),
              creditAmount: "0",
              narration: `Bonus - ${workerName}: ${narration}`,
            },
            {
              voucherId: bVoucher.id,
              ledgerAccountId: cashId,
              debitAmount: "0",
              creditAmount: amt.toFixed(2),
              narration,
            },
          ]);
        }
      });

      res.json({ message: "Bonus marked as paid" });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  app.delete("/api/factory/worker-bonuses/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId || req.session.factoryCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseInt(req.params.id);

      const bonusRows = await db.execute(
        sql`SELECT * FROM worker_bonuses WHERE id = ${id} AND company_id = ${companyId}`
      );
      const bonus = bonusRows.rows[0];
      if (!bonus) return res.status(404).json({ message: "Bonus not found" });

      await db.transaction(async (tx) => {
        // Paid bonuses are posted with voucherNumber `WBONUS-{id}-{ts}` (see /pay above) —
        // there's no voucher_id FK column on worker_bonuses, so look the voucher up by that
        // naming convention and reverse it along with its entries before deleting the bonus.
        const voucherRows = await tx.execute(
          sql`SELECT id FROM vouchers WHERE company_id = ${companyId} AND voucher_number LIKE ${"WBONUS-" + id + "-%"}`
        );
        for (const v of voucherRows.rows) {
          await tx.execute(sql`DELETE FROM voucher_entries WHERE voucher_id = ${v.id}`);
          await tx.execute(sql`DELETE FROM vouchers WHERE id = ${v.id}`);
        }

        await tx.execute(sql`DELETE FROM worker_bonuses WHERE id = ${id} AND company_id = ${companyId}`);
      });

      res.json({ message: "Bonus deleted and reversed" });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ============================================================
  // BALE LEDGER — full production lifecycle summary
  // ============================================================
}

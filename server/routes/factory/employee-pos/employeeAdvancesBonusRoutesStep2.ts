// Extracted from ./employeeAdvancesBonusRoutes.ts: a stage of employeeAdvancesBonusRoutes.
import { getErrorMessage } from "../../../lib/httpHandlers";
import type { Request, Response, Express } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { ledgerAccounts, employees } from "@shared/schema";
import { factorySessionActor, postFactoryVoucherTx } from "../../../services/factory/factoryVoucherPosting";
import { eq, and, sql } from "drizzle-orm";
import { moneyString, parseMoneyInput, toMoney } from "../../../lib/money";
import { retireVouchersTx, sessionRetirementActor } from "../../../services/accounting/voucherRetirement";
import { employeeAdvancesBonusRoutesStep } from "./employeeAdvancesBonusRoutesStep";

export function employeeAdvancesBonusRoutesStep2({ app }: { app: Express }) {
  employeeAdvancesBonusRoutesStep({ app });

  app.post("/api/factory/employee-bonuses", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { employeeId, bonusDate, amount, notes } = req.body;
      if (!employeeId || !bonusDate || !amount)
        return res.status(400).json({ message: "employeeId, bonusDate, amount required" });
      const amt = parseMoneyInput(amount);
      if (!amt || amt.lessThanOrEqualTo(0)) return res.status(400).json({ message: "Invalid amount" });

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

      // Phase 22 (C): the bonus row, its voucher (engine, engine-numbered — was
      // EMP-BON-{Date.now()} — with the bonus's posting identity) and the
      // employee's running balance commit together (the balance and the bonus row
      // used to be written after the voucher's commit).
      const desc = notes || `Bonus for ${emp.firstName} ${emp.lastName}`;
      const bonusResult = await db.transaction(async (tx) => {
        const inserted = await tx.execute(sql`
          INSERT INTO employee_bonuses (company_id, employee_id, bonus_date, amount, notes, voucher_id)
          VALUES (${companyId}, ${parseInt(employeeId)}, ${bonusDate}, ${moneyString(amt)}, ${notes || null}, NULL)
          RETURNING id
        `);
        const bonusId = Number((inserted.rows[0] as { id: number }).id);
        const { voucher } = await postFactoryVoucherTx(tx, {
          companyId,
          voucherDate: bonusDate,
          description: desc,
          sourceModule: "ERP",
          source: { sourceType: "factory-employee-bonus", sourceId: bonusId, phase: "voucher" },
          actor: factorySessionActor(req),
          lines: [
            { ledgerAccountId: payrollExpenseAccount.id, debit: amt, narration: desc },
            { employeeId: parseInt(employeeId), credit: amt, narration: desc },
          ],
        });
        const [current] = await tx
          .select({ currentBalance: employees.currentBalance, totalDeposits: employees.totalDeposits })
          .from(employees)
          .where(eq(employees.id, parseInt(employeeId)))
          .for("update");
        const newBalance = toMoney(current?.currentBalance).plus(moneyString(amt));
        const newDeposits = toMoney(current?.totalDeposits).plus(moneyString(amt));
        await tx
          .update(employees)
          .set({ currentBalance: moneyString(newBalance), totalDeposits: moneyString(newDeposits) })
          .where(eq(employees.id, parseInt(employeeId)));
        return tx.execute(sql`
          UPDATE employee_bonuses SET voucher_id = ${voucher.id}
           WHERE id = ${bonusId} AND company_id = ${companyId}
          RETURNING *
        `);
      });
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
          const newBalance = toMoney(emp.currentBalance).minus(toMoney(bonus.amount));
          const newDeposits = toMoney(emp.totalDeposits).minus(toMoney(bonus.amount));
          await tx
            .update(employees)
            .set({ currentBalance: moneyString(newBalance), totalDeposits: moneyString(newDeposits) })
            .where(eq(employees.id, bonus.employee_id));
        }
        // The bonus row goes first so the voucher it references is free to drop.
        await tx.execute(
          sql`DELETE FROM employee_bonuses WHERE id = ${parseInt(req.params.id)} AND company_id = ${companyId}`
        );
        if (bonus.voucher_id) {
          // Wave 16 (A): retired (soft delete with lines, audited here), not hard-deleted.
          await retireVouchersTx(tx, {
            companyId,
            voucherIds: [Number(bonus.voucher_id)],
            reason: "employee-bonus-delete",
            actor: sessionRetirementActor(req),
          });
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
      // Production Targets payments are a separate authoritative payment source.
      // Display them on the Workers > Bonuses history without duplicating a worker_bonuses
      // record, creating another payable, or exposing the legacy pay/delete actions.
      const productionHistory =
        status === "pending"
          ? []
          : (
              await db.execute(sql`
        SELECT p.id, p.worker_id AS "workerId", p.payment_date::text AS "bonusDate",
          p.amount_usd::text AS amount,
          'Manual Production Bonus - week ' || p.week_start::text AS notes,
          CASE WHEN p.status='POSTED' THEN 'paid' ELSE 'reversed' END AS status,
          p.cash_ledger_account_id AS "cashAccountId", p.payment_date::text AS "paidDate",
          fw.full_name AS "workerName", fw.employee_code AS "employeeCode",
          la.name AS "cashAccountName", 'production_manual' AS source,
          p.payment_voucher_id AS "voucherId"
        FROM factory_target_bonus_manual_payments p
        JOIN factory_workers fw ON fw.id=p.worker_id AND fw.company_id=p.company_id
        JOIN ledger_accounts la ON la.id=p.cash_ledger_account_id AND la.company_id=p.company_id
        WHERE p.company_id=${companyId}
          ${workerId ? sql`AND p.worker_id=${parseInt(workerId)}` : sql``}
          ${status === "paid" ? sql`AND p.status='POSTED'` : sql``}
        UNION ALL
        SELECT p.id, p.worker_id, p.payment_date::text, p.bonus_amount::text,
          'Production Targets weekly bonus - week ' || p.week_start::text,
          CASE WHEN p.status='POSTED' THEN 'paid' ELSE 'reversed' END,
          p.cash_ledger_account_id, p.payment_date::text,
          fw.full_name, fw.employee_code, la.name, 'production_weekly',
          p.payment_voucher_id
        FROM factory_target_bonus_weekly_payments p
        JOIN factory_workers fw ON fw.id=p.worker_id AND fw.company_id=p.company_id
        JOIN ledger_accounts la ON la.id=p.cash_ledger_account_id AND la.company_id=p.company_id
        WHERE p.company_id=${companyId}
          ${workerId ? sql`AND p.worker_id=${parseInt(workerId)}` : sql``}
          ${status === "paid" ? sql`AND p.status='POSTED'` : sql``}
        UNION ALL
        SELECT p.id, p.worker_id, p.payment_date::text, p.bonus_amount::text,
          'Production Targets daily bonus - ' || p.production_date::text,
          CASE WHEN p.status='POSTED' THEN 'paid' ELSE 'reversed' END,
          p.cash_ledger_account_id, p.payment_date::text,
          fw.full_name, fw.employee_code, la.name, 'production_daily',
          p.payment_voucher_id
        FROM factory_target_bonus_payments p
        JOIN factory_workers fw ON fw.id=p.worker_id AND fw.company_id=p.company_id
        JOIN ledger_accounts la ON la.id=p.cash_ledger_account_id AND la.company_id=p.company_id
        WHERE p.company_id=${companyId}
          ${workerId ? sql`AND p.worker_id=${parseInt(workerId)}` : sql``}
          ${status === "paid" ? sql`AND p.status='POSTED'` : sql``}
      `)
            ).rows;
      const legacy = result.rows.map((row) => ({ ...row, source: "worker" }));
      res.json(
        ([...legacy, ...productionHistory] as Array<Record<string, unknown>>).sort(
          (a, b) => String(b.bonusDate).localeCompare(String(a.bonusDate)) || Number(b.id) - Number(a.id)
        )
      );
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}

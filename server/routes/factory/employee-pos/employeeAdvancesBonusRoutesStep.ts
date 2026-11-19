// Extracted from ./employeeAdvancesBonusRoutes.ts: a stage of employeeAdvancesBonusRoutes.
import { getErrorMessage } from "../../../lib/httpHandlers";
import type { Request, Response, Express } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { employees } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { MoneyDecimal, moneyString, parseMoneyInput, toMoney } from "../../../lib/money";
import { z } from "zod";
import { emptyBody, emptyQuery, stringParam, validateRequest, type RequestSchemas } from "../../../lib/validateRequest";

// The handlers parse ids with parseInt and amounts with parseMoneyInput and
// answer their own 400s for missing fields, so those stay optional here.
const numeric = z.union([z.number(), z.string()]);
const text = z.string().nullable().optional();
const advanceParams = z.strictObject({ id: stringParam });

const createEmployeeAdvanceInput = {
  query: emptyQuery,
  body: z.strictObject({
    employeeId: numeric.nullable().optional(),
    advanceDate: text,
    amount: numeric.nullable().optional(),
    cashAccountId: numeric.nullable().optional(),
    notes: text,
  }),
} satisfies RequestSchemas;

const repayEmployeeAdvanceInput = {
  params: advanceParams,
  query: emptyQuery,
  body: z.strictObject({
    repaymentDate: text,
    amount: numeric.nullable().optional(),
    cashAccountId: numeric.nullable().optional(),
    notes: text,
  }),
} satisfies RequestSchemas;

const deleteEmployeeAdvanceInput = {
  params: advanceParams,
  query: emptyQuery,
  body: emptyBody,
} satisfies RequestSchemas;

export function employeeAdvancesBonusRoutesStep({ app }: { app: Express }) {
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

  app.post(
    "/api/factory/employee-advances",
    requireAuth,
    validateRequest(createEmployeeAdvanceInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const { employeeId, advanceDate, amount, cashAccountId, notes } = req.body;
        if (!employeeId || !advanceDate || !amount)
          return res.status(400).json({ message: "employeeId, advanceDate, amount required" });
        const amt = parseMoneyInput(amount);
        if (!amt || amt.lessThanOrEqualTo(0)) return res.status(400).json({ message: "Invalid amount" });

        const [emp] = await db
          .select()
          .from(employees)
          .where(and(eq(employees.id, parseInt(employeeId)), eq(employees.companyId, companyId)));
        if (!emp) return res.status(404).json({ message: "Employee not found" });

        const result = await db.execute(sql`
        INSERT INTO employee_advances (company_id, employee_id, advance_date, amount, remaining_balance, cash_account_id, notes, fully_paid)
        VALUES (${companyId}, ${parseInt(employeeId)}, ${advanceDate}, ${moneyString(amt)}, ${moneyString(amt)}, ${cashAccountId ? parseInt(cashAccountId) : null}, ${notes || null}, false)
        RETURNING *
      `);
        res.status(201).json(result.rows[0]);
      } catch (err: unknown) {
        res.status(500).json({ message: getErrorMessage(err) });
      }
    }
  );

  app.post(
    "/api/factory/employee-advances/:id/repay",
    requireAuth,
    validateRequest(repayEmployeeAdvanceInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const advId = parseInt(req.params.id);
        const { repaymentDate, amount, cashAccountId, notes } = req.body;
        const amt = parseMoneyInput(amount);
        if (!amt || amt.lessThanOrEqualTo(0)) return res.status(400).json({ message: "Invalid amount" });

        const advResult = await db.execute(
          sql`SELECT * FROM employee_advances WHERE id = ${advId} AND company_id = ${companyId}`
        );
        const adv = advResult.rows[0] as { remaining_balance: string; employee_id: number } | undefined;
        if (!adv) return res.status(404).json({ message: "Advance not found" });

        const remaining = toMoney(adv.remaining_balance).minus(moneyString(amt));
        const fullyPaid = remaining.lessThanOrEqualTo(0);

        await db.execute(sql`
        INSERT INTO employee_advance_repayments (company_id, advance_id, employee_id, repayment_date, amount, cash_account_id, notes)
        VALUES (${companyId}, ${advId}, ${adv.employee_id}, ${repaymentDate}, ${moneyString(amt)}, ${cashAccountId ? parseInt(cashAccountId) : null}, ${notes || null})
      `);
        await db.execute(sql`
        UPDATE employee_advances SET remaining_balance = ${moneyString(MoneyDecimal.max(0, remaining))}, fully_paid = ${fullyPaid} WHERE id = ${advId}
      `);
        res.json({ message: "Repayment recorded", remaining: moneyString(MoneyDecimal.max(0, remaining)) });
      } catch (err: unknown) {
        res.status(500).json({ message: getErrorMessage(err) });
      }
    }
  );

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

  app.delete(
    "/api/factory/employee-advances/:id",
    requireAuth,
    validateRequest(deleteEmployeeAdvanceInput),
    async (req: Request, res: Response) => {
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
    }
  );

  // ─── Employee Bonuses ─────────────────────────────────────────────────────────

  app.get("/api/factory/employee-bonuses", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { employeeId } = req.query as { employeeId?: string };
      const empFilter = employeeId ? sql`AND eb.employee_id = ${parseInt(employeeId)}` : sql``;
      const result = await db.execute(sql`
        -- Preserve legacy snake_case fields while supplying the camelCase contract
        -- used by Payroll & Benefits > Employees > Bonuses. Read-only; no ledger writes.
        SELECT eb.*, eb.employee_id AS "employeeId",
               eb.bonus_date::text AS "bonusDate",
               e.first_name AS "firstName", e.last_name AS "lastName",
               e.code AS "employeeCode"
        FROM employee_bonuses eb
        LEFT JOIN employees e ON e.id = eb.employee_id AND e.company_id = eb.company_id
        WHERE eb.company_id = ${companyId}
          ${empFilter}
        ORDER BY eb.bonus_date DESC, eb.id DESC
      `);
      res.json(result.rows);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}

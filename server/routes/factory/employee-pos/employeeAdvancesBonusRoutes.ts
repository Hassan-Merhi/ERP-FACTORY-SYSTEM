import { getClientDate } from "../../../lib/dateUtils";
import { getErrorMessage } from "../../../lib/httpHandlers";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";

import { ledgerAccounts, factoryWorkers } from "@shared/schema";
import { factorySessionActor, postFactoryVoucherTx } from "../../../services/factory/factoryVoucherPosting";
import { eq, and, sql } from "drizzle-orm";
import { findOrCreateLedger } from "../../payroll/core/_helpers";
import { moneyString, parseMoneyInput, toMoney } from "../../../lib/money";
import { retireVouchersTx, sessionRetirementActor } from "../../../services/accounting/voucherRetirement";
import { registerEmployeeAdvancesBonusRoutesPart1 } from "./registerEmployeeAdvancesBonusRoutesPart1";

export function registerEmployeeAdvancesBonusRoutes(app: Express) {
  registerEmployeeAdvancesBonusRoutesPart1(app);
  registerEmployeeAdvancesBonusRoutesPart2(app);

  // ============================================================
  // BALE LEDGER — full production lifecycle summary
  // ============================================================
}

function registerEmployeeAdvancesBonusRoutesPart2(app: Express) {
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

  app.post("/api/factory/worker-bonuses", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId || req.session.factoryCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { workerId, bonusDate, amount, notes } = req.body;
      if (!workerId || !bonusDate || !amount)
        return res.status(400).json({ message: "workerId, bonusDate, amount required" });
      const amt = parseMoneyInput(amount);
      if (!amt || amt.lessThanOrEqualTo(0)) return res.status(400).json({ message: "Invalid amount" });
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
        VALUES (${companyId}, ${parseInt(workerId)}, ${bonusDate}, ${moneyString(amt)}, ${notes || null}, 'pending')
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
      const amt = toMoney(wb.amount);
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
        const marked = await tx.execute(sql`
          UPDATE worker_bonuses SET status = 'paid', cash_account_id = ${cashId}, paid_date = ${payDate}
          WHERE id = ${parseInt(req.params.id)} AND company_id = ${companyId} AND status = 'pending'
          RETURNING id
        `);
        // Phase 22 (C): only the request that moved it to paid posts (a concurrent
        // second pay found it paid already), through the engine with the bonus's
        // identity; WBONUS-{id}- is read by the delete below, so it keeps the
        // prefix with the posting generation (was Date.now()).
        if (marked.rows.length > 0 && amt.greaterThan(0)) {
          const narration = wb.notes || `Bonus for ${workerName}`;
          await postFactoryVoucherTx(tx, {
            companyId,
            voucherNumber: (generation) => `WBONUS-${req.params.id}-${generation}`,
            voucherDate: payDate,
            description: narration,
            source: { sourceType: "factory-worker-bonus", sourceId: req.params.id, phase: "paid" },
            actor: factorySessionActor(req),
            lines: [
              { ledgerAccountId: expAcc.id, debit: amt, narration: `Bonus - ${workerName}: ${narration}` },
              { ledgerAccountId: cashId, credit: amt, narration },
            ],
          });
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
        // Wave 16 (A): retired (soft delete with lines, audited here), not hard-deleted.
        await retireVouchersTx(tx, {
          companyId,
          voucherIds: voucherRows.rows.map((v) => Number(v.id)),
          reason: "worker-bonus-delete",
          actor: sessionRetirementActor(req),
        });

        await tx.execute(sql`DELETE FROM worker_bonuses WHERE id = ${id} AND company_id = ${companyId}`);
      });

      res.json({ message: "Bonus deleted and reversed" });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}

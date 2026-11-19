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
import { employeeAdvancesBonusRoutesStep2 } from "./employeeAdvancesBonusRoutesStep2";
import { z } from "zod";
import { emptyBody, emptyQuery, stringParam, validateRequest, type RequestSchemas } from "../../../lib/validateRequest";

// The handlers parse ids with parseInt and amounts with parseMoneyInput and
// answer their own 400s for missing fields, so those stay optional here.
const numeric = z.union([z.number(), z.string()]);
const text = z.string().nullable().optional();
const bonusParams = z.strictObject({ id: stringParam });

const createWorkerBonusInput = {
  query: emptyQuery,
  body: z.strictObject({
    workerId: numeric.nullable().optional(),
    bonusDate: text,
    amount: numeric.nullable().optional(),
    notes: text,
  }),
} satisfies RequestSchemas;

const payWorkerBonusInput = {
  params: bonusParams,
  query: emptyQuery,
  body: z.strictObject({
    cashAccountId: numeric.nullable().optional(),
    paidDate: text,
    // Request identity: the client fetch guard adds it and operationalVoucherRequestBoundary claims it.
    clientRequestId: z.string().optional(),
  }),
} satisfies RequestSchemas;

const deleteWorkerBonusInput = { params: bonusParams, query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

export function registerEmployeeAdvancesBonusRoutes(app: Express) {
  employeeAdvancesBonusRoutesStep2({ app });

  app.post(
    "/api/factory/worker-bonuses",
    requireAuth,
    validateRequest(createWorkerBonusInput),
    async (req: Request, res: Response) => {
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
    }
  );

  app.post(
    "/api/factory/worker-bonuses/:id/pay",
    requireAuth,
    validateRequest(payWorkerBonusInput),
    async (req: Request, res: Response) => {
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
    }
  );

  app.delete(
    "/api/factory/worker-bonuses/:id",
    requireAuth,
    validateRequest(deleteWorkerBonusInput),
    async (req: Request, res: Response) => {
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
    }
  );

  // ============================================================
  // BALE LEDGER — full production lifecycle summary
  // ============================================================
}

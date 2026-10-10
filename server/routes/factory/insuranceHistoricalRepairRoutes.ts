/**
 * Insurance journal direction repair (accounting audit wave 16 A).
 *
 *   GET  /api/insurance/admin/journal-direction/plan    Owner, read-only plan
 *   POST /api/insurance/admin/journal-direction/apply   Owner, { confirm: true, planHash }
 *
 * (It replaces POST /api/insurance/admin/repair-reversed-journals, Admin, whose
 * apply took a typed confirmation and no plan hash. The paths carry no
 * maintenance keyword, so the Owner is admitted: privilegedMaintenanceRoutePolicy
 * admits only Admin and Developer to "repair" paths.)
 *
 * Old generated insurance journals were posted Dr Insurance Expense / Cr the
 * member liability. The repair swaps debit and credit on such a voucher.
 *
 * It used to run when the routes registered (every boot), across every
 * company in maintenance scope — which also bypassed the closed-period guard —
 * with no audit. It now runs only from this reviewed tool:
 * - the preview lists every voucher and line it would change, with the
 *   amounts before and after, the vouchers it skips and why, and a plan hash;
 * - the apply runs for the current company only, in one transaction (company
 *   scope asserted, advisory lock), derives the plan again under row locks and
 *   applies it only when its hash is the reviewed one (409 PLAN_CHANGED);
 * - a voucher in a closed period (by its voucher date or effective date,
 *   COALESCE(effective_date, voucher_date)) is skipped (PERIOD_CLOSED) and the
 *   closed-period trigger still guards every line;
 * - each line's debit and credit swap together with its transaction and base
 *   amounts (the old swap left those on the old side of a non-USD line);
 * - one audit row in the transaction holds every line before and after.
 */
import { createHash } from "node:crypto";
import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";

import { db, type DatabaseOrTransaction } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { closedPeriodErrorResponse } from "../../lib/closedPeriodError";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { MoneyDecimal } from "../../lib/money";
import { writeAuditEvent } from "../../services/audit";
import { resolveRequestCompanyId } from "../../services/security/requestCompanyScope";
import { assertTransactionCompanyScope } from "../../services/security/transactionCompanyScope";

const PLAN_HASH = /^[0-9a-f]{64}$/;
const PLAN_ROUTE = "/api/insurance/admin/journal-direction/plan";
const APPLY_ROUTE = "/api/insurance/admin/journal-direction/apply";

export type InsuranceRepairSkipReason =
  | "INSURANCE_LEDGER_PATTERN_NOT_PROVEN"
  | "UNEXPECTED_EXTRA_LEDGER_ENTRY"
  | "MIXED_OR_AMBIGUOUS_ENTRY_DIRECTION"
  | "UNBALANCED_REVERSED_JOURNAL"
  | "PERIOD_CLOSED";

export interface InsuranceRepairLine {
  entryId: number;
  ledgerAccountId: number | null;
  ledgerName: string | null;
  debit: string;
  credit: string;
  newDebit: string;
  newCredit: string;
}

export interface InsuranceRepairVoucher {
  voucherId: number;
  voucherNumber: string;
  voucherDate: string;
  effectiveDate: string | null;
  total: string;
  lines: InsuranceRepairLine[];
}

export interface InsuranceRepairPlan {
  companyId: number;
  candidates: InsuranceRepairVoucher[];
  skipped: { voucherId: number; voucherNumber: string; reason: InsuranceRepairSkipReason }[];
  planHash: string;
}

export class InsuranceRepairRefusal extends Error {
  constructor(
    readonly code: "PLAN_CHANGED" | "NOTHING_TO_APPLY",
    message: string
  ) {
    super(message);
    this.name = "InsuranceRepairRefusal";
  }
}

type EntryRow = {
  entry_id: number;
  voucher_id: number;
  voucher_number: string;
  voucher_date: string;
  effective_date: string | null;
  period_closed: boolean;
  ledger_account_id: number | null;
  ledger_name: string | null;
  account_type: string | null;
  debit: string;
  credit: string;
  member_linked: boolean;
};

async function loadEntries(executor: DatabaseOrTransaction, companyId: number, lock: boolean): Promise<EntryRow[]> {
  const result = await executor.execute<EntryRow & Record<string, unknown>>(sql`
    SELECT ve.id AS entry_id, v.id AS voucher_id, v.voucher_number, v.voucher_date::text AS voucher_date,
           v.effective_date::text AS effective_date,
           COALESCE((
             SELECT max(fc.period_end_date) FROM fiscal_period_closures fc
              WHERE fc.company_id = v.company_id AND fc.status = 'CLOSED'
           ) >= LEAST(v.voucher_date, COALESCE(v.effective_date, v.voucher_date)), false) AS period_closed,
           ve.ledger_account_id, la.name AS ledger_name, la.account_type,
           COALESCE(ve.debit_amount, 0)::text AS debit, COALESCE(ve.credit_amount, 0)::text AS credit,
           EXISTS (SELECT 1 FROM insurance_members im
                    WHERE im.company_id = v.company_id AND im.ledger_account_id = la.id) AS member_linked
      FROM vouchers v
      JOIN voucher_entries ve ON ve.voucher_id = v.id
      LEFT JOIN ledger_accounts la ON la.id = ve.ledger_account_id
     WHERE v.company_id = ${companyId}
       AND v.deleted_at IS NULL
       AND v.source_module = 'ERP'
       AND v.voucher_number ILIKE 'INS-%'
     ORDER BY v.id, ve.id
     ${lock ? sql`FOR UPDATE OF ve` : sql``}
  `);
  return result.rows as unknown as EntryRow[];
}

const isExpense = (row: EntryRow) => row.ledger_name === "Insurance Expense" && row.account_type === "Expense";
const isLiability = (row: EntryRow) =>
  row.account_type === "Liability" && ((row.ledger_name ?? "").startsWith("Insurance - ") || row.member_linked);

/** The plan for one company: which INS- vouchers carry the old direction, provably, and what the swap writes. */
async function derivePlan(
  executor: DatabaseOrTransaction,
  companyId: number,
  lock: boolean
): Promise<InsuranceRepairPlan> {
  const byVoucher = new Map<number, EntryRow[]>();
  for (const row of await loadEntries(executor, companyId, lock)) {
    const list = byVoucher.get(row.voucher_id) ?? [];
    list.push(row);
    byVoucher.set(row.voucher_id, list);
  }

  const candidates: InsuranceRepairVoucher[] = [];
  const skipped: InsuranceRepairPlan["skipped"] = [];
  const zero = new MoneyDecimal(0);
  for (const [voucherId, entries] of byVoucher) {
    const first = entries[0];
    const skip = (reason: InsuranceRepairSkipReason) =>
      skipped.push({ voucherId, voucherNumber: first.voucher_number, reason });
    const expenses = entries.filter(isExpense);
    const liabilities = entries.filter(isLiability);
    if (expenses.length !== 1 || liabilities.length === 0) {
      skip("INSURANCE_LEDGER_PATTERN_NOT_PROVEN");
      continue;
    }
    if (expenses.length + liabilities.length !== entries.length) {
      skip("UNEXPECTED_EXTRA_LEDGER_ENTRY");
      continue;
    }
    const expenseDebit = new MoneyDecimal(expenses[0].debit);
    const expenseCredit = new MoneyDecimal(expenses[0].credit);
    const liabilityDebits = liabilities.reduce((sum, row) => sum.plus(row.debit), zero);
    const liabilityCredits = liabilities.reduce((sum, row) => sum.plus(row.credit), zero);
    // Already in the corrected direction: nothing to do.
    if (expenseDebit.isZero() && expenseCredit.gt(0) && liabilityDebits.gt(0) && liabilityCredits.isZero()) continue;
    const legacy =
      expenseDebit.gt(0) &&
      expenseCredit.isZero() &&
      liabilities.every((row) => new MoneyDecimal(row.debit).isZero() && new MoneyDecimal(row.credit).gt(0));
    if (!legacy) {
      skip("MIXED_OR_AMBIGUOUS_ENTRY_DIRECTION");
      continue;
    }
    if (!expenseDebit.eq(liabilityCredits)) {
      skip("UNBALANCED_REVERSED_JOURNAL");
      continue;
    }
    if (first.period_closed) {
      skip("PERIOD_CLOSED");
      continue;
    }
    candidates.push({
      voucherId,
      voucherNumber: first.voucher_number,
      voucherDate: first.voucher_date,
      effectiveDate: first.effective_date,
      total: expenseDebit.toFixed(2),
      lines: entries.map((row) => ({
        entryId: row.entry_id,
        ledgerAccountId: row.ledger_account_id,
        ledgerName: row.ledger_name,
        debit: new MoneyDecimal(row.debit).toFixed(2),
        credit: new MoneyDecimal(row.credit).toFixed(2),
        newDebit: new MoneyDecimal(row.credit).toFixed(2),
        newCredit: new MoneyDecimal(row.debit).toFixed(2),
      })),
    });
  }

  const planHash = createHash("sha256").update(JSON.stringify({ candidates, skipped })).digest("hex");
  return { companyId, candidates, skipped, planHash };
}

/** Read-only plan for the company. */
export function planInsuranceJournalDirectionRepair(
  companyId: number,
  executor: DatabaseOrTransaction = db
): Promise<InsuranceRepairPlan> {
  return derivePlan(executor, companyId, false);
}

/** Applies the reviewed plan for the company in one transaction, audited in it. */
export async function applyInsuranceJournalDirectionRepair(
  companyId: number,
  options: { planHash: string; actor: { userId: string | number; username: string } }
): Promise<InsuranceRepairPlan & { repairedVoucherIds: number[] }> {
  return db.transaction(async (tx) => {
    await assertTransactionCompanyScope(tx, companyId);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('insurance-journal-direction-repair'), ${companyId})`);
    const plan = await derivePlan(tx, companyId, true);
    if (plan.planHash !== options.planHash) {
      throw new InsuranceRepairRefusal(
        "PLAN_CHANGED",
        "The insurance journal repair plan changed since it was reviewed; review it again before applying"
      );
    }
    if (plan.candidates.length === 0) {
      throw new InsuranceRepairRefusal("NOTHING_TO_APPLY", "There is nothing to repair");
    }
    for (const candidate of plan.candidates) {
      for (const line of candidate.lines) {
        const updated = await tx.execute(sql`
          UPDATE voucher_entries
             SET debit_amount = credit_amount, credit_amount = debit_amount,
                 transaction_debit_amount = transaction_credit_amount,
                 transaction_credit_amount = transaction_debit_amount,
                 base_debit_amount = base_credit_amount, base_credit_amount = base_debit_amount
           WHERE id = ${line.entryId} AND voucher_id = ${candidate.voucherId}
             AND debit_amount = ${line.debit} AND credit_amount = ${line.credit}
        `);
        if (updated.rowCount !== 1) throw new Error("An insurance journal line changed during the repair");
      }
    }
    await writeAuditEvent(
      {
        userId: options.actor.userId,
        username: options.actor.username,
        companyId,
        action: "update",
        tableName: "voucher_entries",
        recordIdentifier: "insurance-journal-direction-repair",
        changes: {
          lines: {
            old: plan.candidates.flatMap((candidate) =>
              candidate.lines.map((line) => ({
                voucherId: candidate.voucherId,
                voucherNumber: candidate.voucherNumber,
                entryId: line.entryId,
                debit: line.debit,
                credit: line.credit,
              }))
            ),
            new: plan.candidates.flatMap((candidate) =>
              candidate.lines.map((line) => ({
                voucherId: candidate.voucherId,
                entryId: line.entryId,
                debit: line.newDebit,
                credit: line.newCredit,
              }))
            ),
          },
        },
        metadata: { planHash: plan.planHash, skipped: plan.skipped },
      },
      tx
    );
    return { ...plan, repairedVoucherIds: plan.candidates.map((candidate) => candidate.voucherId) };
  });
}

export function registerInsuranceHistoricalRepairRoutes(app: Express): void {
  // Wave 16 (A): no repair runs when the routes register (it ran at every boot).
  app.get(PLAN_ROUTE, requireAuth, requireRole("Owner"), async (req: Request, res: Response) => {
    try {
      const companyId = resolveRequestCompanyId(req);
      res.json(await planInsuranceJournalDirectionRepair(companyId));
    } catch (error: unknown) {
      logger.error(`GET ${PLAN_ROUTE} error`, { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post(APPLY_ROUTE, requireAuth, requireRole("Owner"), async (req: Request, res: Response) => {
    try {
      const companyId = resolveRequestCompanyId(req);
      if (req.body?.confirm !== true) return res.status(400).json({ message: "Confirmation is required" });
      const planHash = req.body?.planHash;
      if (typeof planHash !== "string" || !PLAN_HASH.test(planHash)) {
        return res.status(400).json({ message: "The reviewed plan hash is required" });
      }
      const result = await applyInsuranceJournalDirectionRepair(companyId, {
        planHash,
        actor: {
          userId: String(req.session.userId ?? ""),
          username: req.session.username || String(req.session.userId ?? "unknown"),
        },
      });
      res.json(result);
    } catch (error: unknown) {
      if (error instanceof InsuranceRepairRefusal) {
        const status = error.code === "NOTHING_TO_APPLY" ? 400 : 409;
        return res.status(status).json({ code: error.code, message: error.message });
      }
      const closed = closedPeriodErrorResponse(error);
      if (closed) return res.status(closed.status).json(closed.body);
      logger.error(`POST ${APPLY_ROUTE} error`, { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

/**
 * Legacy fully prepaid shop rent, as a reviewed Owner tool (accounting audit
 * wave 18 A, owner decision 2 of 2026-10-10).
 *
 * The case: an owned SHOP month (ERP or FACTORY rental) paid in full before
 * its billing date by payments posted before the prepaid-rent workflow
 * existed (Dr Rent Expense / Cr cash), or that lost its prepaid flag, and
 * never recognised. The correction moves each early payment's expense to
 * Prepaid Rent at the payment date (LEGACY-PREPAID-RECLASS-{company}-{row}-{payment}:
 * Dr Prepaid Rent / Cr Rent Expense) and recognises the month on its billing
 * date (LEGACY-PREPAID-REC-{company}-{row}: Dr Rent Expense / Cr Prepaid Rent),
 * then marks the month accrued and prepaid. Rows whose payments cannot be
 * matched to a prepaid or a rent expense debit are listed as AMBIGUOUS and
 * left alone.
 *
 * Before: `repairLegacyFullyPrepaidRentRecognition` ran in the daily rental
 * job (scheduler, maintenance scope: the closed-period guard bypassed) for
 * every company, posting these journals back-dated to the original payment
 * dates with no audit and no closure check.
 *
 * Now nothing runs by itself. The Owner reviews and applies it:
 * - the plan (GET, read-only) lists each month with its vouchers and lines,
 *   the accounts (a missing Prepaid Rent / expense account is created on
 *   apply, never retyped or restored), the months skipped (AMBIGUOUS,
 *   PERIOD_CLOSED) and a sha256 planHash;
 * - the apply (POST `{ confirm: true, planHash }`) runs for the current
 *   company only in one transaction (company scope asserted, advisory lock,
 *   the monthly rows locked), derives the plan again and applies it only when
 *   the hash matches (409 PLAN_CHANGED); a month any of whose vouchers — the
 *   new ones and the payment vouchers whose expense they move, by
 *   COALESCE(effective_date, voucher_date) — falls in a closed period is not
 *   applied (PERIOD_CLOSED) and the closed-period trigger is never bypassed;
 *   one audit row holds every month before and after, with its vouchers.
 */
import { createHash } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";

import { propertyMonthlyLedger } from "@shared/schema";

import { db, type DatabaseOrTransaction, type DbTransaction } from "../../db";
import { findOrCreateLedgerAccount } from "../../routes/rental/shared/ledger";
import { writeAuditEvent } from "../audit";
import { postErpVoucherTx } from "../accounting/erpVoucherPosting";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import {
  derivePlanPart1,
  PREPAID_ACCOUNT_NAME,
  type PlanLine,
  type LegacyPrepaidRecognitionPlan,
} from "./derivePlanPart1";
export type { LegacyPrepaidPlanRow, LegacyPrepaidRecognitionPlan } from "./derivePlanPart1";

export const LEGACY_PREPAID_MESSAGES = {
  NOT_SHOP_RENTAL_MODULE: "The legacy prepaid rent recognition applies to the ERP and factory shop rentals only.",
  NOTHING_TO_APPLY: "There is no legacy prepaid rent month to recognise.",
  PLAN_CHANGED: "The legacy prepaid rent recognition changed since it was reviewed; review it again before applying.",
} as const;

export class LegacyPrepaidRefusal extends Error {
  constructor(readonly code: keyof typeof LEGACY_PREPAID_MESSAGES) {
    super(LEGACY_PREPAID_MESSAGES[code]);
    this.name = "LegacyPrepaidRefusal";
  }
  get status(): number {
    return this.code === "PLAN_CHANGED" ? 409 : 400;
  }
}

async function derivePlan(
  executor: DatabaseOrTransaction,
  companyId: number,
  module: string,
  expenseAccountName: string,
  lock: boolean
): Promise<LegacyPrepaidRecognitionPlan> {
  const { body } = await derivePlanPart1(executor, companyId, module, expenseAccountName, lock);
  const planHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return { ...body, planHash };
}

/** Read-only plan for the company and module. */
export function planLegacyPrepaidRecognition(
  companyId: number,
  module: string,
  expenseAccountName: string,
  executor: DatabaseOrTransaction = db
): Promise<LegacyPrepaidRecognitionPlan> {
  return derivePlan(executor, companyId, module, expenseAccountName, false);
}

/** Applies the reviewed plan for the company in one transaction, audited in it. */
export async function applyLegacyPrepaidRecognition(
  companyId: number,
  module: string,
  expenseAccountName: string,
  options: { planHash: string; actor: { userId: string; username: string } }
): Promise<LegacyPrepaidRecognitionPlan & { vouchers: Array<{ voucherNumber: string; voucherId: number }> }> {
  return db.transaction(async (tx: DbTransaction) => {
    await assertTransactionCompanyScope(tx, companyId);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('rental-legacy-prepaid-recognition'), ${companyId})`);
    const plan = await derivePlan(tx, companyId, module, expenseAccountName, true);
    if (plan.planHash !== options.planHash) throw new LegacyPrepaidRefusal("PLAN_CHANGED");
    if (plan.blockers.length) throw new LegacyPrepaidRefusal(plan.blockers[0]);

    // Created when missing only; an existing account is used as it is.
    const expenseId = await findOrCreateLedgerAccount(
      tx,
      companyId,
      expenseAccountName,
      "Indirect Expense",
      "SHOP-RENT-EXP"
    );
    const prepaidId = await findOrCreateLedgerAccount(tx, companyId, PREPAID_ACCOUNT_NAME, "Asset", "PREP-RENT");
    const accountId = (line: PlanLine) => (line.ledgerAccount === "PREPAID" ? prepaidId : expenseId);
    const posted: Array<{ voucherNumber: string; voucherId: number }> = [];

    for (const row of plan.rows) {
      const period = `${String(row.month).padStart(2, "0")}/${row.year}`;
      const sourceId = `${companyId}:${module}:${row.ledgerRowId}`;
      for (const reclass of row.reclassifications) {
        const narration = `Legacy prepaid rent reclassification - unit${row.unitId} - ${period}`;
        // Phase 22 (B): through the central engine; the reviewed plan's number is kept.
        const { voucher } = await postErpVoucherTx(tx, {
          companyId,
          voucherNumber: reclass.voucherNumber,
          voucherType: "Journal",
          voucherDate: reclass.voucherDate,
          description: narration,
          currency: row.currency,
          sourceModule: module,
          lines: reclass.lines.map((line) => ({
            ledgerAccountId: accountId(line),
            debit: line.debit,
            credit: line.credit,
            narration,
          })),
          source: { type: "rental-prepaid-repair", id: sourceId, revision: `reclass:${reclass.paymentId}` },
          actor: { userId: options.actor.userId, username: options.actor.username, reason: "Legacy prepaid repair" },
        });
        posted.push({ voucherNumber: reclass.voucherNumber, voucherId: voucher.id });
      }

      const narration = `Prepaid rent recognized - unit${row.unitId} - ${period}`;
      const { voucher: recognition } = await postErpVoucherTx(tx, {
        companyId,
        voucherNumber: row.recognition.voucherNumber,
        voucherType: "Journal",
        voucherDate: row.dueDate,
        description: narration,
        currency: row.currency,
        sourceModule: module,
        lines: row.recognition.lines.map((line) => ({
          ledgerAccountId: accountId(line),
          debit: line.debit,
          credit: line.credit,
          narration,
        })),
        source: { type: "rental-prepaid-repair", id: sourceId, revision: "recognition" },
        actor: { userId: options.actor.userId, username: options.actor.username, reason: "Legacy prepaid repair" },
      });
      posted.push({ voucherNumber: row.recognition.voucherNumber, voucherId: recognition.id });

      await tx
        .update(propertyMonthlyLedger)
        .set({ accrualVoucherId: recognition.id, usedPrepaidAccount: true, usedAdvanceAccount: false })
        .where(
          and(
            eq(propertyMonthlyLedger.id, row.ledgerRowId),
            eq(propertyMonthlyLedger.companyId, companyId),
            isNull(propertyMonthlyLedger.accrualVoucherId)
          )
        );
    }

    const voucherIdByNumber = new Map(posted.map((p) => [p.voucherNumber, p.voucherId]));
    await writeAuditEvent(
      {
        userId: options.actor.userId,
        username: options.actor.username,
        companyId,
        action: "update",
        tableName: "property_monthly_ledger",
        recordIdentifier: `rental-legacy-prepaid-recognition:${module}`,
        // entryRows and items keep every element (FULL_SNAPSHOT_AUDIT_FIELDS).
        changes: {
          entryRows: {
            old: plan.rows.map((row) => ({ id: row.ledgerRowId, ...row.before })),
            new: plan.rows.map((row) => ({
              id: row.ledgerRowId,
              accrualVoucherId: voucherIdByNumber.get(row.recognition.voucherNumber) ?? null,
              usedPrepaidAccount: true,
              usedAdvanceAccount: false,
            })),
          },
          items: {
            old: null,
            new: plan.rows.flatMap((row) =>
              [...row.reclassifications, row.recognition].map((voucher) => ({
                ...voucher,
                voucherId: voucherIdByNumber.get(voucher.voucherNumber) ?? null,
                ledgerRowId: row.ledgerRowId,
              }))
            ),
          },
          accounts: { new: { expenseId, prepaidId } },
          skipped: { new: plan.skipped },
          planHash: { new: plan.planHash },
        },
      },
      tx
    );
    return { ...plan, vouchers: posted };
  });
}

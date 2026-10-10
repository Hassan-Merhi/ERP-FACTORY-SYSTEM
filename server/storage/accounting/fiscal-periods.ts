import {
  infrastructurePostingIdentity,
  insertInfrastructureVoucherTx,
} from "../../services/accounting/infrastructureVoucherIdentity";
import Decimal from "decimal.js";
import { eq, and, desc, sql } from "drizzle-orm";
import { db, type DbTransaction } from "../../db";
import { softDeleteVoucherTx } from "../../services/accounting/voucherSoftDelete";
import * as schema from "@shared/schema";
import { CLOSED_PERIOD_LOCK_NAMESPACE } from "../../services/accounting/closedPeriodGuard";
import { accountTypeNamesOf, classifyAccountType } from "../../services/accounting/accountClassification";
import { signedMasterOpening } from "../../services/accounting/balances/openingSide";
import { writeAuditEvent } from "../../services/audit/auditService";

export class FiscalPeriodCloseError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400
  ) {
    super(message);
    this.name = "FiscalPeriodCloseError";
  }
}

function nextIsoDay(isoDate: string): string {
  const next = new Date(`${isoDate}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/**
 * A P&L account's opening, debit positive, on the engine's one sideless-opening
 * rule (wave 17 A): a sideless opening takes the usual side of the account
 * type (Cr for income, Dr for expenses). It used to default to Dr, so a
 * sideless income opening was closed on the wrong side.
 */
function signedOpening(accountType: string, openingBalance: string | null, side: string | null): Decimal {
  return new Decimal(signedMasterOpening("ledger", accountType, openingBalance, side).toFixed(2));
}

/**
 * Every income-statement account type the shared classifier knows (income and
 * expense: Income, Indirect Income, Revenue, Expense, Direct/Indirect Expense,
 * Government Taxes, ...), matched case-insensitively so a mis-cased type
 * ('EXPENSE') or the legacy "Revenue" is closed too.
 */
const profitAndLossTypesSql = () =>
  sql.join(
    accountTypeNamesOf("income", "expense").map((type) => sql`${type}`),
    sql`, `
  );

interface IncomeExpenseBalanceRow {
  id: number;
  name: string;
  account_type: string;
  opening_balance: string | null;
  opening_balance_side: string | null;
  deleted: boolean;
  activity: string;
}

/** The date an entry counts on: its effective date when set, else its voucher date (wave 12). */
const ACCOUNTING_DATE = sql`COALESCE(v.effective_date, v.voucher_date)`;

/**
 * Debit-positive balance of every Income/Expense account through a date, exact:
 * its opening plus every posted entry dated (effective date, else voucher date)
 * on or before it, earlier closing journals included. The closing line is the
 * opposite of this balance, so after the close every Income/Expense account is
 * exactly zero at the period end, whatever earlier closes did (wave 12: a close
 * no longer zeroes openings, which used to close an opening twice).
 */
async function incomeExpenseBalanceThroughTx(
  tx: DbTransaction,
  companyId: number,
  throughDate: string
): Promise<IncomeExpenseBalanceRow[]> {
  const result = await tx.execute(sql`
    SELECT la.id, la.name, la.account_type, la.opening_balance::text AS opening_balance, la.opening_balance_side,
           (la.deleted_at IS NOT NULL) AS deleted,
           COALESCE((
             SELECT SUM(ve.debit_amount::numeric - ve.credit_amount::numeric)
             FROM voucher_entries ve
             JOIN vouchers v ON v.id = ve.voucher_id
             WHERE ve.ledger_account_id = la.id
               AND v.company_id = ${companyId}
               AND v.optional = false
               AND v.deleted_at IS NULL
               AND ${ACCOUNTING_DATE} <= ${throughDate}
           ), 0)::text AS activity
    FROM ledger_accounts la
    WHERE la.company_id = ${companyId}
      AND LOWER(TRIM(la.account_type)) IN (${profitAndLossTypesSql()})
    ORDER BY la.id
  `);
  return result.rows as unknown as IncomeExpenseBalanceRow[];
}

/**
 * Debit-positive period activity of every Income/Expense account, exact, by
 * voucher date: used only to reconstruct the openings a legacy close (one
 * recorded before snapshots existed, which dated by voucher_date) zeroed.
 */
async function incomeExpenseActivityTx(
  tx: DbTransaction,
  companyId: number,
  periodStartDate: string,
  periodEndDate: string
): Promise<IncomeExpenseBalanceRow[]> {
  const result = await tx.execute(sql`
    SELECT la.id, la.name, la.account_type, la.opening_balance::text AS opening_balance, la.opening_balance_side,
           (la.deleted_at IS NOT NULL) AS deleted,
           COALESCE((
             SELECT SUM(ve.debit_amount::numeric - ve.credit_amount::numeric)
             FROM voucher_entries ve
             JOIN vouchers v ON v.id = ve.voucher_id
             WHERE ve.ledger_account_id = la.id
               AND v.company_id = ${companyId}
               AND v.optional = false
               AND v.deleted_at IS NULL
               AND v.voucher_date BETWEEN ${periodStartDate} AND ${periodEndDate}
           ), 0)::text AS activity
    FROM ledger_accounts la
    WHERE la.company_id = ${companyId}
      AND LOWER(TRIM(la.account_type)) IN (${profitAndLossTypesSql()})
    ORDER BY la.id
  `);
  return result.rows as unknown as IncomeExpenseBalanceRow[];
}

/**
 * Closes a fiscal period: one journal moves every Income/Expense balance at
 * the period end (opening plus every entry dated, by effective date else
 * voucher date, on or before periodEndDate, earlier closing journals included)
 * to retained earnings, so each account is exactly zero after the close and
 * retained earnings move by exactly the net profit closed. Openings are left
 * in place (wave 12; earlier closes also zeroed them, which closed an opening
 * twice). The closed-period guard then locks the books through periodEndDate,
 * and the opening-balance lock freezes every master opening.
 *
 * Periods must be contiguous: after a close, the next starts the following
 * day; the first close must start no later than the earliest posted
 * Income/Expense entry, or entries before it would be locked without ever
 * being closed. All amounts are exact decimals.
 *
 * Deleted Income/Expense accounts (wave 17 A): one with a zero balance at the
 * period end is skipped (a closing line on it would be refused as
 * LEDGER_ACCOUNT_DELETED); one that still carries a balance refuses the close
 * (409, listing each account and its balance), since closing only the live
 * accounts would leave that balance in a closed year. Restore the account (or
 * move its balance with a journal in the open period) and close again.
 *
 * The close writes its audit row (fiscal_period_closures, action "create") in
 * the same transaction, so a closure never exists without its audit.
 */
export async function closeFiscalPeriod(
  companyId: number,
  periodStartDate: string,
  periodEndDate: string,
  retainedEarningsAccountId: number,
  closedByUserId: string,
  notes?: string,
  actor?: { username: string }
): Promise<schema.FiscalPeriodClosure> {
  return await db.transaction(async (tx) => {
    // Exclusive per-company lock: voucher writes hold the shared side (see
    // closedPeriodGuard), so no write can land in the period while its
    // balances are being totalled and closed.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${CLOSED_PERIOD_LOCK_NAMESPACE}, ${companyId})`);

    const existingClosures = await tx
      .select()
      .from(schema.fiscalPeriodClosures)
      .where(eq(schema.fiscalPeriodClosures.companyId, companyId))
      .orderBy(desc(schema.fiscalPeriodClosures.periodEndDate));
    if (existingClosures.some((closure) => closure.periodEndDate === periodEndDate)) {
      throw new FiscalPeriodCloseError(`Fiscal period ending ${periodEndDate} has already been closed`, 409);
    }
    const latest = existingClosures[0];
    if (latest) {
      const expectedStart = nextIsoDay(String(latest.periodEndDate));
      if (periodStartDate !== expectedStart) {
        throw new FiscalPeriodCloseError(
          `The books are closed through ${latest.periodEndDate}; the next period must start on ${expectedStart}`
        );
      }
    } else {
      const earlier = await tx.execute(sql`
        SELECT MIN(${ACCOUNTING_DATE})::text AS earliest
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id
        JOIN ledger_accounts la ON la.id = ve.ledger_account_id
        WHERE v.company_id = ${companyId}
          AND v.optional = false
          AND v.deleted_at IS NULL
          AND ${ACCOUNTING_DATE} < ${periodStartDate}
          AND LOWER(TRIM(la.account_type)) IN (${profitAndLossTypesSql()})
      `);
      const earliest = (earlier.rows[0] as { earliest: string | null } | undefined)?.earliest;
      if (earliest) {
        throw new FiscalPeriodCloseError(
          `Income or expense entries exist from ${earliest}, before the period start. Start the first closed period on or before ${earliest}.`
        );
      }
    }

    const allAccounts = await incomeExpenseBalanceThroughTx(tx, companyId, periodEndDate);
    const balanceOf = (account: IncomeExpenseBalanceRow) =>
      signedOpening(account.account_type, account.opening_balance, account.opening_balance_side).plus(account.activity);
    const deletedWithBalance = allAccounts.filter((account) => account.deleted && !balanceOf(account).isZero());
    if (deletedWithBalance.length > 0) {
      const list = deletedWithBalance
        .map((account) => {
          const balance = balanceOf(account);
          return `${account.name} (#${account.id}): ${balance.abs().toFixed(2)} ${balance.isNegative() ? "Cr" : "Dr"}`;
        })
        .join("; ");
      throw new FiscalPeriodCloseError(
        `Deleted income or expense accounts still carry a balance at ${periodEndDate}: ${list}. Restore them or move their balance with a journal before closing.`,
        409
      );
    }
    // Deleted accounts with a zero balance need no closing line.
    const accounts = allAccounts.filter((account) => !account.deleted);
    if (accounts.length === 0) throw new FiscalPeriodCloseError("No Income or Expense accounts found for this company");

    interface ClosingLine {
      accountId: number;
      accountName: string;
      debit: Decimal;
      credit: Decimal;
    }
    const lines: ClosingLine[] = [];
    let totalIncome = new Decimal(0);
    let totalExpense = new Decimal(0);
    let netDebitBalance = new Decimal(0);

    for (const account of accounts) {
      // Debit-positive balance; the closing line posts its opposite.
      const balance = balanceOf(account);
      if (classifyAccountType(account.account_type) === "income") totalIncome = totalIncome.minus(balance);
      else totalExpense = totalExpense.plus(balance);
      netDebitBalance = netDebitBalance.plus(balance);
      if (balance.isZero()) continue;
      lines.push({
        accountId: account.id,
        accountName: account.name,
        debit: balance.isNegative() ? balance.negated() : new Decimal(0),
        credit: balance.isPositive() ? balance : new Decimal(0),
      });
    }
    const netIncome = totalIncome.minus(totalExpense);
    if (!netDebitBalance.isZero()) {
      // A net debit balance (loss) is cleared by debiting retained earnings.
      lines.push({
        accountId: retainedEarningsAccountId,
        accountName: "Retained Earnings",
        debit: netDebitBalance.isPositive() ? netDebitBalance : new Decimal(0),
        credit: netDebitBalance.isNegative() ? netDebitBalance.negated() : new Decimal(0),
      });
    }
    const voucherTotal = lines.reduce((sum, line) => sum.plus(line.debit), new Decimal(0));

    // A reopened period's earlier closing journal keeps its posting identity,
    // so each close of the same period gets its own attempt number.
    const attempts = await tx.execute(sql`
      SELECT COUNT(*)::int AS attempts FROM vouchers
      WHERE company_id = ${companyId} AND voucher_number LIKE ${`FISCAL-CLOSE-${periodEndDate}-%`}
    `);
    const attempt = Number((attempts.rows[0] as { attempts: number } | undefined)?.attempts ?? 0) + 1;

    const voucherNumber = `FISCAL-CLOSE-${periodEndDate}-${attempt}`;
    const { voucher: closingVoucher } = await insertInfrastructureVoucherTx(
      tx,
      {
        companyId,
        voucherNumber,
        voucherType: "Journal",
        voucherDate: periodEndDate,
        description: `Fiscal Period Close: ${periodStartDate} to ${periodEndDate}${notes ? ` - ${notes}` : ""}`,
        totalAmount: voucherTotal.toFixed(2),
        optional: false,
      },
      infrastructurePostingIdentity(
        "fiscal-period",
        `${companyId}:${periodStartDate}:${periodEndDate}`,
        `close-${attempt}`
      ),
      {
        retainedEarningsAccountId,
        lines: lines.map((line) => [line.accountId, line.debit.toFixed(2), line.credit.toFixed(2)]),
      }
    );

    if (lines.length > 0) {
      await tx.insert(schema.voucherEntries).values(
        lines.map((line) => ({
          voucherId: closingVoucher.id,
          ledgerAccountId: line.accountId,
          debitAmount: line.debit.toFixed(2),
          creditAmount: line.credit.toFixed(2),
          narration:
            line.accountId === retainedEarningsAccountId
              ? `${netIncome.isNegative() ? "Net Loss" : "Net Income"} for period ending ${periodEndDate}`
              : `Close ${line.accountName} for period ending ${periodEndDate}`,
        }))
      );
    }

    // Openings are left in place (wave 12): the closing line already includes
    // them, so zeroing them too closed each opening twice. An empty snapshot
    // records that this close changed no opening (null marks a legacy close).
    const openingSnapshot: schema.FiscalCloseOpeningBalance[] = [];

    const [closure] = await tx
      .insert(schema.fiscalPeriodClosures)
      .values({
        companyId,
        periodStartDate,
        periodEndDate,
        closedByUserId,
        closingVoucherId: closingVoucher.id,
        retainedEarningsAccountId,
        totalIncome: totalIncome.toFixed(2),
        totalExpense: totalExpense.toFixed(2),
        netIncome: netIncome.toFixed(2),
        status: "CLOSED",
        notes: notes || null,
        openingBalanceSnapshot: openingSnapshot,
      })
      .returning();

    await writeAuditEvent(
      {
        userId: closedByUserId,
        username: actor?.username || "unknown",
        companyId,
        action: "create",
        tableName: "fiscal_period_closures",
        recordId: closure.id,
        recordIdentifier: `${periodStartDate}..${periodEndDate}`,
        changes: {
          status: { old: null, new: "CLOSED" },
          closingVoucherId: { old: null, new: closingVoucher.id },
          voucherNumber: { old: null, new: voucherNumber },
          retainedEarningsAccountId: { old: null, new: retainedEarningsAccountId },
          totalIncome: { old: null, new: totalIncome.toFixed(2) },
          totalExpense: { old: null, new: totalExpense.toFixed(2) },
          netIncome: { old: null, new: netIncome.toFixed(2) },
        },
      },
      tx
    );

    return closure;
  });
}

/**
 * Reopens the most recent closed period: the closing journal is soft-deleted
 * (under the closed-period override, inside this transaction only), the
 * Income/Expense opening balances the close zeroed are restored, and the
 * closure is removed, which lifts the lock back to the previous close.
 * Closures made before snapshots existed get their opening balances
 * reconstructed from the closing journal minus the period's activity.
 */
export async function reopenFiscalPeriod(companyId: number, closureId: number): Promise<schema.FiscalPeriodClosure> {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${CLOSED_PERIOD_LOCK_NAMESPACE}, ${companyId})`);

    const closures = await tx
      .select()
      .from(schema.fiscalPeriodClosures)
      .where(eq(schema.fiscalPeriodClosures.companyId, companyId))
      .orderBy(desc(schema.fiscalPeriodClosures.periodEndDate));
    const closure = closures.find((candidate) => candidate.id === closureId);
    if (!closure) throw new FiscalPeriodCloseError("Fiscal period closure not found", 404);
    if (closures[0]?.id !== closure.id) {
      throw new FiscalPeriodCloseError(
        `Only the latest closed period can be reopened (ending ${closures[0]?.periodEndDate})`,
        409
      );
    }

    await tx.execute(sql`SELECT set_config('app.closed_period_override', 'on', true)`);

    let restore = closure.openingBalanceSnapshot ?? null;
    if (!restore) {
      // Legacy closure: opening = closing-line balance minus period activity.
      const closingLines = await tx
        .select()
        .from(schema.voucherEntries)
        .where(eq(schema.voucherEntries.voucherId, closure.closingVoucherId));
      const closedBalances = new Map<number, Decimal>();
      for (const line of closingLines) {
        if (!line.ledgerAccountId || line.ledgerAccountId === closure.retainedEarningsAccountId) continue;
        const balance = new Decimal(line.creditAmount || "0").minus(line.debitAmount || "0");
        closedBalances.set(
          line.ledgerAccountId,
          (closedBalances.get(line.ledgerAccountId) ?? new Decimal(0)).plus(balance)
        );
      }
      await softDeleteVoucherTx(tx, closure.closingVoucherId);
      const activity = await incomeExpenseActivityTx(
        tx,
        companyId,
        String(closure.periodStartDate),
        String(closure.periodEndDate)
      );
      restore = [];
      for (const account of activity) {
        const opening = (closedBalances.get(account.id) ?? new Decimal(0)).minus(account.activity);
        if (opening.isZero()) continue;
        restore.push({
          accountId: account.id,
          openingBalance: opening.abs().toFixed(2),
          openingBalanceSide: opening.isNegative() ? "Cr" : "Dr",
        });
      }
    } else {
      await softDeleteVoucherTx(tx, closure.closingVoucherId);
    }

    for (const entry of restore) {
      const [account] = await tx
        .select({ openingBalance: schema.ledgerAccounts.openingBalance })
        .from(schema.ledgerAccounts)
        .where(and(eq(schema.ledgerAccounts.id, entry.accountId), eq(schema.ledgerAccounts.companyId, companyId)))
        .for("update");
      if (!account) continue;
      if (!new Decimal(account.openingBalance || "0").isZero()) {
        throw new FiscalPeriodCloseError(
          `Account ${entry.accountId} has a new opening balance since the close; reopening would overwrite it`,
          409
        );
      }
      await tx
        .update(schema.ledgerAccounts)
        .set({ openingBalance: entry.openingBalance, openingBalanceSide: entry.openingBalanceSide })
        .where(eq(schema.ledgerAccounts.id, entry.accountId));
    }

    await tx.delete(schema.fiscalPeriodClosures).where(eq(schema.fiscalPeriodClosures.id, closure.id));
    return closure;
  });
}

export async function getFiscalPeriodClosures(companyId: number): Promise<schema.FiscalPeriodClosure[]> {
  return await db
    .select()
    .from(schema.fiscalPeriodClosures)
    .where(eq(schema.fiscalPeriodClosures.companyId, companyId))
    .orderBy(sql`${schema.fiscalPeriodClosures.periodEndDate} DESC`);
}

// ---------------------------------------------------------------------------
// Exchange Rates
// ---------------------------------------------------------------------------

/**
 * Owner-requested, journal-free reconciliation of HADI L'SHI prepaid rent.
 *
 * The live ERP Shops subledger at 2026-11-06 has two $3,500 future-rent
 * credits (contracts 24 and 27), but GL prepaid-rent account #1022 has a
 * $17,500 credit closing. The required *opening reclassification* is:
 *
 *   Dr opening Prepaid Rent (#1022)             $24,500
 *   Cr opening Rent Expense - ERP Shops (#1007) $24,500
 *
 * Both legs are opening balances, not journal vouchers. This preserves the
 * trial-balance debit/credit total and reduces overstated rent expense rather
 * than creating an unbalanced asset. No voucher, payment, rental monthly row,
 * cash/bank entry, or posted source is changed.
 *
 * OPT IN ONLY on the exact production service/database; guarded against
 * source changes, closed periods, FX metadata drift, and repeated execution.
 * Clears nothing from audit history.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../db";
import { logger } from "../lib/logger";
import { toMoney } from "../lib/money";
import { resultRows } from "../lib/queryResult";
import { logAudit } from "../routes/helpers/auditWriteAdapter";
import { getPartyBalance } from "../services/accounting/balances/ledgerBalanceEngine";
import { companyBusinessDate } from "../services/accounting/companyBusinessDate";
import { runInCompanyPostingScope } from "../services/accounting/scheduledPostingScope";

const ENV = "ERP_REPAIR_HADI_LSHI_PREPAID_OPENING_20261106";
const APPROVAL = "approved-company1-prepaid1022-balanced-opening24500";
const PRODUCTION_SERVICE = "srv-d6kibgtactks739u7vl0";
const PRODUCTION_DATABASE = "erp_db_qscj_64lv_e7rz_8744_2lm3";
const COMPANY = 1;
const PREPAID = 1022;
const EXPENSE = 1007;
const CORRECTION = "24500.00";
const TARGET = "7000.00";

type Account = {
  id: number;
  company_id: number;
  name: string;
  code: string;
  account_type: string;
  opening_balance: string;
  opening_balance_side: string | null;
  opening_balance_currency: string | null;
  opening_balance_base_amount: string | null;
  opening_balance_native_amount: string | null;
  opening_balance_historical_rate: string | null;
  active: boolean;
  deleted_at: string | null;
};
type Sum = { debit: string; credit: string };
type Position = { contract_id: number; unit_number: string; expected: string; paid: string };
function assert(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error("HADI_LSHI_PREPAID_OPENING_REFUSED_" + reason);
}
const money = (value: unknown) => toMoney(String(value ?? "0")).toFixed(2);

function verifyOpeningMetadata(a: Account, expected: string): void {
  assert(!a.opening_balance_currency || a.opening_balance_currency.toUpperCase() === "USD", "NON_USD_OPENING_" + a.id);
  assert(
    a.opening_balance_base_amount == null || money(a.opening_balance_base_amount) === expected,
    "FX_BASE_OPENING_DRIFT_" + a.id
  );
  assert(
    a.opening_balance_native_amount == null || money(a.opening_balance_native_amount) === expected,
    "FX_NATIVE_OPENING_DRIFT_" + a.id
  );
  assert(
    a.opening_balance_historical_rate == null || toMoney(a.opening_balance_historical_rate).eq(1),
    "FX_RATE_DRIFT_" + a.id
  );
}

export async function runApprovedHadiLshiPrepaidOpeningRepair(): Promise<void> {
  if (process.env[ENV] !== APPROVAL) return;
  assert(process.env.RENDER_SERVICE_ID === PRODUCTION_SERVICE, "WRONG_SERVICE");
  const database = await pool.query<{ name: string }>("SELECT current_database() AS name");
  assert(database.rows[0]?.name === PRODUCTION_DATABASE, "WRONG_DATABASE");

  const result = await runInCompanyPostingScope(
    COMPANY,
    () => db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('hadi-lshi-prepaid-opening-20261106'))`);
      const asOf = await companyBusinessDate(COMPANY, tx);
      // The source evidence is for November, after both November rents fell
      // due. On/after December 1 the credits change and require a new review.
      assert(asOf >= "2026-11-06" && asOf < "2026-12-01", "OUTSIDE_REVIEWED_PERIOD_" + asOf);

      const company = resultRows<{ id: number; name: string }>(await tx.execute(sql`
        SELECT id, name FROM companies WHERE id = ${COMPANY}
      `));
      assert(company.length === 1 && company[0].name === "HADI L'SHI", "COMPANY_CHANGED");

      const closing = resultRows<{ n: number }>(await tx.execute(sql`
        SELECT COUNT(*)::int AS n FROM fiscal_period_closures
        WHERE company_id = ${COMPANY} AND status = 'CLOSED'
      `));
      assert(closing[0]?.n === 0, "CLOSED_FISCAL_PERIOD");

      const accounts = resultRows<Account>(await tx.execute(sql`
        SELECT id, company_id, name, code, account_type,
          opening_balance::text, opening_balance_side,
          opening_balance_currency, opening_balance_base_amount::text,
          opening_balance_native_amount::text, opening_balance_historical_rate::text,
          active, deleted_at::text
        FROM ledger_accounts
        WHERE company_id = ${COMPANY} AND id IN (${PREPAID}, ${EXPENSE})
        ORDER BY id FOR UPDATE
      `));
      assert(accounts.length === 2, "ACCOUNTS_MISSING");
      const prepaid = accounts.find(a => a.id === PREPAID);
      const expense = accounts.find(a => a.id === EXPENSE);
      assert(prepaid && prepaid.company_id === COMPANY && prepaid.name === "Prepaid Rent" &&
        prepaid.code === "PREP-RENT-1780919085295" && prepaid.account_type === "Asset" &&
        prepaid.active && prepaid.deleted_at == null, "PREPAID_ACCOUNT_CHANGED");
      assert(expense && expense.company_id === COMPANY && expense.name === "Rent Expense - ERP Shops" &&
        expense.code === "SHOP-RENT-EXP-1780665075822" && expense.account_type === "Indirect Expense" &&
        expense.active && expense.deleted_at == null, "EXPENSE_ACCOUNT_CHANGED");

      const already =
        money(prepaid.opening_balance) === CORRECTION && prepaid.opening_balance_side === "Dr" &&
        money(expense.opening_balance) === "35000.00" && expense.opening_balance_side === "Cr";
      if (!already) {
        assert(
          money(prepaid.opening_balance) === "0.00" &&
          (prepaid.opening_balance_side == null || prepaid.opening_balance_side === "Dr") &&
          money(expense.opening_balance) === "10500.00" &&
          expense.opening_balance_side === "Cr",
          "OPENINGS_CHANGED"
        );
      }
      verifyOpeningMetadata(prepaid, already ? CORRECTION : "0.00");
      verifyOpeningMetadata(expense, already ? "35000.00" : "10500.00");

      const linked = resultRows<{ n: number }>(await tx.execute(sql`
        SELECT COUNT(*)::int AS n FROM customers WHERE company_id = ${COMPANY}
          AND ledger_account_id IN (${PREPAID}, ${EXPENSE}) AND deleted_at IS NULL
      `));
      assert(linked[0]?.n === 0, "CUSTOMER_LINKED_LEDGER");

      const sums = resultRows<Sum>(await tx.execute(sql`
        SELECT COALESCE(SUM(e.debit_amount),0)::text AS debit,
               COALESCE(SUM(e.credit_amount),0)::text AS credit
        FROM voucher_entries e
        JOIN vouchers v ON v.id = e.voucher_id AND v.company_id = ${COMPANY}
        WHERE e.company_id = ${COMPANY} AND e.ledger_account_id = ${PREPAID}
          AND v.deleted_at IS NULL AND v.optional = false
      `));
      assert(sums.length === 1 && money(sums[0].debit) === "67400.00" &&
        money(sums[0].credit) === "84900.00", "PREPAID_GL_ACTIVITY_CHANGED");

      const positions = resultRows<Position>(await tx.execute(sql`
        SELECT c.id AS contract_id, u.unit_number,
          COALESCE((
            SELECT SUM(m.expected_amount)
            FROM property_monthly_ledger m
            WHERE m.company_id = ${COMPANY} AND m.contract_id = c.id
              AND MAKE_DATE(m.year, m.month, LEAST(
                EXTRACT(DAY FROM c.start_date)::int,
                EXTRACT(DAY FROM (
                  DATE_TRUNC('month', MAKE_DATE(m.year, m.month, 1))
                  + INTERVAL '1 month - 1 day'
                ))::int
              )) <= ${asOf}::date
          ),0)::text AS expected,
          COALESCE((
            SELECT SUM(p.amount)
            FROM property_payments p
            WHERE p.company_id = ${COMPANY} AND p.contract_id = c.id
              AND p.posting_status = 'POSTED'
              AND p.ledger_row_id IS NOT NULL
              AND p.payment_date <= ${asOf}::date
          ),0)::text AS paid
        FROM property_contracts c
        JOIN property_units u ON u.id = c.unit_id AND u.company_id = ${COMPANY}
        WHERE c.company_id = ${COMPANY} AND c.module = 'ERP'
          AND c.status = 'ACTIVE' AND u.unit_type = 'SHOP' AND u.active = true
      `));
      const credits = positions
        .map(p => ({ ...p, credit: toMoney(p.paid).minus(toMoney(p.expected)) }))
        .filter(p => p.credit.gt(0));
      assert(credits.length === 2 && money(credits.reduce((sum,p) => sum.plus(p.credit),toMoney(0))) === TARGET &&
        credits.some(p => p.contract_id === 24 && p.unit_number === "HADI 2" && money(p.credit) === "3500.00") &&
        credits.some(p => p.contract_id === 27 && p.unit_number === "Hadi #4" && money(p.credit) === "3500.00"),
        "RENTAL_SUBLEDGER_CHANGED");

      const beforePrepaid = await getPartyBalance(tx, { companyId: COMPANY, kind: "ledger", id: PREPAID });
      const beforeExpense = await getPartyBalance(tx, { companyId: COMPANY, kind: "ledger", id: EXPENSE });
      assert(beforePrepaid && beforeExpense, "BALANCE_ENGINE_UNAVAILABLE");
      assert(
        money(beforePrepaid.closing) === (already ? TARGET : "-17500.00"),
        "LEDGER_BALANCE_UNEXPECTED"
      );

      if (!already) {
        const prepaidUpdated = resultRows<{ id: number }>(await tx.execute(sql`
          UPDATE ledger_accounts SET
            opening_balance = ${CORRECTION}::numeric, opening_balance_side = 'Dr',
            opening_balance_currency = 'USD', opening_balance_native_amount = ${CORRECTION}::numeric,
            opening_balance_base_amount = ${CORRECTION}::numeric, opening_balance_historical_rate = 1
          WHERE company_id = ${COMPANY} AND id = ${PREPAID} AND opening_balance = 0
            AND deleted_at IS NULL
          RETURNING id
        `));
        assert(prepaidUpdated.length === 1, "PREPAID_CONCURRENT_CHANGE");
        const expenseUpdated = resultRows<{ id: number }>(await tx.execute(sql`
          UPDATE ledger_accounts SET
            opening_balance = 35000, opening_balance_side = 'Cr',
            opening_balance_currency = 'USD', opening_balance_native_amount = 35000,
            opening_balance_base_amount = 35000, opening_balance_historical_rate = 1
          WHERE company_id = ${COMPANY} AND id = ${EXPENSE}
            AND opening_balance = 10500 AND opening_balance_side = 'Cr'
            AND deleted_at IS NULL
          RETURNING id
        `));
        assert(expenseUpdated.length === 1, "EXPENSE_CONCURRENT_CHANGE");
      }

      const afterPrepaid = await getPartyBalance(tx, { companyId: COMPANY, kind: "ledger", id: PREPAID });
      const afterExpense = await getPartyBalance(tx, { companyId: COMPANY, kind: "ledger", id: EXPENSE });
      assert(afterPrepaid && afterExpense && money(afterPrepaid.closing) === TARGET,
        "POST_RECONCILIATION_PREPAID_MISMATCH");
      assert(toMoney(afterPrepaid.closing).minus(toMoney(beforePrepaid.closing))
          .plus(toMoney(afterExpense.closing).minus(toMoney(beforeExpense.closing))).eq(0),
        "TRIAL_BALANCE_RECLASS_NOT_ZERO");
      if (!already) {
        const userId = "system:approved-hadi-lshi-prepaid-opening-20261106";
        await logAudit({
          userId, username: "system", companyId: COMPANY,
          action: "update", tableName: "ledger_accounts",
          recordId: PREPAID, recordIdentifier: "Prepaid Rent opening balance",
          changes: {
            openingBalance: { old: "0.00", new: CORRECTION },
            openingBalanceSide: { old: prepaid.opening_balance_side, new: "Dr" },
            openingBalanceCurrency: { old: prepaid.opening_balance_currency, new: "USD" },
            openingBalanceBaseAmount: { old: prepaid.opening_balance_base_amount, new: CORRECTION },
            openingBalanceNativeAmount: { old: prepaid.opening_balance_native_amount, new: CORRECTION },
          },
        }, tx);
        await logAudit({
          userId, username: "system", companyId: COMPANY,
          action: "update", tableName: "ledger_accounts",
          recordId: EXPENSE, recordIdentifier: "Rent Expense - ERP Shops opening balance",
          changes: {
            openingBalance: { old: "10500.00", new: "35000.00" },
            openingBalanceSide: { old: "Cr", new: "Cr" },
            openingBalanceCurrency: { old: expense.opening_balance_currency, new: "USD" },
            openingBalanceBaseAmount: { old: expense.opening_balance_base_amount, new: "35000.00" },
            openingBalanceNativeAmount: { old: expense.opening_balance_native_amount, new: "35000.00" },
          },
        }, tx);
      }
      return {
        state: already ? "already-applied" : "reconciled",
        prepaidOpening: CORRECTION,
        prepaidClosing: money(afterPrepaid.closing),
        expenseOpeningCredit: "35000.00",
        adjustment: CORRECTION,
        journalCountCreated: 0,
      };
    }),
    "approved-hadi-lshi-prepaid-opening-20261106"
  );
  logger.info("[HadiLshiPrepaidOpeningRepair] Audited balanced opening reconciliation", result);
}

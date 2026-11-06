/**
 * One-time, voucher-free consolidation of HADI L'SHI's two ERP rent expenses.
 *
 * #881: Rent Expense Lubumbashi - ERP Shops ($3,500 Cr opening, $0 net lines).
 * #1007: Rent Expense - ERP Shops ($31,500 Cr opening).
 *
 * Transfer ONLY #881's $3,500 opening to #1007 ($35,000 Cr). Archive #881
 * by marking it inactive and hidden, with a zero opening, retaining the
 * untouched 54 posted voucher lines for audit. The read layer includes them
 * in #1007's statement once #881 is retired. No existing posted voucher,
 * voucher_entry, payment, cash, contract, or fiscal period is changed.
 *
 * Production-only, opt-in, company-scoped, ledger-fingerprint checked,
 * all-or-nothing, audited and idempotent. Clear the env flag after application.
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

const ENV = "ERP_MERGE_HADI_ERP_RENT_EXPENSE_20261106";
const APPROVAL = "approved-company1-rent1007-archive881-3500opening";
const SERVICE_ID = "srv-d6kibgtactks739u7vl0";
const DATABASE_NAME = "erp_db_qscj_64lv_e7rz_8744_2lm3";
const COMPANY = 1;
const LEGACY = 881;
const SURVIVOR = 1007;

type Account = {
  id: number; company_id: number; name: string; code: string;
  account_type: string; parent_id: number | null; active: boolean;
  is_hidden: boolean; deleted_at: string | null; opening_balance: string;
  opening_balance_side: string | null; opening_balance_currency: string | null;
  opening_balance_native_amount: string | null; opening_balance_base_amount: string | null;
  opening_balance_historical_rate: string | null;
};
type Totals = { ledger_account_id: number; n: string; debits: string; credits: string };
// Internal guard codes are machine-readable audit identifiers, not UI prose.
class HadiRentExpenseMergeRefusal extends Error {
  constructor(code: string) {
    super(code);
    this.name = "HadiRentExpenseMergeRefusal";
  }
}
function assert(ok: unknown, code: string): asserts ok {
  if (!ok) throw new HadiRentExpenseMergeRefusal(code);
}
const money = (value: unknown) => toMoney(String(value ?? "0")).toFixed(2);

export async function runApprovedHadiRentExpenseConsolidation(): Promise<void> {
  if (process.env[ENV] !== APPROVAL) return;
  assert(process.env.RENDER_SERVICE_ID === SERVICE_ID, "WRONG_SERVICE");
  const database = await pool.query<{ name: string }>("SELECT current_database() AS name");
  assert(database.rows[0]?.name === DATABASE_NAME, "WRONG_DATABASE");

  const result = await runInCompanyPostingScope(
    COMPANY,
    () => db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('hadi-rent-expense-merge-20261106'))`);
      const date = await companyBusinessDate(COMPANY, tx);
      assert(date >= "2026-11-06" && date < "2026-12-01", "DATE_NOT_REVIEWED");

      const [company] = resultRows<{ name: string }>(await tx.execute(sql`
        SELECT name FROM companies WHERE id = ${COMPANY}
      `));
      assert(company?.name === "HADI L'SHI", "COMPANY_CHANGED");

      const [closures] = resultRows<{ n: number }>(await tx.execute(sql`
        SELECT COUNT(*)::int AS n FROM fiscal_period_closures
        WHERE company_id = ${COMPANY} AND status = 'CLOSED'
      `));
      assert(closures?.n === 0, "CLOSED_PERIOD");

      const accounts = resultRows<Account>(await tx.execute(sql`
        SELECT id, company_id, name, code, account_type, parent_id,
               active, is_hidden, deleted_at::text, opening_balance::text,
               opening_balance_side, opening_balance_currency,
               opening_balance_native_amount::text,
               opening_balance_base_amount::text, opening_balance_historical_rate::text
        FROM ledger_accounts
        WHERE company_id = ${COMPANY} AND id IN (${LEGACY}, ${SURVIVOR})
        ORDER BY id FOR UPDATE
      `));
      assert(accounts.length === 2, "ACCOUNT_COUNT_CHANGED");
      const legacy = accounts.find(a => a.id === LEGACY);
      const survivor = accounts.find(a => a.id === SURVIVOR);
      assert(legacy && survivor, "ACCOUNT_MISSING");
      assert(legacy.company_id === COMPANY && survivor.company_id === COMPANY &&
        legacy.name === "Rent Expense Lubumbashi - ERP Shops" &&
        legacy.code === "SHOP-RENT-EXP-1776937964214" &&
        survivor.name === "Rent Expense - ERP Shops" &&
        survivor.code === "SHOP-RENT-EXP-1780665075822" &&
        legacy.account_type === "Indirect Expense" &&
        survivor.account_type === "Indirect Expense" &&
        legacy.parent_id === 3304 && survivor.parent_id === 3304 &&
        legacy.deleted_at === null && survivor.deleted_at === null &&
        survivor.active && !survivor.is_hidden, "ACCOUNT_IDENTITY_CHANGED");

      const applied =
        !legacy.active && legacy.is_hidden && money(legacy.opening_balance) === "0.00" &&
        survivor.active && !survivor.is_hidden &&
        survivor.opening_balance_side === "Cr" &&
        money(survivor.opening_balance) === "35000.00";
      if (!applied) {
        assert(legacy.active && !legacy.is_hidden &&
          money(legacy.opening_balance) === "3500.00" &&
          legacy.opening_balance_side === "Cr" &&
          money(survivor.opening_balance) === "31500.00" &&
          survivor.opening_balance_side === "Cr", "OPENINGS_OR_STATE_CHANGED");
      }

      for (const account of accounts) {
        const amount = money(account.opening_balance);
        assert(account.opening_balance_currency === "USD" &&
          money(account.opening_balance_native_amount) === amount &&
          money(account.opening_balance_base_amount) === amount &&
          toMoney(account.opening_balance_historical_rate).eq(1),
          "CURRENCY_OPENING_MISMATCH_" + account.id);
      }

      const [refs] = resultRows<{ n: number }>(await tx.execute(sql`
        SELECT (
          (SELECT COUNT(*) FROM customers WHERE company_id = ${COMPANY} AND ledger_account_id = ${LEGACY}) +
          (SELECT COUNT(*) FROM suppliers WHERE company_id = ${COMPANY} AND ledger_account_id = ${LEGACY}) +
          (SELECT COUNT(*) FROM cost_center_auto_rules WHERE company_id = ${COMPANY} AND ledger_account_id = ${LEGACY}) +
          (SELECT COUNT(*) FROM ledger_accounts WHERE company_id = ${COMPANY} AND parent_id = ${LEGACY}) +
          (SELECT COUNT(*) FROM customer_order_charges WHERE ledger_account_id = ${LEGACY}) +
          (SELECT COUNT(*) FROM factory_account_whatsapp_rules WHERE ledger_account_id = ${LEGACY})
        )::int AS n
      `));
      assert(refs?.n === 0, "SOURCE_USED_BY_OTHER_MASTERS");

      // Verify the exact original historic evidence, without modifying it.
      const totals = resultRows<Totals>(await tx.execute(sql`
        SELECT e.ledger_account_id, COUNT(*)::text AS n,
               COALESCE(SUM(e.debit_amount),0)::text AS debits,
               COALESCE(SUM(e.credit_amount),0)::text AS credits
        FROM voucher_entries e
        JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=${COMPANY}
        WHERE e.company_id=${COMPANY} AND e.ledger_account_id IN (${LEGACY},${SURVIVOR})
          AND v.deleted_at IS NULL AND v.optional=false
        GROUP BY e.ledger_account_id ORDER BY e.ledger_account_id
      `));
      const old = totals.find(t => t.ledger_account_id === LEGACY);
      const target = totals.find(t => t.ledger_account_id === SURVIVOR);
      assert(old && target && old.n === "54" &&
        money(old.debits) === "323750.00" && money(old.credits) === "323750.00" &&
        target.n === "141" && money(target.debits) === "611600.00" &&
        money(target.credits) === "142250.00", "POSTED_HISTORY_CHANGED");

      const beforeLegacy = await getPartyBalance(tx, { companyId: COMPANY, kind: "ledger", id: LEGACY });
      const beforeSurvivor = await getPartyBalance(tx, { companyId: COMPANY, kind: "ledger", id: SURVIVOR });
      assert(beforeLegacy && beforeSurvivor &&
        money(beforeLegacy.closing) === (applied ? "0.00" : "-3500.00") &&
        money(beforeSurvivor.closing) === (applied ? "434350.00" : "437850.00"),
        "ENGINE_BASELINE_CHANGED");

      if (!applied) {
        const [updated] = resultRows<{ id: number }>(await tx.execute(sql`
          UPDATE ledger_accounts SET opening_balance=35000,
            opening_balance_side='Cr', opening_balance_currency='USD',
            opening_balance_base_amount=35000, opening_balance_native_amount=35000,
            opening_balance_historical_rate=1
          WHERE company_id=${COMPANY} AND id=${SURVIVOR} AND opening_balance=31500
            AND active=true AND is_hidden=false AND deleted_at IS NULL
          RETURNING id
        `));
        assert(updated?.id === SURVIVOR, "SURVIVOR_CONCURRENT_CHANGE");

        const [retired] = resultRows<{ id: number }>(await tx.execute(sql`
          UPDATE ledger_accounts SET opening_balance=0,
            opening_balance_side='Cr', opening_balance_currency='USD',
            opening_balance_base_amount=0, opening_balance_native_amount=0,
            opening_balance_historical_rate=1, active=false, is_hidden=true
          WHERE company_id=${COMPANY} AND id=${LEGACY}
            AND opening_balance=3500 AND active=true AND is_hidden=false
            AND deleted_at IS NULL
          RETURNING id
        `));
        assert(retired?.id === LEGACY, "LEGACY_CONCURRENT_CHANGE");
      }

      const afterLegacy = await getPartyBalance(tx, { companyId: COMPANY, kind: "ledger", id: LEGACY });
      const afterSurvivor = await getPartyBalance(tx, { companyId: COMPANY, kind: "ledger", id: SURVIVOR });
      assert(afterLegacy && afterSurvivor &&
        money(afterLegacy.closing) === "0.00" &&
        money(afterSurvivor.closing) === "434350.00" &&
        toMoney(beforeLegacy.closing).plus(toMoney(beforeSurvivor.closing))
          .eq(toMoney(afterLegacy.closing).plus(toMoney(afterSurvivor.closing))),
        "POST_MERGE_BALANCE_MISMATCH");

      if (!applied) {
        const userId = "system:hadi-rent-expense-merge-20261106";
        await logAudit({
          userId, username: "system", companyId: COMPANY,
          action: "update", tableName: "ledger_accounts",
          recordId: SURVIVOR, recordIdentifier: survivor.name,
          changes: {
            openingBalance: { old: "31500.00", new: "35000.00" },
            openingBalanceSide: { old: "Cr", new: "Cr" },
          },
        }, tx);
        await logAudit({
          userId, username: "system", companyId: COMPANY,
          action: "update", tableName: "ledger_accounts",
          recordId: LEGACY, recordIdentifier: legacy.name,
          changes: {
            openingBalance: { old: "3500.00", new: "0.00" },
            openingBalanceSide: { old: "Cr", new: "Cr" },
            active: { old: true, new: false },
            isHidden: { old: false, new: true },
          },
        }, tx);
      }
      return {
        state: applied ? "already-merged" : "merged",
        accountId: SURVIVOR,
        survivorOpeningCredit: "35000.00",
        sourceArchived: true,
        historicEntriesUnchanged: 195,
        closingDebit: money(afterSurvivor.closing),
        vouchersCreated: 0,
      };
    }),
    "hadi-rent-expense-merge-20261106"
  );
  logger.info("[HadiRentExpenseConsolidation] Audited ledger consolidation", result);
}

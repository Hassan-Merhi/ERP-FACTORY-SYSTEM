/**
 * Owner-approved correction for HADI L'SHI employee Zakaria El Ali (#103).
 *
 * His $9,930.12 opening balance was entered on the Debit side, while Payroll
 * correctly carried it as a Credit. Make only that existing opening's side Cr;
 * never create vouchers, alter payment amounts, or rewrite the cached balance.
 *
 * This is strictly production-database/employee scoped, transactionally audited,
 * and idempotent: once Cr, it makes no further changes on later starts.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../db";
import { logger } from "../lib/logger";
import { resultRows } from "../lib/queryResult";
import { toMoney } from "../lib/money";
import { logAudit } from "../routes/helpers/auditHelpers";
import { getPartyBalance } from "../services/accounting/balances/ledgerBalanceEngine";
import { runInCompanyPostingScope } from "../services/accounting/scheduledPostingScope";

const PRODUCTION_SERVICE = "srv-d6kibgtactks739u7vl0";
const PRODUCTION_DATABASE = "erp_db_qscj_64lv_e7rz_8744_2lm3";
const COMPANY_ID = 1;
const EMPLOYEE_ID = 103;
const OPENING = "9930.12";

type EmployeeRow = {
  id: number;
  companyId: number;
  code: string;
  firstName: string;
  lastName: string;
  opening: string;
  side: string | null;
  cached: string;
};
type PostedSums = { debits: string; credits: string };

export async function applyApprovedZakariaOpeningCredit(): Promise<void> {
  // A different Render service or a local development server must never
  // apply this production-specific accounting correction.
  if (process.env.RENDER_SERVICE_ID !== PRODUCTION_SERVICE) return;

  const database = await pool.query<{ name: string }>("SELECT current_database() AS name");
  if (database.rows[0]?.name !== PRODUCTION_DATABASE) {
    throw new Error("ZAKARIA_OPENING_CORRECTION_WRONG_DATABASE");
  }

  const result = await runInCompanyPostingScope(COMPANY_ID, () =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(84023, ${COMPANY_ID})`);

      const [row] = resultRows<EmployeeRow>(await tx.execute(sql`
        SELECT id, company_id AS "companyId", code,
               first_name AS "firstName", last_name AS "lastName",
               opening_balance::text AS opening,
               opening_balance_side AS side,
               current_balance::text AS cached
          FROM employees
         WHERE company_id = ${COMPANY_ID} AND id = ${EMPLOYEE_ID}
           AND deleted_at IS NULL
         FOR UPDATE
      `));

      if (!row || row.companyId !== COMPANY_ID || row.id !== EMPLOYEE_ID ||
          row.firstName !== "Zakaria" || row.lastName !== "El Ali" ||
          row.code.trim() !== "ZAKEL" || !toMoney(row.opening).eq(OPENING)) {
        throw new Error("ZAKARIA_OPENING_CORRECTION_UNEXPECTED_EMPLOYEE");
      }

      if (row.side === "Cr") {
        return { state: "already-credit", opening: OPENING, cached: row.cached };
      }
      if (row.side !== "Dr") {
        throw new Error("ZAKARIA_OPENING_CORRECTION_UNEXPECTED_SIDE");
      }

      // Confirm that the proposed Cr opening actually reconciles to the
      // already-stored Payroll amount, using live, non-optional postings owned
      // by this employee (the same ownership as the accounting balance engine).
      const [posted] = resultRows<PostedSums>(await tx.execute(sql`
        SELECT COALESCE(SUM(ve.debit_amount),0)::text AS debits,
               COALESCE(SUM(ve.credit_amount),0)::text AS credits
          FROM voucher_entries ve
          JOIN vouchers v ON v.id = ve.voucher_id
         WHERE v.company_id = ${COMPANY_ID} AND v.deleted_at IS NULL
           AND v.optional = false AND ve.employee_id = ${EMPLOYEE_ID}
           AND ve.ledger_account_id IS NULL
           AND ve.bank_account_id IS NULL
           AND ve.fixed_asset_id IS NULL
           AND ve.supplier_id IS NULL
      `));
      const expectedCredit = toMoney(OPENING)
        .plus(toMoney(posted?.credits))
        .minus(toMoney(posted?.debits));

      if (!expectedCredit.eq(toMoney(row.cached))) {
        throw new Error("ZAKARIA_OPENING_CORRECTION_CACHED_LEDGER_MISMATCH");
      }

      const updated = resultRows<{ id: number }>(await tx.execute(sql`
        UPDATE employees
           SET opening_balance_side = 'Cr'
         WHERE id = ${EMPLOYEE_ID} AND company_id = ${COMPANY_ID}
           AND opening_balance = ${OPENING}::numeric
           AND opening_balance_side = 'Dr'
         RETURNING id
      `));
      if (updated.length !== 1) {
        throw new Error("ZAKARIA_OPENING_CORRECTION_CONCURRENT_CHANGE");
      }

      const ledger = await getPartyBalance(tx, {
        companyId: COMPANY_ID, kind: "employee", id: EMPLOYEE_ID,
      });
      if (!ledger || !toMoney(ledger.closing).negated().eq(expectedCredit)) {
        throw new Error("ZAKARIA_OPENING_CORRECTION_LEDGER_DID_NOT_RECONCILE");
      }

      await logAudit({
        userId: "system:approved-zakaria-opening-credit-20261102",
        username: "system",
        companyId: COMPANY_ID,
        action: "update",
        tableName: "employees",
        recordId: EMPLOYEE_ID,
        recordIdentifier: "Zakaria El Ali (ZAKEL) opening balance direction",
        changes: {
          openingBalanceSide: { old: "Dr", new: "Cr" },
          openingBalance: { old: OPENING, new: OPENING },
          currentBalance: { old: row.cached, new: row.cached },
        },
      }, tx);

      return { state: "corrected-to-credit", opening: OPENING, payrollAndLedger: expectedCredit.toFixed(2) };
    }),
    "approved-zakaria-opening-credit-20261102"
  );

  logger.info("[startup] Zakaria employee opening side reconciliation", result);
}

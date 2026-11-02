/**
 * Owner-authorized reconciliation of historical signed employee openings.
 *
 * The original ERP import convention was positive = credit and negative =
 * debit. Ten surviving legacy employee masters have positive openings but a
 * mistakenly defaulted 'Dr' side. Zakaria El Ali (#103) was already repaired
 * separately. This applies exact, audited, one-time side corrections only to
 * the remaining confirmed historical records in HADI L'SHI and HMD KINSHASA.
 *
 * No amount, voucher, payroll cache or other master row is rewritten.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../db";
import { logger } from "../lib/logger";
import { toMoney } from "../lib/money";
import { resultRows } from "../lib/queryResult";
import { logAudit } from "../routes/helpers/auditHelpers";
import { getPartyBalance } from "../services/accounting/balances/ledgerBalanceEngine";
import { runInCompanyPostingScope } from "../services/accounting/scheduledPostingScope";

const EXPECTED_SERVICE = "srv-d6kibgtactks739u7vl0";
const EXPECTED_DATABASE = "erp_db_qscj_64lv_e7rz_8744_2lm3";

type Expected = { id: number; code: string; opening: string };
const TARGETS: ReadonlyArray<{ companyId: number; employees: ReadonlyArray<Expected> }> = [
  {
    companyId: 1, // HADI L'SHI
    employees: [
      { id: 95, code: "ABDDAK", opening: "122358.99" },
      { id: 96, code: "ALIMOU", opening: "10257.62" },
      { id: 97, code: "BASABD", opening: "6083.39" },
      { id: 98, code: "HASMER", opening: "5645.50" },
      { id: 99, code: "HUSRAJ", opening: "3443.00" },
      { id: 100, code: "MOHZNE", opening: "160.00" },
      { id: 101, code: "WISALA", opening: "20135.13" },
    ],
  },
  {
    companyId: 8, // HMD KINSHASA
    employees: [
      { id: 92, code: "MOHEL", opening: "5778.00" },
      { id: 93, code: "MOHSHB", opening: "17350.00" },
      { id: 94, code: "MOUSOW", opening: "2641.25" },
    ],
  },
];

type Row = { id: number; code: string; opening: string; side: string | null; cached: string };
type Sums = { debits: string; credits: string };

export async function applyApprovedEmployeeOpeningCredits(): Promise<void> {
  if (process.env.RENDER_SERVICE_ID !== EXPECTED_SERVICE) return;
  const [database] = (await pool.query<{ name: string }>("SELECT current_database() AS name")).rows;
  if (database?.name !== EXPECTED_DATABASE) {
    logger.warn("[startup] Historical employee opening correction skipped: unexpected database");
    return;
  }

  for (const { companyId, employees } of TARGETS) {
    const result = await runInCompanyPostingScope(companyId, () => db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(84024, ${companyId})`);
      const corrected: number[] = [];
      const alreadyCorrect: number[] = [];
      const skipped: number[] = [];
      const cachedDifferences: Array<{ id: number; cached: string; actual: string }> = [];

      for (const expected of employees) {
        const [row] = resultRows<Row>(await tx.execute(sql`
          SELECT id, code, opening_balance::text AS opening,
                 opening_balance_side AS side, current_balance::text AS cached
          FROM employees
          WHERE company_id = ${companyId} AND id = ${expected.id}
            AND deleted_at IS NULL
          FOR UPDATE
        `));
        if (!row || row.id !== expected.id || row.code.trim() !== expected.code ||
            !toMoney(row.opening).eq(expected.opening) || toMoney(row.opening).lte(0) ||
            !["Dr", "Cr"].includes(String(row.side))) {
          // Stop short of changing unexpected historical records. Report to
          // the administrator for individual investigation instead.
          skipped.push(expected.id);
          continue;
        }
        if (row.side === "Cr") {
          alreadyCorrect.push(expected.id);
          continue;
        }

        // The ledger is the sole balance source. Validate the result of the
        // opening flip against the actual surviving, employee-owned vouchers.
        const [sums] = resultRows<Sums>(await tx.execute(sql`
          SELECT COALESCE(SUM(ve.debit_amount),0)::text AS debits,
                 COALESCE(SUM(ve.credit_amount),0)::text AS credits
          FROM voucher_entries ve
          JOIN vouchers v ON v.id = ve.voucher_id
          WHERE v.company_id = ${companyId}
            AND v.deleted_at IS NULL AND v.optional = false
            AND ve.employee_id = ${expected.id}
            AND ve.ledger_account_id IS NULL
            AND ve.bank_account_id IS NULL
            AND ve.fixed_asset_id IS NULL
            AND ve.supplier_id IS NULL
        `));
        const correctCredit = toMoney(row.opening)
          .plus(toMoney(sums?.credits)).minus(toMoney(sums?.debits));

        const updated = resultRows<{ id: number }>(await tx.execute(sql`
          UPDATE employees SET opening_balance_side = 'Cr'
          WHERE company_id = ${companyId} AND id = ${expected.id}
            AND opening_balance = ${expected.opening}::numeric
            AND opening_balance_side = 'Dr'
          RETURNING id
        `));
        if (updated.length !== 1) {
          throw new Error(`EMPLOYEE_OPENING_CREDIT_CONCURRENT_CHANGE_${companyId}_${expected.id}`);
        }

        const party = await getPartyBalance(tx, {
          companyId, kind: "employee", id: expected.id,
        });
        if (!party || !toMoney(party.closing).negated().eq(correctCredit)) {
          throw new Error(`EMPLOYEE_OPENING_CREDIT_RECONCILIATION_FAILED_${companyId}_${expected.id}`);
        }

        await logAudit({
          userId: "system:approved-signed-employee-openings-20261102",
          username: "system",
          companyId,
          action: "update",
          tableName: "employees",
          recordId: expected.id,
          recordIdentifier: `Employee #${expected.id} (${expected.code}) opening direction`,
          changes: {
            openingBalanceSide: { old: "Dr", new: "Cr" },
            openingBalance: { old: row.opening, new: row.opening },
            employeeCreditBalance: { old: row.cached, new: correctCredit.toFixed(2) },
          },
        }, tx);
        corrected.push(expected.id);
        if (!toMoney(row.cached).eq(correctCredit)) {
          cachedDifferences.push({
            id: expected.id, cached: row.cached,
            actual: correctCredit.toFixed(2),
          });
        }
      }
      return { companyId, corrected, alreadyCorrect, skipped, cachedDifferences };
    }), "approved-historical-signed-employee-openings-20261102");

    if (result.skipped.length || result.cachedDifferences.length) {
      logger.warn("[startup] Historical employee opening audit exceptions", result);
    } else {
      logger.info("[startup] Historical employee opening credit correction", result);
    }
  }
}

/**
 * Owner-authorized backend-only reconciliation for HMD Beirut's Family Apartment.
 *
 * The $15,000 rent payment dated 2026-07-13 was fully expensed by legacy posting.
 * November and December 2026 ($2,500 each, due on the 15th) were not moved to
 * Prepaid Rent. The Factory Shop Rentals subledger therefore shows $29,566.66
 * credit while Prepaid Rent GL shows $24,566.66 as of 2026-11-03.
 *
 * Post one properly audited reclassification without changing the receipt,
 * tenant payments, guarantees or existing historical vouchers. Mark those two
 * existing month rows for normal recognition on their future billing dates.
 *
 * Disabled by default, gated to the production service and database, with
 * exact source/ledger before-images and an idempotent posting identity.
 */
import { sql } from "drizzle-orm";
import { db, pool, type DbTransaction } from "../db";
import { logger } from "../lib/logger";
import { toMoney } from "../lib/money";
import { postErpVoucherTx } from "../services/accounting/erpVoucherPosting";
import { runAsSystemAuditActor, runWithAuditReason } from "../services/audit/auditActorContext";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../services/security/databaseScopeRuntimeContext";
import {
  runCorrectionPart1,
  COMPANY,
  CONTRACT,
  EXPENSE_ACCOUNT,
  VOUCHER_NUMBER,
  num,
  money,
  requireMatch,
  type Row,
} from "./runCorrectionPart1";

const ENV = "ERP_REPAIR_HADI_PREPAID_20261103";
const ENABLE = "approved-hmd12-hadi34-5000";
const PRODUCTION_SERVICE = "srv-d6kibgtactks739u7vl0";
const PRODUCTION_DATABASE = "erp_db_qscj_64lv_e7rz_8744_2lm3";
const PREPAID_ACCOUNT = 2202;
const REPAIR_AMOUNT = "5000.00";

async function glBalance(tx: DbTransaction, accountId: number): Promise<string> {
  const rows = (
    await tx.execute(sql`
    SELECT COALESCE(la.opening_balance, 0) +
      COALESCE((
        SELECT SUM(e.debit_amount - e.credit_amount)
        FROM voucher_entries e
        JOIN vouchers v ON v.id = e.voucher_id AND v.company_id = ${COMPANY}
        WHERE e.company_id = ${COMPANY}
          AND e.ledger_account_id = ${accountId}
          AND v.deleted_at IS NULL AND v.optional = FALSE
      ), 0) AS balance
    FROM ledger_accounts la
    WHERE la.company_id = ${COMPANY} AND la.id = ${accountId}
      AND la.deleted_at IS NULL AND la.active = TRUE
  `)
  ).rows as Row[];
  requireMatch(rows.length === 1, "GL_ACCOUNT_MISSING_" + accountId);
  return money(rows[0].balance);
}

async function shopRentCredit(tx: DbTransaction, asOf: string): Promise<{ credit: string; contracts: number }> {
  // Identical cut-off semantics to the rental units API: billing day of the
  // contract, POSTED rent allocations only, and nonnegative per-contract credit.
  const rows = (
    await tx.execute(sql`
    SELECT COUNT(*)::int AS contracts,
      COALESCE(SUM(GREATEST(0, b.paid - b.expected)), 0) AS credit
    FROM (
      SELECT c.id,
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
        ), 0) AS expected,
        COALESCE((
          SELECT SUM(p.amount)
          FROM property_payments p
          WHERE p.company_id = ${COMPANY}
            AND p.contract_id = c.id
            AND p.posting_status = 'POSTED'
            AND p.payment_date <= ${asOf}::date
            AND p.ledger_row_id IS NOT NULL
        ), 0) AS paid
      FROM property_units u
      JOIN property_contracts c ON c.unit_id = u.id
      WHERE u.company_id = ${COMPANY} AND u.module = 'FACTORY'
        AND u.unit_type = 'SHOP' AND u.active = TRUE
        AND c.company_id = ${COMPANY} AND c.module = 'FACTORY'
        AND c.status = 'ACTIVE'
    ) b
  `)
  ).rows as Row[];
  return { credit: money(rows[0]?.credit), contracts: num(rows[0]?.contracts) };
}

async function runCorrection(tx: DbTransaction): Promise<{ applied: boolean; voucherId: number; prepaid: string }> {
  const { asOf, months, priorRepair } = await runCorrectionPart1(tx);
  if (priorRepair.length) {
    requireMatch(
      priorRepair.length === 2 &&
        priorRepair.every(
          (r) => r.deleted_at == null && r.optional === false && r.voucher_type === "Journal" && r.currency === "USD"
        ) &&
        priorRepair.some(
          (r) =>
            num(r.ledger_account_id) === PREPAID_ACCOUNT &&
            money(r.debit_amount) === REPAIR_AMOUNT &&
            money(r.credit_amount) === "0.00"
        ) &&
        priorRepair.some(
          (r) =>
            num(r.ledger_account_id) === EXPENSE_ACCOUNT &&
            money(r.debit_amount) === "0.00" &&
            money(r.credit_amount) === REPAIR_AMOUNT
        ) &&
        months.every((m) => m.used_prepaid_account === true),
      "PREVIOUS_REPAIR_INCONSISTENT"
    );
    return { applied: false, voucherId: num(priorRepair[0].id), prepaid: await glBalance(tx, PREPAID_ACCOUNT) };
  }

  requireMatch(asOf >= "2026-11-03" && asOf < "2026-11-15", "CUTOFF_CHANGED_" + asOf);
  requireMatch(
    months.every((m) => m.used_prepaid_account === false && m.accrual_voucher_id == null),
    "MONTHS_ALREADY_RECOGNISED"
  );
  const before = await glBalance(tx, PREPAID_ACCOUNT);
  const expenseBefore = await glBalance(tx, EXPENSE_ACCOUNT);
  const rental = await shopRentCredit(tx, asOf);
  requireMatch(
    rental.contracts === 6 &&
      rental.credit === "29566.66" &&
      before === "24566.66" &&
      toMoney(rental.credit).minus(before).eq(REPAIR_AMOUNT),
    "CURRENT_RECONCILIATION_CHANGED"
  );

  // Accounting-only audit narration, not UI copy or an API message.
  const correctionDescription =
    "Factory Hadi Dakik Family Apartment: reclassify two future months of 2026-07-13 $15,000 rent payment (original voucher 10550) from early expense to Prepaid Rent. Nov and Dec recognition remains due on the 15th. No cash, rent payment or guarantee changed.";
  const posted = await postErpVoucherTx(tx, {
    companyId: COMPANY,
    voucherType: "Journal",
    voucherNumber: VOUCHER_NUMBER,
    voucherDate: asOf,
    currency: "USD",
    sourceModule: "FACTORY",
    description: correctionDescription,
    source: { type: "factory-legacy-rent-prepaid-reclass", id: "12:34:10550:2026-11-03" },
    lines: [
      {
        ledgerAccountId: PREPAID_ACCOUNT,
        debit: REPAIR_AMOUNT,
        narration: "Nov/Dec 2026 prepaid rental $2,500 each; original payment 10550",
      },
      {
        ledgerAccountId: EXPENSE_ACCOUNT,
        credit: REPAIR_AMOUNT,
        narration: "Correct early recognition of November/December rent from payment 10550",
      },
    ],
  });
  requireMatch(!posted.replayed, "UNEXPECTED_REPLAY");

  const updated = (
    await tx.execute(sql`
    UPDATE property_monthly_ledger SET used_prepaid_account = TRUE
    WHERE company_id = ${COMPANY} AND contract_id = ${CONTRACT}
      AND id IN (695946, 695947) AND accrual_voucher_id IS NULL
      AND used_prepaid_account = FALSE AND used_advance_account = FALSE
    RETURNING id
  `)
  ).rows as Row[];
  requireMatch(updated.length === 2, "FUTURE_RECOGNITION_LINK_FAILED");

  const prepaidAfter = await glBalance(tx, PREPAID_ACCOUNT);
  const expenseAfter = await glBalance(tx, EXPENSE_ACCOUNT);
  requireMatch(
    prepaidAfter === rental.credit &&
      toMoney(prepaidAfter).minus(before).eq(REPAIR_AMOUNT) &&
      toMoney(expenseBefore).minus(expenseAfter).eq(REPAIR_AMOUNT),
    "POSTING_VERIFICATION_FAILED"
  );

  return { applied: true, voucherId: posted.voucher.id, prepaid: prepaidAfter };
}

export async function runApprovedHadiPrepaidRepair(): Promise<void> {
  if (process.env[ENV] !== ENABLE) return;
  requireMatch(process.env.RENDER_SERVICE_ID === PRODUCTION_SERVICE, "WRONG_SERVICE");
  const database = await pool.query<{ name: string }>("SELECT current_database() AS name");
  requireMatch(database.rows[0]?.name === PRODUCTION_DATABASE, "WRONG_DATABASE");

  const result = await runAsSystemAuditActor("approved-hadi-prepaid-20261103", () =>
    runWithAuditReason(
      "Owner-requested backend-only Factory rent GL reconciliation: Hadi contract 34, voucher 10550, $5,000 prepaid (Nov/Dec 2026)",
      () => runWithDatabaseScopeRuntimeContext(createTenantDatabaseScope(COMPANY), () => db.transaction(runCorrection))
    )
  );
  logger.info("[HadiPrepaidRepair] Reviewed backend reconciliation completed", result);
}

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
import { companyBusinessDate } from "../services/accounting/companyBusinessDate";
import { runAsSystemAuditActor, runWithAuditReason } from "../services/audit/auditActorContext";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../services/security/databaseScopeRuntimeContext";

const ENV = "ERP_REPAIR_HADI_PREPAID_20261103";
const ENABLE = "approved-hmd12-hadi34-5000";
const PRODUCTION_SERVICE = "srv-d6kibgtactks739u7vl0";
const PRODUCTION_DATABASE = "erp_db_qscj_64lv_e7rz_8744_2lm3";
const COMPANY = 12;
const CONTRACT = 34;
const PREPAID_ACCOUNT = 2202;
const EXPENSE_ACCOUNT = 868;
const REPAIR_AMOUNT = "5000.00";
const VOUCHER_NUMBER = "FACTORY-RENT-PREPAID-HADI34-20261103";

type Row = Record<string, unknown>;
const num = (value: unknown) => Number(value);
const money = (value: unknown) => toMoney(String(value ?? 0)).toFixed(2);
function requireMatch(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error("HADI_PREPAID_REPAIR_" + code);
}

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
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('hmd12-hadi34-prepaid-20261103'))`);
  const asOf = await companyBusinessDate(COMPANY, tx);
  const company = (
    await tx.execute(sql`
    SELECT id, name, active FROM companies WHERE id = ${COMPANY}
  `)
  ).rows as Row[];
  requireMatch(
    company.length === 1 && company[0].name === "HMD INT GROUP - BEIRUT" && company[0].active === true,
    "COMPANY_CHANGED"
  );

  const original = (
    await tx.execute(sql`
    SELECT v.id, v.voucher_number, v.voucher_type, v.voucher_date::text AS voucher_date,
      v.deleted_at, v.optional, v.currency, e.ledger_account_id, e.debit_amount, e.credit_amount
    FROM vouchers v JOIN voucher_entries e ON e.voucher_id = v.id
    WHERE v.company_id = ${COMPANY} AND v.id = 10550
    ORDER BY e.id FOR SHARE OF v, e
  `)
  ).rows as Row[];
  requireMatch(
    original.length === 2 &&
      original.every(
        (r) =>
          r.deleted_at == null &&
          r.optional === false &&
          r.voucher_type === "Payment" &&
          r.currency === "USD" &&
          String(r.voucher_date).slice(0, 10) === "2026-07-13"
      ) &&
      original.some(
        (r) =>
          num(r.ledger_account_id) === EXPENSE_ACCOUNT &&
          money(r.debit_amount) === "15000.00" &&
          money(r.credit_amount) === "0.00"
      ) &&
      original.some(
        (r) =>
          num(r.ledger_account_id) === 707 && money(r.debit_amount) === "0.00" && money(r.credit_amount) === "15000.00"
      ),
    "ORIGINAL_RECEIPT_CHANGED"
  );

  const contract = (
    await tx.execute(sql`
    SELECT c.id, c.status, c.tenant_name, c.rental_amount, c.currency, c.start_date::text AS start_date,
      u.id AS unit_id, u.unit_number, u.unit_type, u.active, u.module
    FROM property_contracts c JOIN property_units u ON u.id = c.unit_id
    WHERE c.company_id = ${COMPANY} AND c.id = ${CONTRACT} FOR SHARE OF c, u
  `)
  ).rows as Row[];
  requireMatch(
    contract.length === 1 &&
      contract[0].status === "ACTIVE" &&
      contract[0].tenant_name === "HADI DAKIK" &&
      contract[0].unit_number === "FAMILY APPARMENT" &&
      num(contract[0].unit_id) === 55 &&
      contract[0].unit_type === "SHOP" &&
      contract[0].module === "FACTORY" &&
      contract[0].active === true &&
      contract[0].currency === "USD" &&
      money(contract[0].rental_amount) === "2500.00" &&
      String(contract[0].start_date).slice(0, 10) === "2026-07-15",
    "CONTRACT_CHANGED"
  );

  const payments = (
    await tx.execute(sql`
    SELECT p.id, p.contract_id, p.voucher_id, p.ledger_row_id, p.payment_date::text AS payment_date,
      p.posting_status, p.amount, p.for_year, p.for_month
    FROM property_payments p WHERE p.company_id = ${COMPANY} AND p.contract_id = ${CONTRACT}
    ORDER BY p.for_year, p.for_month, p.id FOR SHARE OF p
  `)
  ).rows as Row[];
  requireMatch(
    payments.length === 6 &&
      payments.every(
        (p, i) =>
          num(p.id) === 297 + i &&
          num(p.voucher_id) === 10550 &&
          num(p.contract_id) === CONTRACT &&
          num(p.for_year) === 2026 &&
          num(p.for_month) === 7 + i &&
          num(p.ledger_row_id) === 695942 + i &&
          String(p.payment_date).slice(0, 10) === "2026-07-13" &&
          p.posting_status === "POSTED" &&
          money(p.amount) === "2500.00"
      ),
    "SOURCE_PAYMENTS_CHANGED"
  );

  const months = (
    await tx.execute(sql`
    SELECT id, contract_id, year, month, expected_amount, paid_amount,
      used_prepaid_account, used_advance_account, accrual_voucher_id
    FROM property_monthly_ledger
    WHERE company_id = ${COMPANY} AND contract_id = ${CONTRACT}
      AND year = 2026 AND month IN (11, 12)
    ORDER BY month FOR UPDATE
  `)
  ).rows as Row[];
  requireMatch(
    months.length === 2 &&
      months.every(
        (m, i) =>
          num(m.id) === 695946 + i &&
          num(m.contract_id) === CONTRACT &&
          num(m.year) === 2026 &&
          num(m.month) === 11 + i &&
          money(m.expected_amount) === "2500.00" &&
          money(m.paid_amount) === "2500.00" &&
          m.used_advance_account === false
      ),
    "MONTH_ROWS_CHANGED"
  );

  const priorRepair = (
    await tx.execute(sql`
    SELECT v.id, v.deleted_at, v.optional, v.voucher_type, v.currency,
      e.ledger_account_id, e.debit_amount, e.credit_amount
    FROM vouchers v JOIN voucher_entries e ON e.voucher_id = v.id
    WHERE v.company_id = ${COMPANY} AND v.voucher_number = ${VOUCHER_NUMBER}
    ORDER BY e.id FOR SHARE OF v, e
  `)
  ).rows as Row[];
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

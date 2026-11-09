/**
 * Owner-approved, one-off correction of POS Jnah (ERP company 17), contract 36.
 *
 * 14 Jul 2026: $30,000 rent (Aug 2026 – Jul 2027) was debited entirely to
 * Rent Expense, although the rent schedule correctly shows $20,000 prepaid
 * as of November. September/October legacy prepaid journals offset each
 * other; GL Prepaid = $0 and GL Rent Expense = $30,000.
 *
 * One balanced, audited November journal: Dr Prepaid Rent $20,000 /
 * Cr Rent Expense - ERP Shops $20,000. NO payment/cash edits and NO replay of
 * the already-posted September/October journals. Mark ONLY Dec 2026–Jul 2027
 * paid months as prepaid so the existing due-rent scheduler consumes $2,500
 * monthly thereafter. August–November are already expensed.
 *
 * Disabled unless explicitly enabled on the correct Render production service
 * and database. Locks/verifies the exact live before-image and refuses on any
 * drift, a closed fiscal period or a duplicate correction.
 */
import { sql } from "drizzle-orm";
import { db, pool, type DbTransaction } from "../db";
import { logger } from "../lib/logger";
import { toMoney } from "../lib/money";
import { writeAuditEvent } from "../services/audit";
import { runAsSystemAuditActor, runWithAuditReason } from "../services/audit/auditActorContext";
import { companyBusinessDate } from "../services/accounting/companyBusinessDate";
import { postErpVoucherTx } from "../services/accounting/erpVoucherPosting";
import { companyClosedThrough, isDateInClosedPeriod, runInCompanyPostingScope } from "../services/accounting/scheduledPostingScope";
import { planPosJnahPrepaidMonths, type PosJnahMonth } from "./posJnahPrepaidPlan";

const ENV = "ERP_REPAIR_POS_JNAH_PREPAID_20261109";
const APPROVAL = "approved-company17-contract36-20000";
const PRODUCTION_SERVICE = "srv-d6kibgtactks739u7vl0";
const PRODUCTION_DATABASE = "erp_db_qscj_64lv_e7rz_8744_2lm3";
const COMPANY = 17;
const CONTRACT = 36;
const PREPAID = 3002;
const EXPENSE = 2139;
const ORIGINAL_PAYMENT = 10613;
const AMOUNT = "20000.00";
const POSTING_NUMBER = "POS-JNAH-RENT-PREPAID-17-36-20261109";
const ACTOR = { userId: "system:approved-pos-jnah-rent-20261109", username: "system" };
type Row = Record<string, unknown>;

function requireMatch(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error("POS_JNAH_RENT_REPAIR_REFUSED_" + reason);
}
const number = (value: unknown) => Number(value);
const money = (value: unknown) => toMoney(String(value ?? 0)).toFixed(2);

async function ledgerBalance(tx: DbTransaction, accountId: number): Promise<string> {
  const rows = (await tx.execute(sql`
    SELECT CASE WHEN la.opening_balance_side = 'Cr'
             THEN -COALESCE(la.opening_balance,0)
             ELSE COALESCE(la.opening_balance,0) END
      + COALESCE((
        SELECT SUM(e.debit_amount - e.credit_amount)
        FROM voucher_entries e JOIN vouchers v ON v.id = e.voucher_id AND v.company_id = ${COMPANY}
        WHERE e.company_id = ${COMPANY} AND e.ledger_account_id = ${accountId}
          AND v.deleted_at IS NULL AND v.optional = FALSE
      ), 0) AS balance
    FROM ledger_accounts la
    WHERE la.company_id = ${COMPANY} AND la.id = ${accountId}
      AND la.deleted_at IS NULL AND la.active = TRUE
  `)).rows as Row[];
  requireMatch(rows.length === 1, "ACCOUNT_BALANCE_MISSING_" + accountId);
  return money(rows[0].balance);
}

async function correct(tx: DbTransaction): Promise<{ applied: boolean; voucherId: number; prepaid: string; expense: string }> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('pos-jnah-prepaid-20261109'))`);

  // Check the repair identity first, so a second startup cannot re-post it
  // even after monthly recognition has legitimately moved the GL balance.
  const prior = (await tx.execute(sql`
    SELECT v.id, v.deleted_at, v.optional, v.voucher_type, v.currency,
           e.ledger_account_id, e.debit_amount, e.credit_amount
    FROM vouchers v JOIN voucher_entries e ON e.voucher_id = v.id
    WHERE v.company_id = ${COMPANY} AND v.voucher_number = ${POSTING_NUMBER}
    ORDER BY e.id FOR SHARE OF v, e
  `)).rows as Row[];
  if (prior.length > 0) {
    requireMatch(
      prior.length === 2 &&
      prior.every(r => r.deleted_at == null && r.optional === false &&
        r.voucher_type === "Journal" && r.currency === "USD") &&
      prior.some(r => number(r.ledger_account_id) === PREPAID &&
        money(r.debit_amount) === AMOUNT && money(r.credit_amount) === "0.00") &&
      prior.some(r => number(r.ledger_account_id) === EXPENSE &&
        money(r.credit_amount) === AMOUNT && money(r.debit_amount) === "0.00"),
      "PREVIOUS_REPAIR_CHANGED"
    );
    const future = (await tx.execute(sql`
      SELECT id, used_prepaid_account
      FROM property_monthly_ledger
      WHERE company_id = ${COMPANY} AND contract_id = ${CONTRACT}
        AND (year = 2027 OR (year = 2026 AND month = 12))
    `)).rows as Row[];
    requireMatch(future.length === 8 && future.every(r => r.used_prepaid_account === true),
      "PREVIOUS_REPAIR_FUTURE_FLAGS_CHANGED");
    return { applied: false, voucherId: number(prior[0].id),
      prepaid: await ledgerBalance(tx, PREPAID), expense: await ledgerBalance(tx, EXPENSE) };
  }

  const asOf = await companyBusinessDate(COMPANY, tx);
  requireMatch(asOf >= "2026-11-09" && asOf < "2026-12-01", "OUTSIDE_REVIEWED_NOVEMBER_" + asOf);
  const closedThrough = await companyClosedThrough(COMPANY, tx);
  requireMatch(!isDateInClosedPeriod(closedThrough, asOf), "CLOSED_PERIOD");

  const companies = (await tx.execute(sql`
    SELECT id, name, active FROM companies WHERE id = ${COMPANY}
  `)).rows as Row[];
  requireMatch(companies.length === 1 && companies[0].active === true &&
    String(companies[0].name).trim().startsWith("POS"), "COMPANY_CHANGED");

  const accounts = (await tx.execute(sql`
    SELECT id, name, code, account_type, active, deleted_at, opening_balance, opening_balance_side
    FROM ledger_accounts WHERE company_id = ${COMPANY} AND id IN (${PREPAID}, ${EXPENSE})
    ORDER BY id FOR SHARE
  `)).rows as Row[];
  requireMatch(accounts.length === 2, "ACCOUNTS_MISSING");
  const prepaid = accounts.find(a => number(a.id) === PREPAID);
  const expense = accounts.find(a => number(a.id) === EXPENSE);
  requireMatch(prepaid && prepaid.name === "Prepaid Rent" &&
    prepaid.code === "PREP-RENT-1788256800744" && prepaid.account_type === "Asset" &&
    prepaid.active === true && prepaid.deleted_at == null && money(prepaid.opening_balance) === "0.00",
    "PREPAID_ACCOUNT_CHANGED");
  requireMatch(expense && expense.name === "Rent Expense - ERP Shops" &&
    expense.code === "SHOP-RENT-EXP-1784027392519" && expense.account_type === "Indirect Expense" &&
    expense.active === true && expense.deleted_at == null && money(expense.opening_balance) === "0.00",
    "EXPENSE_ACCOUNT_CHANGED");

  const contracts = (await tx.execute(sql`
    SELECT c.id, c.company_id, c.module, c.unit_id, c.rental_amount, c.currency,
           c.start_date::text AS start_date, c.status, u.unit_number, u.unit_type, u.active
    FROM property_contracts c JOIN property_units u ON u.id = c.unit_id
    WHERE c.company_id = ${COMPANY} AND c.module = 'ERP' AND u.unit_type = 'SHOP'
    FOR SHARE OF c, u
  `)).rows as Row[];
  requireMatch(
    contracts.length === 1 &&
    number(contracts[0].id) === CONTRACT &&
    number(contracts[0].unit_id) === 59 &&
    contracts[0].status === "ACTIVE" &&
    contracts[0].active === true &&
    contracts[0].unit_number === "POS" &&
    contracts[0].currency === "USD" &&
    String(contracts[0].start_date).slice(0,10) === "2026-08-01" &&
    money(contracts[0].rental_amount) === "2500.00",
    "CONTRACT_CHANGED"
  );

  const original = (await tx.execute(sql`
    SELECT v.id, v.voucher_number, v.voucher_date::text AS date, v.voucher_type, v.currency,
           v.source_module, v.deleted_at, v.optional, e.ledger_account_id, e.debit_amount, e.credit_amount
    FROM vouchers v JOIN voucher_entries e ON e.voucher_id = v.id
    WHERE v.company_id = ${COMPANY} AND v.id = ${ORIGINAL_PAYMENT}
    ORDER BY e.id FOR SHARE OF v, e
  `)).rows as Row[];
  requireMatch(
    original.length === 2 &&
    original.every(r => r.voucher_number === "RENT-1784027392518-7rylj-36" &&
      r.voucher_type === "Payment" && r.currency === "USD" && r.source_module === "ERP" &&
      String(r.date).slice(0,10) === "2026-07-14" &&
      r.deleted_at == null && r.optional === false) &&
    original.some(r => number(r.ledger_account_id) === EXPENSE &&
      money(r.debit_amount) === "30000.00" && money(r.credit_amount) === "0.00") &&
    original.some(r => number(r.ledger_account_id) === 2137 &&
      money(r.debit_amount) === "0.00" && money(r.credit_amount) === "30000.00"),
    "ORIGINAL_PAYMENT_CHANGED"
  );

  const monthly = (await tx.execute(sql`
    SELECT id, contract_id, unit_id, year, month, expected_amount, paid_amount,
           accrual_voucher_id, used_prepaid_account, used_advance_account
    FROM property_monthly_ledger
    WHERE company_id = ${COMPANY} AND contract_id = ${CONTRACT}
    ORDER BY year, month, id FOR UPDATE
  `)).rows as PosJnahMonth[];
  const futureIds = planPosJnahPrepaidMonths(monthly);

  const payments = (await tx.execute(sql`
    SELECT id, voucher_id, contract_id, ledger_row_id, amount, payment_date::text AS payment_date,
           for_year, for_month, posting_status, currency
    FROM property_payments WHERE company_id = ${COMPANY} AND contract_id = ${CONTRACT}
    ORDER BY for_year, for_month, id FOR SHARE
  `)).rows as Row[];
  requireMatch(payments.length === 12, "PAYMENT_COUNT_CHANGED");
  for (let i = 0; i < payments.length; i++) {
    const p = payments[i], m = monthly[i];
    requireMatch(number(p.id) === 306+i && number(p.voucher_id) === ORIGINAL_PAYMENT &&
      number(p.contract_id) === CONTRACT && number(p.ledger_row_id) === m.id &&
      number(p.for_year) === m.year && number(p.for_month) === m.month &&
      String(p.payment_date).slice(0,10) === "2026-08-01" &&
      p.posting_status === "POSTED" && money(p.amount) === "2500.00" &&
      p.currency === "USD", "PAYMENT_SNAPSHOT_CHANGED_" + i);
  }

  // Confirm each existing Sep/Oct reclassification and its matching
  // recognition are intact: neither should be posted/reversed a second time.
  const legacy = (await tx.execute(sql`
    SELECT v.id, v.voucher_number, v.voucher_date::text AS date, v.deleted_at, v.optional,
           e.ledger_account_id, e.debit_amount, e.credit_amount
    FROM vouchers v JOIN voucher_entries e ON e.voucher_id = v.id
    WHERE v.company_id = ${COMPANY} AND v.id IN (13141, 13142, 15040, 15041)
    ORDER BY v.id, e.id FOR SHARE OF v, e
  `)).rows as Row[];
  requireMatch(legacy.length === 8 && legacy.every(r => r.deleted_at == null && r.optional === false),
    "LEGACY_VOUCHERS_CHANGED");
  for (const [voucherId, voucherNumber, date, prepaidIsDebit] of [
    [13141, "LEGACY-PREPAID-RECLASS-17-701217-307", "2026-08-01", true],
    [13142, "LEGACY-PREPAID-REC-17-701217", "2026-09-01", false],
    [15040, "LEGACY-PREPAID-RECLASS-17-701218-308", "2026-08-01", true],
    [15041, "LEGACY-PREPAID-REC-17-701218", "2026-10-01", false],
  ] as const) {
    const entries = legacy.filter(r => number(r.id) === voucherId);
    requireMatch(entries.length === 2 && entries.every(r =>
      r.voucher_number === voucherNumber && String(r.date).slice(0,10) === date) &&
      entries.some(r => number(r.ledger_account_id) === PREPAID &&
        money(prepaidIsDebit ? r.debit_amount : r.credit_amount) === "2500.00" &&
        money(prepaidIsDebit ? r.credit_amount : r.debit_amount) === "0.00") &&
      entries.some(r => number(r.ledger_account_id) === EXPENSE &&
        money(prepaidIsDebit ? r.credit_amount : r.debit_amount) === "2500.00" &&
        money(prepaidIsDebit ? r.debit_amount : r.credit_amount) === "0.00"),
      "LEGACY_VOUCHER_CHANGED_" + voucherId);
  }

  const prepaidBefore = await ledgerBalance(tx, PREPAID);
  const expenseBefore = await ledgerBalance(tx, EXPENSE);
  requireMatch(prepaidBefore === "0.00" && expenseBefore === "30000.00",
    "GL_BEFORE_IMAGE_CHANGED");

  const posted = await postErpVoucherTx(tx, {
    companyId: COMPANY,
    voucherType: "Journal",
    voucherNumber: POSTING_NUMBER,
    voucherDate: asOf,
    currency: "USD",
    sourceModule: "ERP",
    description: "POS Jnah contract 36: reclassify future Dec 2026–Jul 2027 paid rent ($20,000) from the Jul 2026 lump-sum expense to prepaid; original payment 10613 unchanged",
    source: { type: "erp-pos-jnah-prepaid-repair", id: "17:36:10613:2026-11-09" },
    actor: { ...ACTOR, reason: "Owner-approved POS Jnah prepaid GL reconciliation" },
    lines: [
      { ledgerAccountId: PREPAID, debit: AMOUNT, narration: "Eight future rental months, Dec 2026–Jul 2027" },
      { ledgerAccountId: EXPENSE, credit: AMOUNT, narration: "Reclassify unearned portion of $30,000 annual rent payment 10613" },
    ],
  });
  requireMatch(!posted.replayed, "UNEXPECTED_POSTING_REPLAY");

  const idsSql = sql.join(futureIds.map(id => sql`${id}`), sql`, `);
  const marked = (await tx.execute(sql`
    UPDATE property_monthly_ledger
       SET used_prepaid_account = TRUE
     WHERE company_id = ${COMPANY} AND contract_id = ${CONTRACT}
       AND id IN (${idsSql})
       AND accrual_voucher_id IS NULL
       AND used_prepaid_account = FALSE AND used_advance_account = FALSE
    RETURNING id
  `)).rows as Row[];
  requireMatch(marked.length === 8, "FUTURE_MONTHS_CONCURRENTLY_CHANGED");

  const prepaidAfter = await ledgerBalance(tx, PREPAID);
  const expenseAfter = await ledgerBalance(tx, EXPENSE);
  requireMatch(prepaidAfter === AMOUNT && expenseAfter === "10000.00" &&
    toMoney(prepaidAfter).minus(toMoney(prepaidBefore)).eq(AMOUNT) &&
    toMoney(expenseBefore).minus(toMoney(expenseAfter)).eq(AMOUNT),
    "POST_REPAIR_LEDGER_VERIFICATION_FAILED");

  await writeAuditEvent({
    userId: ACTOR.userId,
    username: ACTOR.username,
    companyId: COMPANY,
    action: "update",
    tableName: "property_monthly_ledger",
    recordIdentifier: "pos-jnah-prepaid-36-20261109",
    changes: {
      entryRows: {
        old: futureIds.map(id => ({ id, usedPrepaidAccount: false })),
        new: futureIds.map(id => ({ id, usedPrepaidAccount: true })),
      },
      correctionVoucher: { new: { voucherId: posted.voucher.id, voucherNumber: POSTING_NUMBER, debit: AMOUNT, credit: AMOUNT } },
      originalVoucher: { new: ORIGINAL_PAYMENT },
      before: { new: { prepaid: prepaidBefore, expense: expenseBefore } },
      after: { new: { prepaid: prepaidAfter, expense: expenseAfter } },
    },
  }, tx);

  return { applied: true, voucherId: posted.voucher.id, prepaid: prepaidAfter, expense: expenseAfter };
}

export async function runApprovedPosJnahPrepaidRepair(): Promise<void> {
  if (process.env[ENV] !== APPROVAL) return;
  requireMatch(process.env.RENDER_SERVICE_ID === PRODUCTION_SERVICE, "WRONG_SERVICE");
  const currentDb = await pool.query<{ name: string }>("SELECT current_database() AS name");
  requireMatch(currentDb.rows[0]?.name === PRODUCTION_DATABASE, "WRONG_DATABASE");
  const result = await runAsSystemAuditActor(ACTOR.userId, () =>
    runWithAuditReason("Owner-approved POS Jnah annual prepaid rent reconciliation for contract 36",
      () => runInCompanyPostingScope(COMPANY, () => db.transaction(correct)))
  );
  logger.info("[PosJnahPrepaidRepair] Audited correction finished", result);
}

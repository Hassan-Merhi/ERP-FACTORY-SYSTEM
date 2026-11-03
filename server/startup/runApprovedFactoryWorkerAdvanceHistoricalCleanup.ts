/**
 * HMD Beirut (company 12): dated repair of historical worker advance evidence.
 *
 * The user explicitly approved the repair and required ORIGINAL voucher dates.
 * Backdated journals use the date the payment, repayment, or payroll occurred.
 * Actual execution is opt-in and fail-closed on every recorded source snapshot.
 * No frontend changes, supplier movements, or today's-date accounting vouchers.
 */
import { sql } from "drizzle-orm";
import { db, pool, type DbTransaction } from "../db";
import { logger } from "../lib/logger";
import { toMoney } from "../lib/money";
import { logAudit } from "../routes/helpers/auditHelpers";
import { writeDaybookEntry } from "../services/factory/factoryDaybookWriter";
import { postErpVoucherTx, type ErpVoucherLine } from "../services/accounting/erpVoucherPosting";
import { runInCompanyPostingScope } from "../services/accounting/scheduledPostingScope";
import { runWithAuditReason } from "../services/audit/auditActorContext";

const ENV = "FACTORY_ADVANCE_HISTORICAL_RECONCILE_20261103";
const ENABLE = "approved-company12-original-voucher-dates-v1";
const SERVICE = "srv-d6kibgtactks739u7vl0";
const DATABASE = "erp_db_qscj_64lv_e7rz_8744_2lm3";
const COMPANY = 12;
const CASH = 707;
const ADVANCES = 796;
const PAYABLE = 811;
const MARKER = "FACTORY_ADVANCES_ORIGINAL_DATE_RECONCILIATION_20261103";

type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v);
const money = (v: unknown) => toMoney(String(v ?? "0")).toFixed(2);
function must(value: unknown, code: string): asserts value {
  if (!value) throw new Error("FACTORY_ADVANCES_HISTORICAL_REPAIR_" + code);
}

interface Totals {
  original: string;
  remaining: string;
  payroll: string;
  manual: string;
  opening: string;
  debit: string;
  credit: string;
  ledger: string;
  cash: string;
  payable: string;
}

async function totals(tx: DbTransaction): Promise<Totals> {
  const [row] = (await tx.execute(sql`
    WITH advances AS (
      SELECT COALESCE(SUM(amount),0) AS original,
             COALESCE(SUM(remaining_balance) FILTER (WHERE fully_paid=false),0) AS remaining
        FROM factory_worker_advances WHERE company_id=${COMPANY}
    ),
    payroll AS (
      SELECT COALESCE(SUM(advances),0) AS deducted FROM factory_payrolls WHERE company_id=${COMPANY}
    ),
    manual AS (
      SELECT COALESCE(SUM(amount),0) AS received FROM factory_advance_repayments WHERE company_id=${COMPANY}
    ),
    gl AS (
      SELECT COALESCE(SUM(e.debit_amount) FILTER (WHERE e.ledger_account_id=${ADVANCES}),0) AS debit,
             COALESCE(SUM(e.credit_amount) FILTER (WHERE e.ledger_account_id=${ADVANCES}),0) AS credit,
             COALESCE(SUM(e.debit_amount-e.credit_amount) FILTER (WHERE e.ledger_account_id=${CASH}),0) AS cash,
             COALESCE(SUM(e.credit_amount-e.debit_amount) FILTER (WHERE e.ledger_account_id=${PAYABLE}),0) AS payable
        FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id
       WHERE v.company_id=${COMPANY} AND e.company_id=${COMPANY}
         AND v.deleted_at IS NULL
    )
    SELECT advances.original::text, advances.remaining::text,
           payroll.deducted::text AS payroll, manual.received::text AS manual,
           la.opening_balance::text AS opening, gl.debit::text, gl.credit::text,
           (la.opening_balance + gl.debit - gl.credit)::text AS ledger,
           gl.cash::text, gl.payable::text
      FROM advances, payroll, manual, gl, ledger_accounts la
     WHERE la.company_id=${COMPANY} AND la.id=${ADVANCES}
       AND la.deleted_at IS NULL AND la.opening_balance_side='Dr'
  `)).rows as Row[];
  must(row, "MISSING_ACCOUNT");
  return {
    original: money(row.original),
    remaining: money(row.remaining),
    payroll: money(row.payroll),
    manual: money(row.manual),
    opening: money(row.opening),
    debit: money(row.debit),
    credit: money(row.credit),
    ledger: money(row.ledger),
    cash: money(row.cash),
    payable: money(row.payable),
  };
}

export function validateHistoricalAdvanceTotals(before: Totals, after: Totals): void {
  must(before.original === "91589.90" && before.remaining === "2515.00", "ADVANCE_SOURCE_CHANGED");
  must(before.payroll === "88690.29" && before.manual === "173.00", "RECOVERY_SOURCE_CHANGED");
  must(before.opening === "299.99" && before.debit === "91201.90" &&
       before.credit === "88775.28" && before.ledger === "2726.61", "LEDGER_SOURCE_CHANGED");
  must(after.original === "91538.29" && after.remaining === "2675.00", "ADVANCE_POSTCHECK");
  must(after.payroll === before.payroll && after.manual === before.manual, "RECOVERY_CHANGED");
  must(after.opening === "0.00" && after.debit === "91538.29" &&
       after.credit === "88863.29" && after.ledger === "2675.00", "LEDGER_POSTCHECK");
  must(toMoney(after.cash).minus(toMoney(before.cash)).eq("-248.39"), "CASH_POSTCHECK");
  must(toMoney(after.payable).minus(toMoney(before.payable)).eq("-0.01"), "PAYABLE_POSTCHECK");
}

async function assertHistoricalEvidence(tx: DbTransaction): Promise<void> {
  const evidence = (await tx.execute(sql`
    SELECT id,worker_id,advance_date::text AS date,amount::text,
           remaining_balance::text AS remaining,fully_paid,cash_account_id,
           repayment_type,notes
      FROM factory_worker_advances
     WHERE company_id=${COMPANY} AND id IN (3,267,272,274,277)
     ORDER BY id FOR UPDATE
  `)).rows as Row[];
  must(evidence.length === 5, "ADVANCE_ROWS_CHANGED");
  const byId = new Map(evidence.map((x) => [num(x.id), x]));
  const expected = [
    [3,45,"2026-03-12","200.00","115.00",false,CASH,"manual_repayment"],
    [267,72,"2026-06-15","100.00","0.00",true,null,"salary_deduction"],
    [272,72,"2026-06-15","100.00","0.00",true,CASH,"salary_deduction"],
    [274,37,"2026-07-10","88.00","0.00",true,CASH,"manual_repayment"],
    [277,180,"2026-07-16","160.00","0.00",true,CASH,"salary_deduction"],
  ] as const;
  for (const [id,workerId,date,amount,remaining,paid,account,type] of expected) {
    const r = byId.get(id);
    must(r && num(r.worker_id) === workerId && String(r.date) === date &&
         money(r.amount) === amount && money(r.remaining) === remaining &&
         r.fully_paid === paid && r.cash_account_id === account &&
         r.repayment_type === type, "ADVANCE_" + id + "_CHANGED");
  }
  must(byId.get(267)?.notes === "JUNE ADVANCES" &&
       byId.get(272)?.notes === "june advance" &&
       byId.get(274)?.notes === "test", "ADVANCE_NOTES_CHANGED");

  const [payroll] = (await tx.execute(sql`
    SELECT
      COUNT(*) FILTER(WHERE id=686 AND worker_id=111 AND status='PAID' AND
         period_start='2026-05-01' AND period_end='2026-05-16' AND
         advances=48.39 AND net_salary=0)::int AS may_advance,
      COUNT(*) FILTER(WHERE id=783 AND worker_id=72 AND status='PAID' AND
         period_start='2026-06-08' AND period_end='2026-06-20' AND
         advances=100)::int AS june_advance,
      COUNT(*) FILTER(WHERE id=931 AND worker_id=180 AND status='PAID' AND
         period_start='2026-07-01' AND period_end='2026-07-31' AND
         advances=0)::int AS july_unrecovered,
      COUNT(*) FILTER(WHERE id=672 AND worker_id=133 AND status='PAID' AND
         period_start='2026-05-17' AND period_end='2026-05-17' AND
         advances=0.01 AND net_salary=-0.01)::int AS one_cent
    FROM factory_payrolls WHERE company_id=${COMPANY}
  `)).rows as Row[];
  must(payroll && ["may_advance","june_advance","july_unrecovered","one_cent"]
      .every((key) => num(payroll[key]) === 1), "PAYROLL_EVIDENCE_CHANGED");

  const [repay] = (await tx.execute(sql`
    SELECT COUNT(*) FILTER (WHERE id=69 AND advance_id=274 AND worker_id=37 AND
      amount=88 AND repayment_date='2026-07-10' AND cash_account_id=${CASH} AND
      notes='test')::int AS matched,
      COUNT(*) FILTER (WHERE advance_id=267)::int AS duplicate_repayments
    FROM factory_advance_repayments WHERE company_id=${COMPANY}
  `)).rows as Row[];
  must(num(repay?.matched) === 1 && num(repay?.duplicate_repayments) === 0, "REPAYMENT_CHANGED");

  const [oldVoucher] = (await tx.execute(sql`
    SELECT v.id,v.voucher_date::text AS date,v.deleted_at,v.original_voucher_number,
           COUNT(e.id)::int AS lines,
           COALESCE(SUM(e.debit_amount) FILTER (WHERE e.ledger_account_id=${ADVANCES}),0)::text AS debit,
           COALESCE(SUM(e.credit_amount) FILTER (WHERE e.ledger_account_id=${CASH}),0)::text AS credit
      FROM vouchers v JOIN voucher_entries e ON e.voucher_id=v.id
     WHERE v.company_id=${COMPANY} AND e.company_id=${COMPANY} AND v.id=7838
     GROUP BY v.id
  `)).rows as Row[];
  must(oldVoucher && oldVoucher.deleted_at != null &&
       oldVoucher.original_voucher_number === "PAYMENT-ADV-103-1778955721430" &&
       oldVoucher.date === "2026-05-16" && num(oldVoucher.lines) === 2 &&
       money(oldVoucher.debit) === "48.39" && money(oldVoucher.credit) === "48.39",
       "DELETED_VOUCHER_CHANGED");

  const [missing] = (await tx.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM factory_worker_advances WHERE company_id=${COMPANY} AND id=103)::int AS original_exists,
      (SELECT COUNT(*) FROM vouchers WHERE company_id=${COMPANY} AND
        (voucher_number LIKE 'PAYMENT-ADV-3-%' OR
         voucher_number LIKE 'PAYMENT-ADV-274-%' OR
         voucher_number LIKE 'RECEIPT-REPAY-69-%'))::int AS already_posted,
      (SELECT COUNT(*) FROM vouchers WHERE company_id=${COMPANY} AND
         voucher_date='2026-05-17' AND voucher_number LIKE 'PAYROLL-GEN-%'
         AND description LIKE '%2026-05-17%')::int AS existing_may17,
      (SELECT COUNT(*) FROM fiscal_period_closures WHERE company_id=${COMPANY} AND status='CLOSED')::int AS closed
  `)).rows as Row[];
  must(num(missing?.original_exists) === 0 && num(missing?.already_posted) === 0 &&
       num(missing?.existing_may17) === 0 && num(missing?.closed) === 0,
       "MISSING_POSTINGS_OR_CLOSED_PERIOD_CHANGED");

  const [original] = (await tx.execute(sql`
    SELECT COUNT(*)::int AS n FROM factory_daybook_entries
    WHERE company_id=${COMPANY} AND id=14084 AND reference_id=267 AND
      reference_table='factory_worker_advances' AND tx_date='2026-06-15'
      AND tx_type='ADVANCE_GIVEN' AND amount_usd=100
  `)).rows as Row[];
  must(num(original?.n) === 1, "DUPLICATE_DAYBOOK_CHANGED");

  const [existingRepair] = (await tx.execute(sql`
    SELECT COUNT(*)::int AS n FROM accounting_posting_requests
    WHERE company_id=${COMPANY} AND source_type='factory-advances-original-date-repair'
  `)).rows as Row[];
  must(num(existingRepair?.n) === 0, "ALREADY_PARTIALLY_APPLIED");
}

async function postDated(
  tx: DbTransaction, id: string, date: string, type: string,
  description: string, lines: readonly ErpVoucherLine[]
): Promise<void> {
  const posted = await postErpVoucherTx(tx, {
    companyId: COMPANY,
    voucherDate: date,
    effectiveDate: date,
    voucherType: type,
    currency: "USD",
    sourceModule: "FACTORY",
    description,
    lines,
    source: { type: "factory-advances-original-date-repair", id },
  });
  must(!posted.replayed, "DUPLICATE_VOUCHER_" + id);
}

async function repair(tx: DbTransaction): Promise<void> {
  await tx.execute(sql`
    UPDATE factory_worker_advances SET remaining_balance=160,fully_paid=false
     WHERE company_id=${COMPANY} AND id=277 AND remaining_balance=0 AND fully_paid=true
  `);
  await logAudit({
    userId:"system:worker-advance-original-date",username:"system:worker-advance-original-date",
    companyId:COMPANY,action:"repair",tableName:"factory_worker_advances",recordId:277,
    recordIdentifier:"Advance #277 July 16, unpaid $160",
    changes:{remainingBalance:{old:"0.00",new:"160.00"},fullyPaid:{old:true,new:false}},
  },tx);

  // The June 15 cashless duplicate was never posted as a disbursement.
  // The later #272 is the one actually paid, and its $100 payroll recovery exists.
  await tx.execute(sql`DELETE FROM factory_worker_advances WHERE company_id=${COMPANY} AND id=267`);
  await tx.execute(sql`
    UPDATE factory_daybook_entries
       SET tx_type='ADVANCE_DELETED',amount_usd=0,amount_currency=0,
           description='VOIDED duplicate June 15 advance #267; actual disbursement is #272'
     WHERE company_id=${COMPANY} AND id=14084
  `);
  await logAudit({
    userId:"system:worker-advance-original-date",username:"system:worker-advance-original-date",
    companyId:COMPANY,action:"void",tableName:"factory_worker_advances",recordId:267,
    recordIdentifier:"Advance #267 June 15 duplicate of #272",
    changes:{amount:{old:"100.00",new:null},cashAccountId:{old:null,new:null},
             sourceDaybookId:{old:14084,new:"voided on original date"}},
  },tx);

  // Restore the paid May 16 source record but do NOT reactivate its retired
  // voucher. The original remains archived; a new historical correction
  // voucher has a separate immutable audit trail and original date.
  await tx.execute(sql`
    INSERT INTO factory_worker_advances
      (id,company_id,worker_id,advance_date,amount,remaining_balance,fully_paid,
       cash_account_id,repayment_type,created_at,notes)
    VALUES (103,${COMPANY},111,'2026-05-16',48.39,0,true,${CASH},
            'salary_deduction','2026-05-16 18:22:01.307973',
            'Restored from original paid voucher #7838 and payroll #686')
  `);
  await logAudit({
    userId:"system:worker-advance-original-date",username:"system:worker-advance-original-date",
    companyId:COMPANY,action:"restore",tableName:"factory_worker_advances",recordId:103,
    recordIdentifier:"Advance #103 May 16 restoration",
    changes:{amount:{old:null,new:"48.39"},remainingBalance:{old:null,new:"0.00"},
             originalVoucher:{old:"7838 retired 2026-11-03",new:"dated replacement voucher"}},
  },tx);
  await writeDaybookEntry(tx,{
    companyId:COMPANY,txDate:"2026-05-16",effectiveDate:"2026-05-16",
    txType:"ADVANCE_RESTORED",referenceId:103,referenceTable:"factory_worker_advances",
    amountUsd:0,amountCurrency:0,
    description:"Historical restoration of paid May 16 advance #103; original voucher #7838 remains retired",
    createdBy:"system:worker-advance-original-date",
  });

  // Backfill source-supported missing cash payment / repayment vouchers.
  // Existing advance rows and the July 10 manual repayment already preserve
  // their original payment dates and counterpart cash account 707.
  await postDated(tx,"advance-3","2026-03-12","Payment",
    "Restore March 12 cash advance #3 from surviving worker advance and daybook",
    [{ledgerAccountId:ADVANCES,debit:"200.00"},{ledgerAccountId:CASH,credit:"200.00"}]);
  await postDated(tx,"advance-103","2026-05-16","Payment",
    "Restore May 16 cash disbursement #103; original voucher #7838 archived after deletion",
    [{ledgerAccountId:ADVANCES,debit:"48.39"},{ledgerAccountId:CASH,credit:"48.39"}]);
  await postDated(tx,"advance-274","2026-07-10","Payment",
    "Restore July 10 test advance #274; match its same-day $88 repayment",
    [{ledgerAccountId:ADVANCES,debit:"88.00"},{ledgerAccountId:CASH,credit:"88.00"}]);
  await postDated(tx,"repayment-69","2026-07-10","Receipt",
    "Restore July 10 repayment #69 of original test advance #274",
    [{ledgerAccountId:CASH,debit:"88.00"},{ledgerAccountId:ADVANCES,credit:"88.00"}]);
  // May 17 payroll #672 recovered one cent despite negative net salary.
  // This is NOT new cash or salary expense: it clears an over-deducted payable.
  await postDated(tx,"payroll-672","2026-05-17","Journal",
    "May 17 paid payroll #672: one-cent advance recovery, negative net payable",
    [{ledgerAccountId:PAYABLE,debit:"0.01"},{ledgerAccountId:ADVANCES,credit:"0.01"}]);

  // The $299.99 opening was manually introduced July 10 from a documented
  // prior $0.00. Clearing it is an opening correction, not today's journal.
  // The five dated vouchers above replace its historical offset exactly.
  await tx.execute(sql`
    UPDATE ledger_accounts SET opening_balance=0
     WHERE company_id=${COMPANY} AND id=${ADVANCES}
       AND opening_balance=299.99 AND opening_balance_side='Dr'
  `);
  await logAudit({
    userId:"system:worker-advance-original-date",username:"system:worker-advance-original-date",
    companyId:COMPANY,action:"repair",tableName:"ledger_accounts",recordId:ADVANCES,
    recordIdentifier:"Factory Worker Advances July 10 manually entered opening",
    changes:{openingBalance:{old:"299.99",new:"0.00"}},
  },tx);
}

/** Exactly-once repair, no writes on reboots or on an altered before-image. */
export async function runApprovedFactoryWorkerAdvanceHistoricalCleanup(): Promise<void> {
  if (process.env[ENV] !== ENABLE) return;
  must(process.env.RENDER_SERVICE_ID === SERVICE, "WRONG_RENDER_SERVICE");
  const database = await pool.query<{ name:string }>("SELECT current_database() AS name");
  must(database.rows[0]?.name === DATABASE, "WRONG_DATABASE");

  const outcome = await runInCompanyPostingScope(COMPANY, () =>
    runWithAuditReason("Owner-approved factory worker advances historical accounting; original dates only", () =>
      db.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('factory-worker-advance-original-date-20261103'))`);
        const [marker] = (await tx.execute(sql`
          SELECT COUNT(*)::int AS n FROM audit_log
          WHERE company_id=${COMPANY} AND table_name='factory_advances_reconciliation'
            AND record_identifier=${MARKER}
        `)).rows as Row[];
        if (num(marker?.n) > 0) {
          const done = await totals(tx);
          must(done.ledger === "2675.00" && done.remaining === "2675.00" &&
               done.opening === "0.00", "ALREADY_APPLIED_BUT_DRIFTED");
          return {posted:false,ledger:done.ledger,worker:done.remaining};
        }
        const before = await totals(tx);
        await assertHistoricalEvidence(tx);
        await repair(tx);
        const after = await totals(tx);
        validateHistoricalAdvanceTotals(before,after);
        await logAudit({
          userId:"system:worker-advance-original-date",username:"system:worker-advance-original-date",
          companyId:COMPANY,action:"repair",tableName:"factory_advances_reconciliation",
          recordId:COMPANY,recordIdentifier:MARKER,
          changes:{ledger:{old:before.ledger,new:after.ledger},
                   storedOutstanding:{old:before.remaining,new:after.remaining},
                   historicalDates:{old:null,new:"2026-03-12, 2026-05-16, 2026-05-17, 2026-06-15, 2026-07-10, 2026-07-16"}},
        },tx);
        return {posted:true,ledger:after.ledger,worker:after.remaining};
      })
    ),
    "factory-advance-original-dated-reconciliation-20261103"
  );
  logger.info("[startup] Factory worker advances original-dated reconciliation", outcome);
}

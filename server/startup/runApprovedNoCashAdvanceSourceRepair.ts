/**
 * One-time repair of worker-advance *source records* without changing Cash,
 * vouchers, journal lines, ledger openings, suppliers, or payroll.
 *
 * Historical accounting source: original May 16 advance #103 was deleted
 * after a paid payroll had recovered it; June 15 advance #267 is an unposted
 * duplicate of the recorded #272; July 16 advance #277 has a real cash
 * disbursement but no payroll/manual repayment despite a fully-paid flag.
 *
 * The remaining $51.61 after this source repair is deliberately NOT posted
 * to an arbitrary offset account. A later GL correction requires evidence.
 */
import { sql } from "drizzle-orm";
import { db, pool, type DbTransaction } from "../db";
import { logger } from "../lib/logger";
import { toMoney } from "../lib/money";
import { logAudit } from "../routes/helpers/auditHelpers";
import { writeDaybookEntry } from "../services/factory/factoryDaybookWriter";
import { runWithAuditReason } from "../services/audit/auditActorContext";
import { runInCompanyPostingScope } from "../services/accounting/scheduledPostingScope";

const COMPANY = 12;
const ADVANCES = 796;
const CASH = 707;
const SERVICE = "srv-d6kibgtactks739u7vl0";
const DATABASE = "erp_db_qscj_64lv_e7rz_8744_2lm3";
const ENV = "FACTORY_ADVANCE_SOURCE_REPAIR_NO_CASH_20261103";
const ENABLE = "approved-company12-historical-source-only-v1";
const AUDIT_MARKER = "company12-no-cash-source-advance-repair-20261103";

type DbRow = Record<string, unknown>;
function cents(value: unknown): string { return toMoney(String(value ?? "0")).toFixed(2); }
function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error("ADVANCE_SOURCE_ONLY_" + code);
}

type State = Readonly<{
  originals: string;
  workerOutstanding: string;
  payrollRecovered: string;
  repaid: string;
  ledgerOpening: string;
  ledgerDebit: string;
  ledgerCredit: string;
  ledgerBalance: string;
  cashDebit: string;
  cashCredit: string;
  cashOpening: string;
}>;

async function snapshot(tx: DbTransaction): Promise<State> {
  const [row] = (await tx.execute(sql`
    WITH original AS (
      SELECT COALESCE(SUM(amount),0) AS total,
             COALESCE(SUM(remaining_balance) FILTER (WHERE fully_paid=false),0) AS outstanding
      FROM factory_worker_advances WHERE company_id=${COMPANY}
    ),
    payroll AS (
      SELECT COALESCE(SUM(advances),0) AS recovered
      FROM factory_payrolls WHERE company_id=${COMPANY}
    ),
    repay AS (
      SELECT COALESCE(SUM(amount),0) AS amount
      FROM factory_advance_repayments WHERE company_id=${COMPANY}
    ),
    postings AS (
      SELECT COALESCE(SUM(e.debit_amount) FILTER(WHERE e.ledger_account_id=${ADVANCES}),0) AS advance_debit,
             COALESCE(SUM(e.credit_amount) FILTER(WHERE e.ledger_account_id=${ADVANCES}),0) AS advance_credit,
             COALESCE(SUM(e.debit_amount) FILTER(WHERE e.ledger_account_id=${CASH}),0) AS cash_debit,
             COALESCE(SUM(e.credit_amount) FILTER(WHERE e.ledger_account_id=${CASH}),0) AS cash_credit
      FROM voucher_entries e JOIN vouchers v ON e.voucher_id=v.id
      WHERE e.company_id=${COMPANY} AND v.company_id=${COMPANY} AND v.deleted_at IS NULL
    )
    SELECT original.total, original.outstanding, payroll.recovered,repay.amount,
           gl.opening_balance AS gl_opening,postings.advance_debit,postings.advance_credit,
           (gl.opening_balance+postings.advance_debit-postings.advance_credit) AS gl_balance,
           cash.opening_balance AS cash_opening,postings.cash_debit,postings.cash_credit
    FROM original,payroll,repay,postings
    JOIN ledger_accounts gl ON gl.id=${ADVANCES} AND gl.company_id=${COMPANY}
    JOIN ledger_accounts cash ON cash.id=${CASH} AND cash.company_id=${COMPANY}
    WHERE gl.name='Factory Worker Advances' AND gl.deleted_at IS NULL AND
          gl.opening_balance_side='Dr' AND cash.name='Cash' AND cash.deleted_at IS NULL
  `)).rows as DbRow[];
  check(row, "ACCOUNT_MISSING");
  return {
    originals: cents(row.total),workerOutstanding: cents(row.outstanding),
    payrollRecovered: cents(row.recovered),repaid: cents(row.amount),
    ledgerOpening: cents(row.gl_opening),ledgerDebit: cents(row.advance_debit),
    ledgerCredit: cents(row.advance_credit),ledgerBalance: cents(row.gl_balance),
    cashOpening: cents(row.cash_opening),cashDebit: cents(row.cash_debit),
    cashCredit: cents(row.cash_credit),
  };
}

export function validateNoCashAdvanceRepair(before: State, after: State): void {
  check(before.originals === "91589.90" && before.workerOutstanding === "2515.00" &&
        before.payrollRecovered === "88690.29" && before.repaid === "173.00",
        "ORIGINAL_SOURCES_CHANGED");
  check(before.ledgerOpening === "299.99" && before.ledgerDebit === "91201.90" &&
        before.ledgerCredit === "88775.28" && before.ledgerBalance === "2726.61",
        "LEDGER_BEFORE_CHANGED");
  check(after.originals === "91538.29" && after.workerOutstanding === "2675.00",
        "WORKER_BALANCES_NOT_REPAIRED");
  check(after.payrollRecovered === before.payrollRecovered && after.repaid === before.repaid,
        "PAYROLL_OR_REPAYMENTS_CHANGED");
  check(after.ledgerOpening === before.ledgerOpening && after.ledgerDebit === before.ledgerDebit &&
        after.ledgerCredit === before.ledgerCredit && after.ledgerBalance === before.ledgerBalance,
        "ACCOUNTING_LEDGER_CHANGED");
  check(after.cashOpening === before.cashOpening && after.cashDebit === before.cashDebit &&
        after.cashCredit === before.cashCredit, "CASH_LEDGER_CHANGED");
}

async function verifyEvidence(tx: DbTransaction): Promise<void> {
  const rows = (await tx.execute(sql`
    SELECT id,worker_id,amount,remaining_balance,fully_paid,
           advance_date::text AS date,cash_account_id,repayment_type,notes
      FROM factory_worker_advances WHERE company_id=${COMPANY}
       AND id IN (267,272,277) ORDER BY id FOR UPDATE
  `)).rows as DbRow[];
  check(rows.length === 3, "ADVANCE_COUNT_CHANGED");
  for (const [id,worker,amount,date,account,notes] of [
    [267,72,"100.00","2026-06-15",null,"JUNE ADVANCES"],
    [272,72,"100.00","2026-06-15",CASH,"june advance"],
    [277,180,"160.00","2026-07-16",CASH,null],
  ] as const) {
    const a=rows.find((r)=>Number(r.id)===id);
    check(a && Number(a.worker_id)===worker && cents(a.amount)===amount &&
          cents(a.remaining_balance)==="0.00" && a.fully_paid===true &&
          a.date===date && a.cash_account_id===account &&
          a.notes===notes && a.repayment_type==="salary_deduction",
          "ADVANCE_CHANGED_" + id);
  }
  const [support]=(await tx.execute(sql`
    SELECT
      (SELECT count(*) FROM factory_worker_advances WHERE company_id=${COMPANY} AND id=103)::int AS restored_exists,
      (SELECT count(*) FROM vouchers WHERE company_id=${COMPANY} AND deleted_at IS NULL AND
        voucher_number LIKE 'PAYMENT-ADV-267-%')::int AS fake_payment_vouchers,
      (SELECT count(*) FROM factory_advance_repayments WHERE company_id=${COMPANY} AND
        advance_id IN (267,272,277,103))::int AS repayments,
      (SELECT count(*) FROM factory_payrolls WHERE company_id=${COMPANY} AND
        ((id=686 AND worker_id=111 AND status='PAID' AND advances=48.39 AND net_salary=0 AND
           period_start='2026-05-01' AND period_end='2026-05-16') OR
         (id=783 AND worker_id=72 AND status='PAID' AND advances=100 AND
           period_start='2026-06-08' AND period_end='2026-06-20') OR
         (id=931 AND worker_id=180 AND status='PAID' AND advances=0 AND
           period_start='2026-07-01' AND period_end='2026-07-31')))::int AS payroll_evidence,
      (SELECT count(*) FROM factory_daybook_entries WHERE company_id=${COMPANY} AND id=14084 AND
        reference_table='factory_worker_advances' AND reference_id=267 AND
        tx_date='2026-06-15' AND tx_type='ADVANCE_GIVEN' AND amount_usd=100)::int AS original_daybook,
      (SELECT count(*) FROM fiscal_period_closures WHERE company_id=${COMPANY} AND status='CLOSED')::int AS closed_periods
  `)).rows as DbRow[];
  check(support && Number(support.restored_exists)===0 && Number(support.fake_payment_vouchers)===0 &&
        Number(support.repayments)===0 && Number(support.payroll_evidence)===3 &&
        Number(support.original_daybook)===1, "EVIDENCE_CHANGED");
  // No posting is performed, but source-only changes still respect closed-book safeguards.
  check(Number(support.closed_periods)===0, "CLOSED_PERIOD_REVIEW_REQUIRED");
  const vouchers=(await tx.execute(sql`
    SELECT v.id,v.voucher_date::text AS date,v.deleted_at,
           count(e.id)::int AS lines,
           COALESCE(SUM(e.debit_amount) FILTER (WHERE e.ledger_account_id=${ADVANCES}),0) AS dr,
           COALESCE(SUM(e.credit_amount) FILTER (WHERE e.ledger_account_id=${CASH}),0) AS cr
    FROM vouchers v JOIN voucher_entries e ON e.voucher_id=v.id
    WHERE v.company_id=${COMPANY} AND e.company_id=${COMPANY} AND v.id IN (7838,9849,10739)
    GROUP BY v.id ORDER BY v.id
  `)).rows as DbRow[];
  check(vouchers.length===3, "ORIGINAL_VOUCHERS_MISSING");
  for (const [id,date,amount,deleted] of [
    [7838,"2026-05-16","48.39",true],
    [9849,"2026-06-15","100.00",false],
    [10739,"2026-07-16","160.00",false],
  ] as const) {
    const v=vouchers.find((r)=>Number(r.id)===id);
    check(v && v.date===date && (v.deleted_at!=null)===deleted &&
          Number(v.lines)===2 && cents(v.dr)===amount && cents(v.cr)===amount,
          "ORIGINAL_VOUCHER_CHANGED_" + id);
  }
  const [audit]=(await tx.execute(sql`
    SELECT count(*)::int AS events FROM audit_log
    WHERE company_id=${COMPANY} AND table_name='factory_worker_advances'
      AND record_id=103 AND action='delete'
      AND changes->'amount'->>'old'='48.39'
  `)).rows as DbRow[];
  check(Number(audit?.events)===1, "MAY_DELETION_AUDIT_MISSING");
}

export async function runApprovedNoCashAdvanceSourceRepair(): Promise<void> {
  if (process.env[ENV]!==ENABLE) return;
  check(process.env.RENDER_SERVICE_ID===SERVICE, "RENDER_SERVICE_MISMATCH");
  const id=await pool.query<{name:string}>("SELECT current_database() AS name");
  check(id.rows[0]?.name===DATABASE, "DATABASE_MISMATCH");
  const result=await runInCompanyPostingScope(COMPANY,()=>
    runWithAuditReason("Owner-approved original-date worker advance source corrections. Preserve Cash and all accounting vouchers.",()=>
      db.transaction(async(tx)=>{
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('worker-advance-no-cash-20261103'))`);
        const [marker]=(await tx.execute(sql`
          SELECT count(*)::int AS n FROM audit_log WHERE company_id=${COMPANY} AND
            table_name='factory_advance_source_repair' AND record_identifier=${AUDIT_MARKER}
        `)).rows as DbRow[];
        if(Number(marker?.n)===1){
          // A successful one-time repair must remain a no-op even after
          // legitimate subsequent advances, repayments and ledger activity.
          const [source]=(await tx.execute(sql`
            SELECT
              (SELECT count(*) FROM factory_worker_advances WHERE company_id=${COMPANY} AND id=267)::int AS duplicate,
              (SELECT count(*) FROM factory_worker_advances WHERE company_id=${COMPANY} AND
                 id=103 AND worker_id=111 AND advance_date='2026-05-16' AND amount=48.39 AND
                 remaining_balance=0 AND fully_paid=true)::int AS restored,
              (SELECT count(*) FROM factory_worker_advances WHERE company_id=${COMPANY} AND
                 id=277 AND worker_id=180 AND advance_date='2026-07-16' AND amount=160)::int AS original
          `)).rows as DbRow[];
          check(Number(source?.duplicate)===0 && Number(source?.restored)===1 &&
                Number(source?.original)===1, "PREVIOUS_REPAIR_SOURCE_DRIFTED");
          return {applied:false,reason:"already audited and applied"};
        }
        check(Number(marker?.n)===0,"DUPLICATE_MARKER");
        const before=await snapshot(tx);
        await verifyEvidence(tx);

        // The only recorded $100 cash disbursement is #272, which the
        // paid June payroll also recovered. #267 never posted to Cash.
        const duplicate=(await tx.execute(sql`
          DELETE FROM factory_worker_advances
          WHERE company_id=${COMPANY} AND id=267 AND worker_id=72
            AND amount=100 AND remaining_balance=0 AND fully_paid=true
          RETURNING id
        `)).rows;
        check(duplicate.length===1, "DUPLICATE_DELETE_FAILED");
        const voided=(await tx.execute(sql`
          UPDATE factory_daybook_entries
          SET tx_type='ADVANCE_DELETED',amount_usd=0,amount_currency=0,
              description='Voided duplicate cashless June 15 advance #267; genuine paid advance #272 preserved'
          WHERE company_id=${COMPANY} AND id=14084 AND tx_date='2026-06-15'
            AND reference_id=267 AND tx_type='ADVANCE_GIVEN' AND amount_usd=100
          RETURNING id
        `)).rows;
        check(voided.length===1, "DUPLICATE_DAYBOOK_NOT_VOIDED");
        await logAudit({
          userId:"system:advance-no-cash",username:"system:advance-no-cash",
          companyId:COMPANY,action:"void",tableName:"factory_worker_advances",
          recordId:267,recordIdentifier:"June 15 duplicate advance #267",
          changes:{amount:{old:"100.00",new:null},
                   evidence:{old:"cashless duplicate of #272",new:"voided on original June 15 date"}},
        },tx);

        // The real July $160 cash disbursement is already correctly posted.
        // No salary deduction or manual repayment was recorded. Restore its
        // receivable without touching its original July 16 payment voucher.
        const reopened=(await tx.execute(sql`
          UPDATE factory_worker_advances SET remaining_balance=160,fully_paid=false
          WHERE company_id=${COMPANY} AND id=277 AND worker_id=180 AND
            amount=160 AND remaining_balance=0 AND fully_paid=true
          RETURNING id
        `)).rows;
        check(reopened.length===1, "UNPAID_ADVANCE_NOT_REOPENED");
        await logAudit({
          userId:"system:advance-no-cash",username:"system:advance-no-cash",
          companyId:COMPANY,action:"repair",tableName:"factory_worker_advances",
          recordId:277,recordIdentifier:"July 16 unrecovered advance #277",
          changes:{remainingBalance:{old:"0.00",new:"160.00"},fullyPaid:{old:true,new:false}},
        },tx);

        // The paid May 16 advance #103 was deleted November 3 after
        // payroll #686 had already recovered it. Restore the historical
        // advance *record*, leaving voucher #7838 retired and Cash untouched.
        const restored=(await tx.execute(sql`
          INSERT INTO factory_worker_advances
            (id,company_id,worker_id,advance_date,amount,notes,payroll_id,
             created_at,remaining_balance,cash_account_id,fully_paid,repayment_type)
          VALUES (103,${COMPANY},111,'2026-05-16',48.39,
            'Restored from original May 16 voucher #7838 and paid payroll #686',
            NULL,'2026-05-16 18:22:01.307973',0,${CASH},true,'salary_deduction')
          RETURNING id
        `)).rows;
        check(restored.length===1, "DELETED_ADVANCE_NOT_RESTORED");
        await logAudit({
          userId:"system:advance-no-cash",username:"system:advance-no-cash",
          companyId:COMPANY,action:"restore",tableName:"factory_worker_advances",
          recordId:103,recordIdentifier:"May 16 recovered advance #103",
          changes:{amount:{old:null,new:"48.39"},
                   originalVoucher:{old:"archived #7838",new:"archive preserved; no new Cash posting"}},
        },tx);
        await writeDaybookEntry(tx,{
          companyId:COMPANY,txDate:"2026-05-16",effectiveDate:"2026-05-16",
          txType:"ADVANCE_RESTORED",referenceId:103,
          referenceTable:"factory_worker_advances",
          description:"Historical May 16 advance #103 restored from archived voucher and paid payroll; no cash adjustment",
          amountUsd:0,amountCurrency:0,
          createdBy:"system:advance-no-cash",
        });

        const after=await snapshot(tx);
        validateNoCashAdvanceRepair(before,after);
        await logAudit({
          userId:"system:advance-no-cash",username:"system:advance-no-cash",
          companyId:COMPANY,action:"repair",tableName:"factory_advance_source_repair",
          recordId:COMPANY,recordIdentifier:AUDIT_MARKER,
          changes:{outstanding:{old:before.workerOutstanding,new:after.workerOutstanding},
                   cash:{old:"untouched",new:"untouched"},
                   remainingLedgerGap:{old:"211.61",new:"51.61"}},
        },tx);
        return {applied:true,outstanding:after.workerOutstanding,
                ledger:after.ledgerBalance,unresolvedDifference:"51.61",cashUnchanged:true};
      })
    ),
    "factory-advance-no-cash-source-repair"
  );
  logger.info("[startup] Guarded worker advance no-cash source reconciliation",result);
}

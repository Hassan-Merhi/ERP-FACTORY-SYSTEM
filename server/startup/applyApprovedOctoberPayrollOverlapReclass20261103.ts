/**
 * Exact-source, owner-approved October 2026 factory wage overpayment repair.
 *
 * Three workers had salary for the same attendance days generated and paid in
 * an earlier partial run, then generated and paid AGAIN by a full-month run on
 * 2026-11-03 (payment dated 2026-10-31). The overlapping partial-run GROSS
 * salary cannot be an additional wage: 9/14/3 days of base pay are also present
 * in the full-period 18/20/14 days and both payrolls use the identical date
 * range start, salary rate and attendance. Payment vouchers and Daybook show
 * both cash disbursements, so DO NOT reverse cash or erase the original vouchers.
 *
 * Accounting only: debit a documented employee payroll-overpayment receivable,
 * credit those workers' salary expense accounts (in October at actual payment
 * dates). Cash, operational advances, supplier accounts, payroll rows, Daybook
 * and all historical vouchers remain unchanged. Closed books are enforced by
 * the normal central journal posting engine; no bypass.
 *
 * DRAFT payroll is not cash paid, but the underlying workers have October
 * attendance and a posted accrual. DO NOT treat valid accrued wages as paid
 * nor automatically wipe the $582.26 to make cash = accrual expense.
 */
import { sql } from "drizzle-orm";
import { db, pool, type DbTransaction } from "../db";
import { logger } from "../lib/logger";
import { resultRows } from "../lib/queryResult";
import { toMoney } from "../lib/money";
import { findOrCreateLedger } from "../routes/payroll/_payrollAccountingHelper";
import { postErpVoucherTx } from "../services/accounting/erpVoucherPosting";
import { runInCompanyPostingScope } from "../services/accounting/scheduledPostingScope";

const COMPANY = 12;
const SERVICE = "srv-d6kibgtactks739u7vl0";
const DATABASE = "erp_db_qscj_64lv_e7rz_8744_2lm3";
const FLAG = "OCTOBER_2026_PAYROLL_OVERLAP_RECLASS";
const AUTHORIZATION = "approved-company12-backdated-overpayment-v1";
const ASSET_NAME = "Payroll Overpayments Receivable - October 2026";
const BEFORE = "47182.95";
const AFTER = "46747.14";
const CASH_BEFORE = "977.42";
const EXPECTED_ADVANCE_DEDUCTIONS = "280.00";
const VOUCHER_17 = "OCTPAY-OVERPAY-C12-20261017";
const VOUCHER_31 = "OCTPAY-OVERPAY-C12-20261031";

type Pair = Readonly<{
  workerId: number;
  partialId: number;
  fullId: number;
  partialEnd: string;
  originalDate: string;
  partBase: string;
  partTransport: string;
  partNet: string;
  partAdvances: string;
  fullBase: string;
  fullTransport: string;
  fullNet: string;
  fullAdvances: string;
  currentMonthlyRate: string;
  partPresent: number;
  partHalf: number;
  fullPresent: number;
  fullHalf: number;
  credit: string;
  salaryBefore: string;
}>;
const PAIRS: readonly Pair[] = [
  {
    workerId: 69, partialId: 1180, fullId: 1202,
    partialEnd: "2026-10-09", originalDate: "2026-10-17",
    partBase: "145.16", partTransport: "0.00",
    partNet: "145.16", partAdvances: "0.00",
    fullBase: "290.32", fullTransport: "0.00",
    fullNet: "290.32", fullAdvances: "0.00",
    currentMonthlyRate: "500.00",
    partPresent: 9, partHalf: 0, fullPresent: 18, fullHalf: 0,
    credit: "145.16", salaryBefore: "435.48",
  },
  {
    workerId: 140, partialId: 1183, fullId: 1204,
    partialEnd: "2026-10-17", originalDate: "2026-10-31",
    partBase: "203.23", partTransport: "36.13",
    partNet: "9.36", partAdvances: "230.00",
    fullBase: "290.32", fullTransport: "51.61",
    fullNet: "341.93", fullAdvances: "0.00",
    currentMonthlyRate: "450.00",
    partPresent: 13, partHalf: 2, fullPresent: 19, fullHalf: 2,
    credit: "239.36", salaryBefore: "581.29",
  },
  {
    workerId: 224, partialId: 1185, fullId: 1276,
    partialEnd: "2026-10-17", originalDate: "2026-10-31",
    partBase: "43.55", partTransport: "7.74",
    partNet: "1.29", partAdvances: "50.00",
    fullBase: "203.23", fullTransport: "36.13",
    fullNet: "189.36", fullAdvances: "50.00",
    currentMonthlyRate: "450.00",
    partPresent: 3, partHalf: 0, fullPresent: 14, fullHalf: 0,
    credit: "51.29", salaryBefore: "290.65",
  },
];
const fmt = (value: string | number | null | undefined): string => toMoney(value ?? "0").toFixed(2);

type PayrollRow = {
  id: number; worker_id: number; status: string; period_start: string; period_end: string;
  base_salary: string; transport: string; net_salary: string; advances: string;
  paid_at: string | null;
};
type Evidence = {
  payment_vouchers: number;
  payable_paid: string;
  daybook_count: number;
  daybook_paid: string;
};

async function salaryExpenseTotal(tx: DbTransaction): Promise<string> {
  const [row] = resultRows<{ net: string }>(await tx.execute(sql`
    SELECT COALESCE(sum(e.debit_amount-e.credit_amount),0)::text AS net
    FROM vouchers v
    JOIN voucher_entries e ON e.voucher_id=v.id AND e.company_id=${COMPANY}
    JOIN ledger_accounts la ON la.id=e.ledger_account_id AND la.company_id=${COMPANY}
    WHERE v.company_id=${COMPANY} AND v.optional=false AND v.deleted_at IS NULL
      AND COALESCE(v.effective_date,v.voucher_date) BETWEEN DATE '2026-10-01' AND DATE '2026-10-31'
      AND (la.name LIKE 'Salary Expense - %' OR la.parent_id IN (
        SELECT la2.id FROM ledger_accounts la2
        WHERE la2.company_id=${COMPANY}
          AND la2.name='Salary Expense - Workers' AND la2.deleted_at IS NULL
      ))
  `));
  return fmt(row?.net);
}

async function currentAdvanceBalances(tx: DbTransaction): Promise<string> {
  const [row] = resultRows<{ value: string }>(await tx.execute(sql`
    SELECT COALESCE(sum(remaining_balance),0)::text AS value
    FROM factory_worker_advances
    WHERE company_id=${COMPANY} AND worker_id IN (69,140,224)
  `));
  return fmt(row?.value);
}

async function postedPaymentEvidence(tx: DbTransaction, payrollId: number): Promise<Evidence> {
  const [row] = resultRows<Evidence>(await tx.execute(sql`
    SELECT
      (SELECT count(*)::int FROM vouchers v
       WHERE v.company_id=${COMPANY} AND v.deleted_at IS NULL
         AND v.voucher_number LIKE ('PAYMENT-PAY-' || ${payrollId}::text || '-%')
      ) AS payment_vouchers,
      (SELECT COALESCE(sum(e.debit_amount),0)::text FROM vouchers v
       JOIN voucher_entries e ON e.voucher_id=v.id AND e.company_id=${COMPANY}
       JOIN ledger_accounts la ON la.id=e.ledger_account_id AND la.company_id=${COMPANY}
       WHERE v.company_id=${COMPANY} AND v.deleted_at IS NULL
         AND v.voucher_number LIKE ('PAYMENT-PAY-' || ${payrollId}::text || '-%')
         AND la.name='Payroll Payable'
      ) AS payable_paid,
      (SELECT count(*)::int FROM factory_daybook_entries d
       WHERE d.company_id=${COMPANY} AND d.reference_table='factory_payrolls'
         AND d.reference_id=${payrollId} AND d.tx_type='PAYROLL_PAYMENT'
      ) AS daybook_count,
      (SELECT COALESCE(sum(d.amount_usd),0)::text FROM factory_daybook_entries d
       WHERE d.company_id=${COMPANY} AND d.reference_table='factory_payrolls'
         AND d.reference_id=${payrollId} AND d.tx_type='PAYROLL_PAYMENT'
      ) AS daybook_paid
  `));
  if(!row) throw new Error("OCT_PAYROLL_OVERLAP_MISSING_PAYMENT_EVIDENCE");
  return row;
}

async function sourceSnapshot(tx: DbTransaction) {
  const rows = resultRows<PayrollRow>(await tx.execute(sql`
    SELECT id, worker_id, status, period_start::text AS period_start,
           period_end::text AS period_end, base_salary::text AS base_salary,
           transport::text AS transport, net_salary::text AS net_salary,
           advances::text AS advances, paid_at::text AS paid_at
    FROM factory_payrolls
    WHERE company_id=${COMPANY}
      AND id IN (1180,1183,1185,1202,1204,1276)
    FOR UPDATE
  `));
  if (rows.length !== 6) throw new Error("OCT_PAYROLL_OVERLAP_SOURCE_ROWS_CHANGED");
  const byId = new Map(rows.map((row) => [Number(row.id), row]));
  for (const pair of PAIRS) {
    const [partial, full] = [byId.get(pair.partialId), byId.get(pair.fullId)];
    if (!partial || !full) throw new Error("OCT_PAYROLL_OVERLAP_PAYROLL_MISSING_" + pair.workerId);
    for (const [row, isPartial] of [[partial,true],[full,false]] as const) {
      const expectedEnd = isPartial ? pair.partialEnd : "2026-10-31";
      const date = isPartial ? pair.originalDate : "2026-10-31";
      if (row.worker_id !== pair.workerId || row.status !== "PAID" ||
          row.period_start !== "2026-10-01" || row.period_end !== expectedEnd ||
          row.paid_at?.slice(0,10) !== date ||
          fmt(row.base_salary) !== (isPartial ? pair.partBase : pair.fullBase) ||
          fmt(row.transport) !== (isPartial ? pair.partTransport : pair.fullTransport) ||
          fmt(row.net_salary) !== (isPartial ? pair.partNet : pair.fullNet) ||
          fmt(row.advances) !== (isPartial ? pair.partAdvances : pair.fullAdvances)) {
        throw new Error("OCT_PAYROLL_OVERLAP_PAYROLL_SNAPSHOT_CHANGED_" + pair.workerId);
      }
      const evidence=await postedPaymentEvidence(tx,row.id);
      if (Number(evidence.payment_vouchers)!==1 || Number(evidence.daybook_count)!==1 ||
          fmt(evidence.payable_paid)!==fmt(row.net_salary) ||
          fmt(evidence.daybook_paid)!==fmt(row.net_salary)) {
        throw new Error("OCT_PAYROLL_OVERLAP_PAYMENT_EVIDENCE_CHANGED_" + row.id);
      }
    }
    const [attendance] = resultRows<{
      partial_present:number; partial_half:number; full_present:number;full_half:number;
      monthly_rate:string;
    }>(await tx.execute(sql`
      SELECT count(*) FILTER (WHERE attendance_date<=${pair.partialEnd}::date
                                 AND status='Present')::int AS partial_present,
             count(*) FILTER (WHERE attendance_date<=${pair.partialEnd}::date
                                 AND status='Half Day')::int AS partial_half,
             count(*) FILTER (WHERE status='Present')::int AS full_present,
             count(*) FILTER (WHERE status='Half Day')::int AS full_half,
             (SELECT base_salary::text FROM factory_workers w
               WHERE w.id=${pair.workerId} AND w.company_id=${COMPANY}) AS monthly_rate
      FROM factory_attendance
      WHERE company_id=${COMPANY} AND worker_id=${pair.workerId}
        AND attendance_date BETWEEN DATE '2026-10-01' AND DATE '2026-10-31'
    `));
    if (!attendance || attendance.partial_present!==pair.partPresent ||
        attendance.partial_half!==pair.partHalf ||
        attendance.full_present!==pair.fullPresent ||
        attendance.full_half!==pair.fullHalf ||
        fmt(attendance.monthly_rate)!==pair.currentMonthlyRate) {
      throw new Error("OCT_PAYROLL_OVERLAP_ATTENDANCE_CHANGED_" + pair.workerId);
    }
    const partEarned=toMoney(pair.currentMonthlyRate)
      .times(pair.partPresent + pair.partHalf*0.5).div(31).toDecimalPlaces(2).toFixed(2);
    const fullEarned=toMoney(pair.currentMonthlyRate)
      .times(pair.fullPresent + pair.fullHalf*0.5).div(31).toDecimalPlaces(2).toFixed(2);
    if (partEarned!==pair.partBase || fullEarned!==pair.fullBase ||
        toMoney(pair.partNet).plus(pair.partAdvances).toFixed(2)!==pair.credit) {
      throw new Error("OCT_PAYROLL_OVERLAP_EARNINGS_NOT_DUPLICATED_" + pair.workerId);
    }
  }
  const overpaid=PAIRS.reduce((v,p)=>v.plus(p.credit),toMoney("0")).toFixed(2);
  const duplicatedAdvance=PAIRS.reduce((v,p)=>v.plus(p.partAdvances),toMoney("0")).toFixed(2);
  if (overpaid!=="435.81" || duplicatedAdvance!==EXPECTED_ADVANCE_DEDUCTIONS) {
    throw new Error("OCT_PAYROLL_OVERLAP_TOTAL_CHANGED");
  }
}

async function salaryExpenseAccount(tx: DbTransaction, workerId:number, expectedNet:string):Promise<number> {
  const [row] = resultRows<{ id:number; actual:string }>(await tx.execute(sql`
    SELECT la.id,
      COALESCE(sum(e.debit_amount-e.credit_amount),0)::text AS actual
    FROM ledger_accounts la
    JOIN factory_workers w ON w.company_id=la.company_id
      AND w.id=${workerId} AND la.name=('Salary Expense - ' || w.full_name)
    JOIN voucher_entries e ON e.ledger_account_id=la.id AND e.company_id=${COMPANY}
    JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=${COMPANY}
    WHERE la.company_id=${COMPANY} AND la.deleted_at IS NULL
      AND v.deleted_at IS NULL AND v.optional=false
      AND COALESCE(v.effective_date,v.voucher_date) BETWEEN DATE '2026-10-01' AND DATE '2026-10-31'
    GROUP BY la.id
  `));
  if (!row || fmt(row.actual)!==expectedNet) {
    throw new Error("OCT_PAYROLL_OVERLAP_SALARY_ACCOUNT_CHANGED_" + workerId);
  }
  return Number(row.id);
}

async function relevantCashDaybookTotal(tx:DbTransaction):Promise<string> {
  const [row]=resultRows<{ cash:string }>(await tx.execute(sql`
    SELECT COALESCE(sum(amount_usd),0)::text AS cash
    FROM factory_daybook_entries
    WHERE company_id=${COMPANY} AND tx_type='PAYROLL_PAYMENT'
      AND reference_table='factory_payrolls'
      AND reference_id IN (1180,1183,1185,1202,1204,1276)
  `));
  return fmt(row?.cash);
}

export async function applyApprovedOctoberPayrollOverlapReclass20261103():Promise<void> {
  if(process.env[FLAG]!==AUTHORIZATION)return;
  if(process.env.RENDER_SERVICE_ID!==SERVICE)throw new Error("OCT_PAYROLL_OVERLAP_WRONG_SERVICE");
  const [database]=(await pool.query<{name:string}>("SELECT current_database() AS name")).rows;
  if(database?.name!==DATABASE)throw new Error("OCT_PAYROLL_OVERLAP_WRONG_DATABASE");

  const outcome=await runInCompanyPostingScope(COMPANY,()=>db.transaction(async(tx)=>{
    await tx.execute(sql`SELECT pg_advisory_xact_lock(20261103, 121017)`);
    const existing=resultRows<{voucher_number:string}>(await tx.execute(sql`
      SELECT voucher_number FROM vouchers
      WHERE company_id=${COMPANY} AND deleted_at IS NULL
        AND voucher_number IN (${VOUCHER_17},${VOUCHER_31})
    `));
    if(existing.length===1)throw new Error("OCT_PAYROLL_OVERLAP_PARTIALLY_APPLIED");
    const before=await salaryExpenseTotal(tx);
    const expected=existing.length===2?AFTER:BEFORE;
    if(before!==expected)throw new Error("OCT_PAYROLL_OVERLAP_SALARY_BEFORE_CHANGED_"+before);
    await sourceSnapshot(tx);
    const balancesBefore=await currentAdvanceBalances(tx);
    const cashBefore=await relevantCashDaybookTotal(tx);
    if(cashBefore!==CASH_BEFORE)throw new Error("OCT_PAYROLL_OVERLAP_CASH_CHANGED_"+cashBefore);
    if(existing.length===2)return {status:"already_applied",salaryExpense:before,
      unchangedWorkerAdvances:balancesBefore,unchangedCash:cashBefore};

    const accountIds=new Map<number,number>();
    for(const pair of PAIRS){
      accountIds.set(pair.workerId,await salaryExpenseAccount(tx,pair.workerId,pair.salaryBefore));
    }
    const receivable=await findOrCreateLedger(COMPANY,ASSET_NAME,"Asset",undefined,tx);
    const first=await postErpVoucherTx(tx,{
      companyId:COMPANY,voucherNumber:VOUCHER_17,voucherType:"Journal",
      voucherDate:"2026-10-17",sourceModule:"FACTORY",
      description:"Audited October 2026 duplicate salary: worker 69 partial payroll 1180 already included in full-month payroll 1202. Cash and worker advances unchanged; employee overpayment receivable.",
      source:{type:"october-2026-payroll-overlap",id:"company12:2026-10-17:worker69:v1"},
      lines:[
        {ledgerAccountId:receivable.id,debit:"145.16",narration:"Oct 17 duplicate wages paid; worker 69 / payroll 1180 / full 1202"},
        {ledgerAccountId:accountIds.get(69)!,credit:"145.16",narration:"Reverse duplicated 9-day salary expense, preserving actual payment"},
      ],
    });
    const second=await postErpVoucherTx(tx,{
      companyId:COMPANY,voucherNumber:VOUCHER_31,voucherType:"Journal",
      voucherDate:"2026-10-31",sourceModule:"FACTORY",
      description:"Audited October 2026 duplicate salary: worker 140 partial payroll 1183/full 1204 and worker 224 partial 1185/full 1276. No cash or advance adjustment.",
      source:{type:"october-2026-payroll-overlap",id:"company12:2026-10-31:workers140-224:v1"},
      lines:[
        {ledgerAccountId:receivable.id,debit:"290.65",narration:"Oct 31 duplicate paid gross; worker 140 239.36 + worker 224 51.29"},
        {ledgerAccountId:accountIds.get(140)!,credit:"239.36",narration:"Reverse duplicate 14-day payroll 1183 already in 1204"},
        {ledgerAccountId:accountIds.get(224)!,credit:"51.29",narration:"Reverse duplicate 3-day payroll 1185 already in 1276"},
      ],
    });
    if(first.replayed||second.replayed)throw new Error("OCT_PAYROLL_OVERLAP_UNEXPECTED_POSTING_REPLAY");
    const after=await salaryExpenseTotal(tx);
    const balancesAfter=await currentAdvanceBalances(tx);
    const cashAfter=await relevantCashDaybookTotal(tx);
    if(after!==AFTER||balancesBefore!==balancesAfter||cashBefore!==cashAfter){
      throw new Error("OCT_PAYROLL_OVERLAP_POSTCONDITION_FAILED");
    }
    return {status:"posted",voucherIds:[first.voucher.id,second.voucher.id],
      salaryBefore:before,salaryAfter:after,overpaymentReceivable:"435.81",
      unchangedCash:cashAfter,unchangedWorkerAdvances:balancesAfter,
      draftsRemainAccrued:"582.26"};
  }),"owner-approved-october-payroll-overpayment-c12");
  logger.info("[startup] October payroll overlap accounting reconciliation",{
    companyId:COMPANY,accountingSnapshots:outcome,
  });
}

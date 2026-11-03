/**
 * One-time historical GL correction for Factory Worker Advances (company 12).
 *
 * Reconciles the exact $51.61 difference after verified source repair #2786
 * WITHOUT changing Cash, payroll rows, supplier accounts, worker advances,
 * original vouchers, opening balances, or any other live source.
 *
 * Source-supported parts:
 *  - May 17 PAID payroll #672 recovered the final $0.01 of advance #131
 *    (its May 16 payroll #669 recovered $239.35, total $239.36). No
 *    May 17 payroll accrual posted that cent.
 *  - July 10 account opening was manually set from $0 to $299.99 in two
 *    audited edits, while historical unposted advances #3 ($200, March 12)
 *    and #103 ($48.39, May 16, now archived cash voucher) explain $248.39
 *    of this legacy offset. Thus the unsupported $51.60 is an overstatement
 *    of historical opening receivables and is reclassified against Opening
 *    Balance Equity, NOT Cash, salary expense or a random adjustments account.
 *
 * Both vouchers use original effective dates; audit created_at remains current.
 * The complete operation is atomic, idempotent, production-only, fail-closed,
 * separately opted-in, and checks every named historical source.
 */
import { sql } from "drizzle-orm";
import { db, pool, type DbTransaction } from "../db";
import { logger } from "../lib/logger";
import { toMoney } from "../lib/money";
import { postErpVoucherTx } from "../services/accounting/erpVoucherPosting";
import { runInCompanyPostingScope } from "../services/accounting/scheduledPostingScope";
import { runWithAuditReason } from "../services/audit/auditActorContext";
import { logAudit } from "../routes/helpers/auditHelpers";

const COMPANY = 12;
const ADVANCES = 796;
const CASH = 707;
const PAYABLE = 811;
const EQUITY = 3746;
const SERVICE = "srv-d6kibgtactks739u7vl0";
const DATABASE = "erp_db_qscj_64lv_e7rz_8744_2lm3";
const ENV = "FACTORY_ADVANCE_GL_NONCASH_RECONCILE_20261103";
const ENABLE = "approved-company12-may17-july10-original-dates-v1";
const MARKER = "factory-advances-company12-51-61-20261103-noncash";
const SOURCE = "factory-advance-verified-noncash-gl";
type Row = Record<string,unknown>;
type AccountBalance = {opening:string;dr:string;cr:string};
type Snapshot = {
  outstanding:string; advanced:string; payroll:string; repaid:string;
  advances:AccountBalance; cash:AccountBalance; payable:AccountBalance; equity:AccountBalance;
};
const cent = (v:unknown) => toMoney(String(v??0)).toFixed(2);
function must(v:unknown, code:string): asserts v {
  if (!v) throw new Error("FACTORY_ADVANCE_NONCASH_GL_"+code);
}

export function advanceLedgerBalance(s:Snapshot):string {
  return toMoney(s.advances.opening).plus(s.advances.dr).minus(s.advances.cr).toFixed(2);
}
function eqBalance(a:AccountBalance,b:AccountBalance):boolean {
  return a.opening===b.opening && a.dr===b.dr && a.cr===b.cr;
}
export function validateNonCashHistoricalGLRepair(before:Snapshot,after:Snapshot):void {
  must(before.advanced==="91538.29" && before.outstanding==="2675.00" &&
       before.payroll==="88690.29" && before.repaid==="173.00", "SOURCE_TOTALS_CHANGED");
  must(before.advances.opening==="299.99" &&
       before.advances.dr==="91201.90" && before.advances.cr==="88775.28" &&
       advanceLedgerBalance(before)==="2726.61", "ADVANCES_LEDGER_CHANGED");
  must(before.equity.opening==="0.00" && before.equity.dr==="0.00" &&
       before.equity.cr==="0.00", "OPENING_EQUITY_NOT_EMPTY");
  must(after.advanced===before.advanced && after.outstanding===before.outstanding &&
       after.payroll===before.payroll && after.repaid===before.repaid,
       "WORKER_OR_PAYROLL_CHANGED");
  must(eqBalance(after.cash,before.cash), "CASH_CHANGED");
  must(after.advances.opening===before.advances.opening &&
       after.advances.dr===before.advances.dr &&
       cent(toMoney(after.advances.cr).minus(before.advances.cr))==="51.61" &&
       advanceLedgerBalance(after)==="2675.00", "ADVANCES_POSTCHECK");
  must(after.payable.opening===before.payable.opening &&
       cent(toMoney(after.payable.dr).minus(before.payable.dr))==="0.01" &&
       after.payable.cr===before.payable.cr, "PAYROLL_PAYABLE_POSTCHECK");
  must(after.equity.opening===before.equity.opening &&
       cent(toMoney(after.equity.dr).minus(before.equity.dr))==="51.60" &&
       after.equity.cr===before.equity.cr, "EQUITY_POSTCHECK");
}

async function snapshot(tx:DbTransaction):Promise<Snapshot> {
  const [row] = (await tx.execute(sql`
    WITH advancements AS (
      SELECT COALESCE(SUM(amount),0) AS original,
             COALESCE(SUM(remaining_balance) FILTER (WHERE fully_paid=false),0) AS remaining
      FROM factory_worker_advances WHERE company_id=${COMPANY}
    ), payroll AS (
      SELECT COALESCE(SUM(advances),0) AS paid
      FROM factory_payrolls WHERE company_id=${COMPANY}
    ), manual AS (
      SELECT COALESCE(SUM(amount),0) AS repaid
      FROM factory_advance_repayments WHERE company_id=${COMPANY}
    ), ledger AS (
      SELECT account.id,account.opening_balance,
             COALESCE(SUM(e.debit_amount) FILTER(WHERE v.deleted_at IS NULL),0) AS dr,
             COALESCE(SUM(e.credit_amount) FILTER(WHERE v.deleted_at IS NULL),0) AS cr
      FROM ledger_accounts account
      LEFT JOIN voucher_entries e ON e.ledger_account_id=account.id AND e.company_id=${COMPANY}
      LEFT JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=${COMPANY}
      WHERE account.company_id=${COMPANY}
        AND account.id IN (${CASH},${ADVANCES},${PAYABLE},${EQUITY})
      GROUP BY account.id
    )
    SELECT (SELECT original FROM advancements)::text AS original,
           (SELECT remaining FROM advancements)::text AS remaining,
           (SELECT paid FROM payroll)::text AS payroll,
           (SELECT repaid FROM manual)::text AS repaid,
           (SELECT jsonb_object_agg(id::text, jsonb_build_object(
              'opening',opening_balance::text,'dr',dr::text,'cr',cr::text)) FROM ledger) AS accounts
  `)).rows as Row[];
  must(row?.accounts && typeof row.accounts==="object", "ACCOUNT_SNAPSHOT_MISSING");
  const accounts = row.accounts as Record<string,Record<string,unknown>>;
  function get(id:number):AccountBalance {
    const a = accounts[String(id)];
    must(a,"ACCOUNT_MISSING_"+id);
    return {opening:cent(a.opening),dr:cent(a.dr),cr:cent(a.cr)};
  }
  return {
    outstanding:cent(row.remaining),advanced:cent(row.original),
    payroll:cent(row.payroll),repaid:cent(row.repaid),
    cash:get(CASH),advances:get(ADVANCES),payable:get(PAYABLE),equity:get(EQUITY),
  };
}

async function requireOriginalEvidence(tx:DbTransaction):Promise<void> {
  const accounts = (await tx.execute(sql`
    SELECT id,name,account_type,active,deleted_at,opening_balance
    FROM ledger_accounts WHERE company_id=${COMPANY} AND
      id IN (${CASH},${ADVANCES},${PAYABLE},${EQUITY})
    ORDER BY id FOR SHARE
  `)).rows as Row[];
  must(accounts.length===4 && accounts.every((x)=>x.active===true && x.deleted_at==null),
       "ACCOUNT_MAPPING_CHANGED");
  for(const [id,name,type] of [
    [CASH,"Cash","Cash"],[ADVANCES,"Factory Worker Advances","Asset"],
    [PAYABLE,"Payroll Payable","Liability"],[EQUITY,"Opening Balance Equity","Equity"]
  ] as const) {
    must(accounts.some((a)=>Number(a.id)===id && a.name===name &&
         a.account_type===type), "ACCOUNT_INVALID_"+id);
  }

  const advances = (await tx.execute(sql`
    SELECT id,worker_id,amount,advance_date::text AS date,fully_paid,remaining_balance
    FROM factory_worker_advances WHERE company_id=${COMPANY}
      AND id IN (3,103,131)
    ORDER BY id FOR SHARE
  `)).rows as Row[];
  must(advances.length===3,"ADVANCE_EVIDENCE_MISSING");
  for(const [id,worker,date,amount,remaining,paid] of [
    [3,45,"2026-03-12","200.00","115.00",false],
    [103,111,"2026-05-16","48.39","0.00",true],
    [131,133,"2026-05-16","239.36","0.00",true]
  ] as const){
    const a=advances.find((x)=>Number(x.id)===id);
    must(a && Number(a.worker_id)===worker && a.date===date &&
         cent(a.amount)===amount && cent(a.remaining_balance)===remaining &&
         a.fully_paid===paid, "ADVANCE_CHANGED_"+id);
  }
  const payrolls = (await tx.execute(sql`
    SELECT id,worker_id,period_start::text AS start,period_end::text AS ended,
           advances,net_salary,status
    FROM factory_payrolls WHERE company_id=${COMPANY} AND id IN (669,672,686)
    ORDER BY id FOR SHARE
  `)).rows as Row[];
  must(payrolls.length===3,"PAYROLL_SOURCE_MISSING");
  for(const [id,worker,start,end,advance,net] of [
    [669,133,"2026-05-01","2026-05-16","239.35","0.00"],
    [672,133,"2026-05-17","2026-05-17","0.01","-0.01"],
    [686,111,"2026-05-01","2026-05-16","48.39","0.00"]
  ] as const){
    const p=payrolls.find((x)=>Number(x.id)===id);
    must(p && Number(p.worker_id)===worker && p.start===start && p.ended===end &&
         cent(p.advances)===advance && cent(p.net_salary)===net &&
         p.status==="PAID","PAYROLL_CHANGED_"+id);
  }
  const [history] = (await tx.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE record_id=${ADVANCES} AND id=3659 AND action='update'
         AND changes->'openingBalance'->>'old'='0.00'
         AND changes->'openingBalance'->>'new'='180.01')::int AS first_edit,
      COUNT(*) FILTER (WHERE record_id=${ADVANCES} AND id=3660 AND action='update'
         AND changes->'openingBalance'->>'old'='180.01'
         AND changes->'openingBalance'->>'new'='299.99')::int AS second_edit
    FROM audit_log WHERE company_id=${COMPANY} AND table_name='ledger_accounts'
  `)).rows as Row[];
  must(Number(history?.first_edit)===1 && Number(history?.second_edit)===1,
       "HISTORICAL_OPENING_AUDIT_CHANGED");
  const [vouchers] = (await tx.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE id=7838 AND voucher_date='2026-05-16' AND deleted_at IS NOT NULL)::int AS retired_may,
      COUNT(*) FILTER (WHERE id=7904 AND voucher_date='2026-05-01' AND deleted_at IS NULL)::int AS recorded_payroll,
      COUNT(*) FILTER (WHERE deleted_at IS NULL AND
        (voucher_number LIKE 'PAYMENT-ADV-3-%' OR
         voucher_number LIKE 'PAYMENT-ADV-103-%' OR
         voucher_number='PAYROLL-GEN-${COMPANY}-2026-05-17-2026-05-17'))::int AS unexpected
    FROM vouchers WHERE company_id=${COMPANY}
  `)).rows as Row[];
  must(Number(vouchers?.retired_may)===1 &&
       Number(vouchers?.recorded_payroll)===1 &&
       Number(vouchers?.unexpected)===0,"ORIGINAL_VOUCHER_CHANGED");

  const [closed] = (await tx.execute(sql`
    SELECT count(*)::int AS n FROM fiscal_period_closures
    WHERE company_id=${COMPANY} AND status='CLOSED'
  `)).rows as Row[];
  must(Number(closed?.n)===0, "PERIOD_CLOSED");
  const [previous] = (await tx.execute(sql`
    SELECT count(*)::int AS n FROM vouchers WHERE company_id=${COMPANY} AND
    deleted_at IS NULL AND description LIKE 'Historical worker advances GL reconciliation %'
  `)).rows as Row[];
  must(Number(previous?.n)===0, "PREVIOUS_ADJUSTMENT_FOUND");
}

export async function runApprovedFactoryWorkerAdvanceNonCashGLRepair():Promise<void> {
  if(process.env[ENV]!==ENABLE) return;
  must(process.env.RENDER_SERVICE_ID===SERVICE, "WRONG_SERVICE");
  const dbinfo=await pool.query<{name:string}>("SELECT current_database() AS name");
  must(dbinfo.rows[0]?.name===DATABASE,"WRONG_DATABASE");

  const result=await runInCompanyPostingScope(COMPANY,()=>
    runWithAuditReason(
      "Owner-approved May 17 one-cent payroll and July 10 unsupported advance opening reconciliation; Cash not changed",
      ()=>db.transaction(async tx=>{
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('company12-worker-advance-51-61-noncash'))`);
        const [marker]=(await tx.execute(sql`
          SELECT count(*)::int AS n FROM audit_log WHERE company_id=${COMPANY}
            AND table_name='factory_advance_gl_reconciliation'
            AND record_identifier=${MARKER}
        `)).rows as Row[];
        if(Number(marker?.n)===1) {
          const current=await snapshot(tx);
          return {posted:false,alreadyApplied:true,ledger:advanceLedgerBalance(current)};
        }
        must(Number(marker?.n)===0,"DUPLICATE_MARKER");
        const before=await snapshot(tx);
        await requireOriginalEvidence(tx);
        must(advanceLedgerBalance(before)==="2726.61" &&
             before.outstanding==="2675.00" &&
             before.advanced==="91538.29" &&
             before.payroll==="88690.29" && before.repaid==="173.00",
             "SOURCE_BALANCES_CHANGED");
        must(before.advances.opening==="299.99" &&
             before.advances.dr==="91201.90" && before.advances.cr==="88775.28" &&
             before.equity.opening==="0.00" && before.equity.dr==="0.00" &&
             before.equity.cr==="0.00","ACCOUNTING_BEFORE_IMAGE_CHANGED");

        const may=await postErpVoucherTx(tx,{
          companyId:COMPANY,voucherType:"Journal",
          voucherDate:"2026-05-17",effectiveDate:"2026-05-17",
          currency:"USD",sourceModule:"FACTORY",
          description:"Historical worker advances GL reconciliation: May 17 paid payroll #672 final cent of advance #131",
          source:{type:SOURCE,id:"12:payroll672:2026-05-17"},
          lines:[
            {ledgerAccountId:PAYABLE,debit:"0.01",narration:"Negative net salary on paid May 17 payroll #672; clear accrued payable"},
            {ledgerAccountId:ADVANCES,credit:"0.01",narration:"Final cent of advance #131 recovered by paid payroll #672"},
          ],
        });
        must(!may.replayed,"MAY_REPLAY");

        const july=await postErpVoucherTx(tx,{
          companyId:COMPANY,voucherType:"Journal",
          voucherDate:"2026-07-10",effectiveDate:"2026-07-10",
          currency:"USD",sourceModule:"FACTORY",
          description:"Historical worker advances GL reconciliation: July 10 audited unsupported opening excess",
          source:{type:SOURCE,id:"12:opening796:2026-07-10"},
          lines:[
            {ledgerAccountId:EQUITY,debit:"51.60",narration:"Unsupported portion of manually entered $299.99 July 10 advance opening; $200 March and $48.39 May legacy advances account for $248.39"},
            {ledgerAccountId:ADVANCES,credit:"51.60",narration:"Remove legacy opening receivable overstatement; preserve Cash and original disbursements"},
          ],
        });
        must(!july.replayed,"JULY_REPLAY");

        const after=await snapshot(tx);
        validateNonCashHistoricalGLRepair(before,after);
        await logAudit({
          userId:"system:factory-advance-gl",
          username:"system:factory-advance-gl",
          companyId:COMPANY,action:"repair",
          tableName:"factory_advance_gl_reconciliation",recordId:ADVANCES,
          recordIdentifier:MARKER,
          changes:{
            ledger:{old:advanceLedgerBalance(before),new:advanceLedgerBalance(after)},
            outstanding:{old:before.outstanding,new:after.outstanding},
            cash:{old:"unchanged",new:"unchanged"},
            payrollSource:{old:"May 17 recovery missing from GL",new:"May 17 dated voucher $0.01"},
            openingSource:{old:"July 10 excess $51.60",new:"July 10 dated equity reclassification"}
          }
        },tx);
        return {posted:true,ledger:advanceLedgerBalance(after),workerOutstanding:after.outstanding,
          cashUnchanged:true,mayVoucherId:may.voucherId,julyVoucherId:july.voucherId};
      })
    ),
    "owner-approved-factory-advance-51-61-gl-repair"
  );
  logger.info("[startup] Factory advances dated noncash GL reconciliation",result);
}

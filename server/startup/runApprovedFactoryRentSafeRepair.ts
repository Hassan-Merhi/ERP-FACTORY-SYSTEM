/**
 * Owner-approved Factory rent history cleanup, company 12, November 2026.
 * No new vouchers, no cash movement, no Prepaid Rent (#2202) edits.
 * The missing November Warehouse 5001 prepaid recognition is intentionally
 * NOT posted: owner froze the $29,566.66 prepaid asset until separately reviewed.
 */
import { sql } from "drizzle-orm";
import { db, pool, type DbTransaction } from "../db";
import { logger } from "../lib/logger";
import { writeAuditEvent } from "../services/audit";
import { runAsSystemAuditActor, runWithAuditReason } from "../services/audit/auditActorContext";
import { companyClosedThrough, isDateInClosedPeriod, runInCompanyPostingScope } from "../services/accounting/scheduledPostingScope";
import { retireVouchersTx } from "../services/accounting/voucherRetirement";

const COMPANY = 12;
const PREPAID = 2202;
const EXPENSE = 868;
const PAYABLE = 2220;
const ACTOR = {userId:"system:factory-rent-review-20261109", username:"system"};
const OPT_IN = "company12-keep-prepaid29566.66-retire13139-fix-memos";
const SERVICE = "srv-d6kibgtactks739u7vl0";
const DATABASE = "erp_db_qscj_64lv_e7rz_8744_2lm3";
const rentLabel = "Rent paid - LEBANON, BEIRUT PORT/MAIN FACTORY L9 - ";
type Row = Record<string, unknown>;
const n = (v:unknown)=>Number(v ?? 0);
function requireExact(ok:unknown, reason:string): asserts ok {
  if(!ok) throw new Error("FACTORY_RENT_SAFE_REPAIR_REFUSED_"+reason);
}
async function balances(tx:DbTransaction) {
  const result = (await tx.execute(sql`
    SELECT e.ledger_account_id AS id, SUM(e.debit_amount-e.credit_amount)::text AS amount
    FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=${COMPANY}
    WHERE e.company_id=${COMPANY} AND e.ledger_account_id IN (${EXPENSE},${PREPAID},${PAYABLE})
      AND v.deleted_at IS NULL AND v.optional=false
    GROUP BY e.ledger_account_id
  `)).rows as Row[];
  const get = (id:number)=>n(result.find(r=>n(r.id)===id)?.amount);
  return {expense:get(EXPENSE), prepaid:get(PREPAID), payable:get(PAYABLE)};
}

async function apply(tx:DbTransaction) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('factory-rent-20261109-safe-no-prepaid'))`);
  const original = (await tx.execute(sql`
    SELECT v.id AS voucher_id,v.voucher_number,v.voucher_date::text AS voucher_date,
      v.deleted_at::text AS deleted_at,v.description,v.optional,v.voucher_type,
      e.id AS line_id,e.ledger_account_id,e.debit_amount,e.credit_amount,e.narration
    FROM vouchers v JOIN voucher_entries e ON e.voucher_id=v.id AND e.company_id=${COMPANY}
    WHERE v.company_id=${COMPANY} AND v.id IN (13139,14317,14318,10544,16951)
    ORDER BY v.id,e.id FOR UPDATE OF v,e
  `)).rows as Row[];
  requireExact(original.length===13,"LINES_OR_VOUCHERS_CHANGED");
  const get=(id:number)=>original.filter(r=>n(r.voucher_id)===id);
  const duplicate=get(13139);
  const done=duplicate.length===2 && duplicate.every(r=>r.deleted_at!==null);
  requireExact(duplicate.length===2 &&
    duplicate.every(r=>r.optional===false && r.voucher_type==="Journal" &&
      (done ? String(r.voucher_number).endsWith("~DEL13139")
            : r.voucher_number==="ACCR-RENT-1788256800716-900n")) &&
    duplicate.some(r=>n(r.ledger_account_id)===EXPENSE && n(r.debit_amount)===1416.67 && n(r.credit_amount)===0) &&
    duplicate.some(r=>n(r.ledger_account_id)===PAYABLE && n(r.credit_amount)===1416.67 && n(r.debit_amount)===0),
    "DUPLICATE_VOUCHER_DRIFT");
  const validSept=get(14317);
  requireExact(validSept.length===2 && validSept.every(r=>r.deleted_at===null) &&
    validSept.some(r=>n(r.ledger_account_id)===EXPENSE && n(r.debit_amount)===1416.67) &&
    validSept.some(r=>n(r.ledger_account_id)===PAYABLE && n(r.credit_amount)===1416.67),
    "REAL_SEPTEMBER_ACCRUAL_CHANGED");
  const payment=get(14318);
  requireExact(payment.length===3 && payment.every(r=>r.deleted_at===null) &&
    payment.some(r=>n(r.ledger_account_id)===PAYABLE && n(r.debit_amount)===1416.67) &&
    payment.some(r=>n(r.ledger_account_id)===PREPAID && n(r.debit_amount)===15583.33),
    "WAREHOUSE_PAYMENT_CHANGED");
  const october=get(10544);
  requireExact(october.length===2 && october.every(r=>r.deleted_at===null) &&
    october.some(r=>n(r.ledger_account_id)===EXPENSE && n(r.debit_amount)===20000) &&
    october.some(r=>n(r.ledger_account_id)===707 && n(r.credit_amount)===20000) &&
    october.every(r=>r.description===(done ? rentLabel+"10/2026" : rentLabel+"07/2026")),
    "OCTOBER_PAYMENT_CHANGED");
  const november=get(16951);
  requireExact(november.length===4 && november.every(r=>r.deleted_at===null) &&
    november.some(r=>n(r.ledger_account_id)===EXPENSE && n(r.debit_amount)===20000) &&
    november.some(r=>n(r.ledger_account_id)===EXPENSE && n(r.debit_amount)===600) &&
    november.some(r=>n(r.ledger_account_id)===PAYABLE && n(r.credit_amount)===20000) &&
    november.some(r=>n(r.ledger_account_id)===PREPAID && n(r.credit_amount)===600),
    "NOVEMBER_MIXED_JOURNAL_CHANGED");

  const refs=(await tx.execute(sql`
    SELECT id,contract_id,year,month,expected_amount,paid_amount,
      accrual_voucher_id,used_prepaid_account
    FROM property_monthly_ledger WHERE company_id=${COMPANY}
      AND id IN (693895,897648,889112,889178) ORDER BY id FOR UPDATE
  `)).rows as Row[];
  const row=(id:number)=>refs.find(r=>n(r.id)===id);
  requireExact(refs.length===4 &&
    n(row(693895)?.contract_id)===10 && n(row(693895)?.month)===10 &&
    n(row(693895)?.paid_amount)===20000 &&
    n(row(897648)?.contract_id)===10 && n(row(897648)?.month)===11 &&
    n(row(897648)?.paid_amount)===0 && n(row(897648)?.accrual_voucher_id)===16951 &&
    row(897648)?.used_prepaid_account === !done &&
    n(row(889112)?.accrual_voucher_id)===14317 &&
    n(row(889178)?.expected_amount)===0 &&
    n(row(889178)?.paid_amount)===1416.67 &&
    row(889178)?.accrual_voucher_id==null,
    "RENTAL_SCHEDULE_DRIFT");
  const paidOctober=(await tx.execute(sql`
    SELECT id,voucher_id,ledger_row_id,for_month,for_year,amount,posting_status
    FROM property_payments WHERE company_id=${COMPANY} AND id=290
  `)).rows as Row[];
  requireExact(paidOctober.length===1 && n(paidOctober[0].voucher_id)===10544 &&
    n(paidOctober[0].ledger_row_id)===693895 &&
    n(paidOctober[0].for_month)===10 && n(paidOctober[0].amount)===20000 &&
    paidOctober[0].posting_status==="POSTED", "OCTOBER_ALLOCATION_DRIFT");

  const before=await balances(tx);
  const expected=done
    ? {expense:228833.34,prepaid:29566.66,payable:-20000}
    : {expense:230250.01,prepaid:29566.66,payable:-21416.67};
  requireExact(Object.keys(expected).every(key =>
    Math.abs((before as unknown as Record<string,number>)[key]-
      (expected as unknown as Record<string,number>)[key])<0.005),"BALANCE_DRIFT");
  if(done)return {applied:false,balances:before};

  const closed=await companyClosedThrough(COMPANY,tx);
  requireExact(!isDateInClosedPeriod(closed,"2026-07-13") &&
    !isDateInClosedPeriod(closed,"2026-09-01") &&
    !isDateInClosedPeriod(closed,"2026-11-01"),"PERIOD_CLOSED");

  // October's original $20k voucher belongs to October, not July.
  const label=rentLabel+"10/2026";
  const header=(await tx.execute(sql`
    UPDATE vouchers SET description=${label}
    WHERE company_id=${COMPANY} AND id=10544 AND description=${rentLabel+"07/2026"}
    RETURNING id
  `)).rows;
  const memo=(await tx.execute(sql`
    UPDATE voucher_entries SET narration=${label}
    WHERE company_id=${COMPANY} AND voucher_id=10544
      AND narration=${rentLabel+"07/2026"} RETURNING id
  `)).rows;
  requireExact(header.length===1 && memo.length===2,"OCTOBER_MEMO_UPDATE_FAILED");

  // November Main Factory is UNPAID: its credit is Accrued Rent Payable.
  // Do not touch the actual AMMAR prepaid line or the Prepaid Rent asset.
  const unmapped=(await tx.execute(sql`
    UPDATE property_monthly_ledger SET used_prepaid_account=false
    WHERE company_id=${COMPANY} AND id=897648
      AND accrual_voucher_id=16951 AND paid_amount=0
      AND used_prepaid_account=true RETURNING id
  `)).rows;
  requireExact(unmapped.length===1,"NOVEMBER_RENT_FLAG_CHANGED");
  const newMemo="November rent: MAIN FACTORY L9 payable; AMMAR prepaid recognized - 11/2026";
  const novHeader=(await tx.execute(sql`
    UPDATE vouchers SET description=${newMemo}
    WHERE company_id=${COMPANY} AND id=16951 AND deleted_at IS NULL
    RETURNING id
  `)).rows;
  requireExact(novHeader.length===1,"NOVEMBER_VOUCHER_CHANGED");

  const linkCheck=(await tx.execute(sql`
    SELECT id FROM property_monthly_ledger
    WHERE company_id=${COMPANY} AND accrual_voucher_id=13139
  `)).rows;
  requireExact(linkCheck.length===0,"DUPLICATE_HAS_VALID_LINK");
  const retired=await retireVouchersTx(tx,{
    companyId:COMPANY,voucherIds:[13139],actor:ACTOR,
    reason:"Duplicate Warehouse 5001 September 2026 rent accrual; valid September #14317 retained",
    metadata:{validSeptemberVoucher:14317,warehousePayment:14318,prepaidUnchanged:true,
      novemberWarehouseNotRecognized:true}
  });
  requireExact(retired.length===1 && retired[0].id===13139 &&
    !retired[0].alreadyDeleted,"DUPLICATE_RETIRE_FAILED");

  const after=await balances(tx);
  requireExact(Math.abs(after.expense-228833.34)<0.005 &&
    Math.abs(after.prepaid-29566.66)<0.005 &&
    Math.abs(after.payable+20000)<0.005,"AFTER_BALANCES_WRONG");
  await writeAuditEvent({
    userId:ACTOR.userId, username:ACTOR.username,companyId:COMPANY,
    action:"update",tableName:"vouchers",recordId:10544,
    recordIdentifier:"Factory rent review 2026-11-09; original vouchers only",
    changes:{
      duplicateRetirement:{old:"13139 active",new:"13139 retired"},
      octoberDescription:{old:rentLabel+"07/2026",new:label},
      novemberUnpaidFlag:{old:true,new:false},
      prepaidBalance:{old:before.prepaid,new:after.prepaid},
      balances:{old:before,new:after},
      exception:{new:"Warehouse Nov #889178 paid but not recognized; prepaid asset frozen by owner"},
    },
  },tx);
  return {applied:true,balances:after};
}
export async function runApprovedFactoryRentSafeRepair():Promise<void>{
  if(process.env.ERP_REPAIR_FACTORY_RENT_SAFE_20261109!==OPT_IN)return;
  requireExact(process.env.RENDER_SERVICE_ID===SERVICE,"WRONG_SERVICE");
  const database=await pool.query<{name:string}>("SELECT current_database() AS name");
  requireExact(database.rows[0]?.name===DATABASE,"WRONG_DATABASE");
  const result=await runAsSystemAuditActor(ACTOR.userId,()=>
    runWithAuditReason("Owner-approved Factory rent audit corrections; prepaid asset unchanged",()=>
      runInCompanyPostingScope(COMPANY,()=>db.transaction(apply))));
  logger.info("[FactoryRentSafeRepair] Completed audited in-place correction",result);
}

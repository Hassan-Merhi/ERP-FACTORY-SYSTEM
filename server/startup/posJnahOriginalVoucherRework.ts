import {sql} from "drizzle-orm";
import {db,pool,type DbTransaction} from "../db";
import {logger} from "../lib/logger";
import {runAsSystemAuditActor,runWithAuditReason} from "../services/audit/auditActorContext";
import {runInCompanyPostingScope,companyClosedThrough,isDateInClosedPeriod} from "../services/accounting/scheduledPostingScope";
import {companyBusinessDate} from "../services/accounting/companyBusinessDate";
import {retireVouchersTx} from "../services/accounting/voucherRetirement";
import {writeAuditEvent} from "../services/audit";
import {verifyPosJnahPrepaidMonths,type PosJnahMonth} from "./posJnahPrepaidPlan";

const company=17, contract=36, expense=2139, prepaid=3002;
const actor={userId:"system:pos-jnah-existing-vouchers-20261109",username:"system"};
function guard(value:unknown,reason:string):asserts value {
  if(!value) throw new Error("POS_JNAH_EXISTING_VOUCHER_REPAIR_"+reason);
}
const n=(x:unknown)=>Number(x);
type Entry={id:number;voucher_id:number;voucher_number:string;voucher_date:string;
  deleted_at:string|null;ledger_account_id:number;debit_amount:string;credit_amount:string;
  optional:boolean;currency:string};
async function balances(tx:DbTransaction){
 const rows=(await tx.execute(sql`
 SELECT e.ledger_account_id AS id,COALESCE(SUM(e.debit_amount-e.credit_amount),0)::text AS net
 FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=${company}
 WHERE e.company_id=${company} AND e.ledger_account_id IN (${prepaid},${expense})
 AND v.deleted_at IS NULL AND v.optional=false GROUP BY e.ledger_account_id
 `)).rows as {id:number;net:string}[];
 const get=(id:number)=>n(rows.find(r=>n(r.id)===id)?.net);
 return {prepaid:get(prepaid),expense:get(expense)};
}
export async function runPosJnahExistingVoucherRepair():Promise<void>{
 guard(process.env.ERP_REWORK_POS_JNAH_VOUCHERS_20261109==="approved-company17-original10613-retire17399","OPT_IN");
 guard(process.env.RENDER_SERVICE_ID==="srv-d6kibgtactks739u7vl0","SERVICE");
 const name=await pool.query<{name:string}>("select current_database() as name");
 guard(name.rows[0]?.name==="erp_db_qscj_64lv_e7rz_8744_2lm3","DATABASE");
 const result=await runAsSystemAuditActor(actor.userId,()=>runWithAuditReason(
  "Owner-approved POS Jnah repair using existing vouchers only",
  ()=>runInCompanyPostingScope(company,()=>db.transaction(async(tx)=>{
   await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('pos-jnah-vouchers-20261109'))`);
   const lines=(await tx.execute(sql`
    SELECT v.id AS voucher_id,v.voucher_number,v.voucher_date::text AS voucher_date,
      v.deleted_at::text AS deleted_at,v.optional,v.currency,
      e.id,e.ledger_account_id,e.debit_amount::text,e.credit_amount::text
    FROM vouchers v JOIN voucher_entries e ON e.voucher_id=v.id AND e.company_id=${company}
    WHERE v.company_id=${company} AND v.id IN (10613,13141,13142,15040,15041,17399)
    ORDER BY v.id,e.id FOR UPDATE OF v,e
   `)).rows as Entry[];
   guard(lines.length===12,"LINE_COUNT");
   const find=(id:number)=>lines.filter(r=>n(r.voucher_id)===id);
   const repair=find(17399);
   const done=repair.length===2 && repair.every(r=>r.deleted_at!==null);
   const assertVoucher=(id:number,num:string,date:string,dr:number,cr:number,amt:number)=>{
    const rows=find(id);
    guard(rows.length===2 && rows.every(r=>r.voucher_number===num &&
      String(r.voucher_date).slice(0,10)===date && r.deleted_at===null &&
      r.optional===false && r.currency==="USD") &&
     rows.some(r=>n(r.ledger_account_id)===dr && n(r.debit_amount)===amt && n(r.credit_amount)===0) &&
     rows.some(r=>n(r.ledger_account_id)===cr && n(r.credit_amount)===amt && n(r.debit_amount)===0),
     "VOUCHER_"+id);
   };
   assertVoucher(10613,"RENT-1784027392518-7rylj-36","2026-07-14",done?prepaid:expense,2137,30000);
   assertVoucher(13142,"LEGACY-PREPAID-REC-17-701217","2026-09-01",expense,prepaid,2500);
   assertVoucher(15041,"LEGACY-PREPAID-REC-17-701218","2026-10-01",expense,prepaid,2500);
   assertVoucher(13141,"LEGACY-PREPAID-RECLASS-17-701217-307","2026-08-01",
     done?expense:prepaid,done?prepaid:expense,2500);
   assertVoucher(15040,"LEGACY-PREPAID-RECLASS-17-701218-308",done?"2026-11-01":"2026-08-01",
     done?expense:prepaid,done?prepaid:expense,2500);
   guard(repair.every(r=>r.currency==="USD" && r.optional===false) &&
    repair.some(r=>n(r.ledger_account_id)===prepaid && n(r.debit_amount)===20000) &&
    repair.some(r=>n(r.ledger_account_id)===expense && n(r.credit_amount)===20000) &&
    repair.every(r=>r.voucher_number===("POS-JNAH-RENT-PREPAID-17-36-20261109"+(done?"~DEL17399":""))),
     "CORRECTION_CHANGED");
   const monthly=(await tx.execute(sql`
    SELECT id,contract_id,unit_id,year,month,expected_amount,paid_amount,
    used_prepaid_account,used_advance_account,accrual_voucher_id
    FROM property_monthly_ledger WHERE company_id=${company} AND contract_id=${contract}
    ORDER BY year,month,id FOR UPDATE
   `)).rows as PosJnahMonth[];
   const links=verifyPosJnahPrepaidMonths(monthly,done?"after":"before");
   const companyRow=(await tx.execute(sql`
    SELECT id,name,active FROM companies WHERE id=${company}
   `)).rows as {id:number;name:string;active:boolean}[];
   guard(companyRow.length===1 && companyRow[0].active &&
     companyRow[0].name.trim().startsWith("POS"),"COMPANY");
   const lease=(await tx.execute(sql`
    SELECT c.id,c.unit_id,c.rental_amount,c.start_date,c.status,c.currency,
      u.unit_number,u.unit_type,u.active
    FROM property_contracts c JOIN property_units u ON u.id=c.unit_id
    WHERE c.company_id=${company} AND c.id=${contract} FOR SHARE OF c,u
   `)).rows as Record<string,unknown>[];
   guard(lease.length===1 && n(lease[0].unit_id)===59 &&
     n(lease[0].rental_amount)===2500 &&
     String(lease[0].start_date).slice(0,10)==="2026-08-01" &&
     lease[0].status==="ACTIVE" && lease[0].currency==="USD" &&
     lease[0].unit_number==="POS" && lease[0].unit_type==="SHOP" &&
     lease[0].active===true,"CONTRACT");
   const payments=(await tx.execute(sql`
    SELECT id,voucher_id,ledger_row_id,for_year,for_month,amount,posting_status
    FROM property_payments
    WHERE company_id=${company} AND contract_id=${contract}
    ORDER BY for_year,for_month,id FOR SHARE
   `)).rows as Record<string,unknown>[];
   guard(payments.length===12 && payments.every((p,i)=>
     n(p.id)===306+i && n(p.voucher_id)===10613 &&
     n(p.ledger_row_id)===701216+i &&
     n(p.for_year)===(i<5?2026:2027) &&
     n(p.for_month)===(7+i)%12+1 &&
     n(p.amount)===2500 && p.posting_status==="POSTED"),"PAYMENT_ALLOCATIONS");
   const old=await balances(tx);
   guard(old.prepaid===20000 && old.expense===10000,"LEDGER_DRIFT");
   if(done) return {applied:false,...old};
   const day=await companyBusinessDate(company,tx);
   guard(day>="2026-11-09" && day<"2026-12-01","REVIEW_PERIOD");
   const closed=await companyClosedThrough(company,tx);
   for(const d of ["2026-07-14","2026-08-01","2026-11-01","2026-11-09"])
    guard(!isDateInClosedPeriod(closed,d),"CLOSED_PERIOD");
   const original=(await tx.execute(sql`
    UPDATE voucher_entries SET ledger_account_id=${prepaid}
    WHERE id=38071 AND voucher_id=10613 AND company_id=${company}
      AND ledger_account_id=${expense} AND debit_amount=30000 AND credit_amount=0 RETURNING id
   `)).rows;
   guard(original.length===1,"ORIGINAL_CHANGED");
   for(const [id,drId,crId,date,month] of [
    [13141,60724,60725,"2026-08-01","08/2026"],
    [15040,52791,52792,"2026-11-01","11/2026"]
   ] as const){
    const dr=(await tx.execute(sql`
     UPDATE voucher_entries SET ledger_account_id=${expense}
     WHERE id=${drId} AND voucher_id=${id} AND company_id=${company}
       AND ledger_account_id=${prepaid} AND debit_amount=2500 AND credit_amount=0 RETURNING id
    `)).rows;
    const cr=(await tx.execute(sql`
     UPDATE voucher_entries SET ledger_account_id=${prepaid}
     WHERE id=${crId} AND voucher_id=${id} AND company_id=${company}
       AND ledger_account_id=${expense} AND credit_amount=2500 AND debit_amount=0 RETURNING id
    `)).rows;
    guard(dr.length===1 && cr.length===1,"MONTH_ENTRIES_"+id);
    const v=(await tx.execute(sql`
     UPDATE vouchers SET voucher_date=${date}::date,
       description=${"Prepaid rent recognized - POS unit59 - "+month}
     WHERE id=${id} AND company_id=${company} RETURNING id
    `)).rows;
    guard(v.length===1,"MONTH_HEADER_"+id);
   }
   for(const link of links){
    const updated=(await tx.execute(sql`
     UPDATE property_monthly_ledger
     SET used_prepaid_account=true,accrual_voucher_id=${link.voucherId}
     WHERE id=${link.id} AND company_id=${company} AND contract_id=${contract}
       AND used_prepaid_account=false AND accrual_voucher_id IS NULL RETURNING id
    `)).rows;
    guard(updated.length===1,"MONTH_LINK_"+link.id);
   }
   const retired=await retireVouchersTx(tx,{companyId:company,voucherIds:[17399],
     reason:"Original POS Jnah vouchers corrected; unnecessary separate correction retired",
     actor,metadata:{originalVoucherId:10613,reusedVoucherIds:[13141,15040]}});
   guard(retired.length===1 && !retired[0].alreadyDeleted,"RETIRE");
   const after=await balances(tx);
   guard(after.prepaid===20000 && after.expense===10000,"AFTER_BALANCES");
   await writeAuditEvent({userId:actor.userId,username:actor.username,
    companyId:company,action:"update",tableName:"vouchers",recordId:10613,
    recordIdentifier:"POS Jnah prepaid rent original voucher",
    changes:{originalDebit:{old:expense,new:prepaid},
      reusedVouchers:{new:[13141,15040]},retiredVoucher:{new:17399},
      currentBalance:{new:after}}},tx);
   return {applied:true,...after};
  }))));
 logger.info("[PosJnahOriginalVoucherRepair] Existing vouchers reconciled",result);
}

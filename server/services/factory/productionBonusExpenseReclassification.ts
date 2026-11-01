/**
 * Approved, one-time correction for company 12's nine manual Production
 * Targets bonuses from October 31, 2026.
 *
 * Change the ORIGINAL Payment voucher's debit ledger account and the linked
 * claim's expense account. The amount, payment date, cash credit, voucher
 * number, worker, and payment ID remain untouched. Each source voucher edit
 * has full before/after application and database-trigger audit records.
 * This is allowed only for open accounting periods.
 */
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { assertVoucherEditableTx, recordVoucherEditAuditTx } from "../accounting/voucherCorrection";
import { runInCompanyPostingScope } from "../accounting/scheduledPostingScope";
import { expenseAccountTx } from "./targetBonusPaymentService";
import { logAudit } from "../../routes/helpers/auditHelpers";

type Row = Record<string, unknown>;
const rows = (r: unknown): Row[] => resultRows<Row>(r);
const EXPECTED = ["27.00","25.00","25.00","25.00","25.00","25.00","25.00","25.00","27.00"];
const OLD_ACCOUNT_ID = 819;
const OLD_CODE = "PAYROLL_DEPOSIT_EXPENSE";
const NEW_CODE = "FACTORY_PRODUCTION_BONUS_EXPENSE";
const ACTOR = {userId:"system:bonus-account-correction",username:"system",companyId:12};

export async function correctNineProductionBonusExpenseAccounts(): Promise<{
  inspected: number; corrected: number; previouslyCorrected: number; totalUsd: string;
}> {
  const companyId = 12;
  return runInCompanyPostingScope(companyId,()=>db.transaction(async tx=>{
    // Serialized with manual payouts, calculated payouts and reversals.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(84023, ${companyId})`);
    const targetId = await expenseAccountTx(tx,companyId);
    if(targetId===OLD_ACCOUNT_ID)throw new Error("BONUS_ACCOUNT_CORRECTION_TARGET_EQUALS_SOURCE");
    const payments = rows(await tx.execute(sql`
      SELECT p.id,p.status,p.amount_usd::text AS amount,
        p.payment_date::text AS "paymentDate",
        p.cash_ledger_account_id AS "cashId",
        p.expense_ledger_account_id AS "expenseId",
        p.payment_voucher_id AS "voucherId",
        ea.code AS "expenseCode",
        v.voucher_type AS "voucherType",v.voucher_date::text AS "voucherDate",
        v.currency,v.deleted_at AS "deletedAt"
      FROM factory_target_bonus_manual_payments p
      JOIN ledger_accounts ea ON ea.id=p.expense_ledger_account_id AND ea.company_id=p.company_id
      JOIN vouchers v ON v.id=p.payment_voucher_id AND v.company_id=p.company_id
      WHERE p.company_id=${companyId} AND p.id BETWEEN 1 AND 9
      ORDER BY p.id FOR UPDATE OF p
    `));
    if(payments.length!==9)throw new Error("BONUS_ACCOUNT_CORRECTION_SOURCE_COUNT_CHANGED");

    const originalDebitEntries: Array<{id:number; amount:string; state:"old"|"new"}>=[];
    for(let i=0;i<payments.length;i++){
      const p=payments[i],voucherId=Number(p.voucherId);
      const amount=Number(p.amount);
      if(Number(p.id)!==i+1||String(p.amount)!==EXPECTED[i]||
          p.paymentDate!=="2026-10-31"||p.voucherDate!=="2026-10-31"||
          voucherId!==16893+i||p.voucherType!=="Payment"||
          p.currency!=="USD"||p.deletedAt||
          !["POSTED","REVERSED"].includes(String(p.status)))
        throw new Error(`BONUS_ACCOUNT_CORRECTION_SOURCE_CHANGED_${i+1}`);
      const state: string = p.expenseCode===OLD_CODE&&Number(p.expenseId)===OLD_ACCOUNT_ID
        ?"old":p.expenseCode===NEW_CODE&&Number(p.expenseId)===targetId?"new":"invalid";
      if(state==="invalid")throw new Error(`BONUS_ACCOUNT_CORRECTION_UNEXPECTED_ACCOUNT_${i+1}`);
      const entries=rows(await tx.execute(sql`
        SELECT id,ledger_account_id AS "accountId",
          COALESCE(debit_amount,0)::text AS debit,
          COALESCE(credit_amount,0)::text AS credit
        FROM voucher_entries WHERE voucher_id=${voucherId}
        ORDER BY id
      `));
      if(entries.length!==2)throw new Error(`BONUS_ACCOUNT_CORRECTION_LINES_CHANGED_${i+1}`);
      const expense=entries.find(e=>
        Number(e.accountId)===(state==="old"?OLD_ACCOUNT_ID:targetId)
        &&Number(e.debit)===amount&&Number(e.credit)===0);
      const cash=entries.find(e=>Number(e.accountId)===Number(p.cashId)
        &&Number(e.debit)===0&&Number(e.credit)===amount);
      if(!expense||!cash||Number(expense.id)===Number(cash.id))
        throw new Error(`BONUS_ACCOUNT_CORRECTION_BALANCE_MISMATCH_${i+1}`);
      originalDebitEntries.push({id:Number(expense.id),amount:String(p.amount),state:state as "old"|"new"});
    }

    const already=originalDebitEntries.filter(e=>e.state==="new").length;
    if(already===9)return {inspected:9,corrected:0,previouslyCorrected:9,totalUsd:"229.00"};
    if(already!==0)throw new Error("BONUS_ACCOUNT_CORRECTION_PARTIAL_STATE_REQUIRES_REVIEW");
    if(payments.some(p=>p.status!=="POSTED"))
      throw new Error("BONUS_ACCOUNT_CORRECTION_REVERSED_SOURCE_REQUIRES_REVIEW");

    for(let i=0;i<payments.length;i++){
      const p=payments[i],voucherId=Number(p.voucherId);
      const ctx=await assertVoucherEditableTx(tx,voucherId,{companyId});
      const updated=rows(await tx.execute(sql`
        UPDATE voucher_entries SET ledger_account_id=${targetId}
        WHERE id=${originalDebitEntries[i].id} AND voucher_id=${voucherId}
          AND ledger_account_id=${OLD_ACCOUNT_ID}
        RETURNING id
      `));
      if(updated.length!==1)throw new Error(`BONUS_ACCOUNT_CORRECTION_ENTRY_UPDATE_FAILED_${i+1}`);
      const claim=rows(await tx.execute(sql`
        UPDATE factory_target_bonus_manual_payments
        SET expense_ledger_account_id=${targetId}
        WHERE company_id=${companyId} AND id=${Number(p.id)}
          AND expense_ledger_account_id=${OLD_ACCOUNT_ID}
        RETURNING id
      `));
      if(claim.length!==1)throw new Error(`BONUS_ACCOUNT_CORRECTION_CLAIM_UPDATE_FAILED_${i+1}`);
      await recordVoucherEditAuditTx(tx,{
        voucherId,before:ctx.before,actor:ACTOR,
        reason:"Correct manual Production Targets bonus debit from Payroll Deposit Expense to Production Bonus Expense; cash payment unchanged",
        extra:{bonusPaymentId:{new:Number(p.id)},fromAccountId:{old:OLD_ACCOUNT_ID},toAccountId:{new:targetId}},
      });
      await logAudit({
        userId:ACTOR.userId,username:ACTOR.username,companyId,action:"update",
        tableName:"factory_target_bonus_manual_payments",recordId:Number(p.id),
        recordIdentifier:`Production bonus #${p.id} corrected expense account`,
        changes:{expenseLedgerAccountId:{old:OLD_ACCOUNT_ID,new:targetId},
          paymentVoucherId:{old:voucherId,new:voucherId}},
      },tx);
    }
    return {inspected:9,corrected:9,previouslyCorrected:0,totalUsd:"229.00"};
  }),"approved-production-bonus-expense-account-correction");
}

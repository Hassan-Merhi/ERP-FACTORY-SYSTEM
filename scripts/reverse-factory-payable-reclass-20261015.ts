/**
 * Explicit owner-approved undo of the 18 October 15 historical goods-payable
 * reallocations. Posts balanced compensating journals, never deletes history.
 * Does NOT restore other October data changes, revalue FX, or rewrite invoices.
 * Dry-run is default: npx tsx scripts/reverse-factory-payable-reclass-20261015.ts
 * Apply: npx tsx scripts/reverse-factory-payable-reclass-20261015.ts --apply --owner-approved
 */
import { sql } from "drizzle-orm";
import { db, pool, type DbTransaction } from "../server/db";
import { MoneyDecimal, toMoney } from "../server/lib/money";
import { postFactoryVoucherTx } from "../server/services/factory/factoryVoucherPosting";
import { REVIEWED_IMPORT_PAYABLES } from "./reclassify-factory-import-payables-20261015";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../server/services/security/databaseScopeRuntimeContext";

const COMPANY = 12;
const RATE = "1.18";
const CORRECTION = "FACTORY-PAYABLE-RECLASS-20261015-";
const REVERSAL = "FACTORY-PAYABLE-RECLASS-REV-20261015-";
type Item = (typeof REVIEWED_IMPORT_PAYABLES)[number];

async function verifySource(tx: DbTransaction, row: Item): Promise<boolean> {
  const original = await tx.execute(sql`
    SELECT v.id,v.voucher_number,v.deleted_at,v.currency,v.optional,
           e.id line_id,e.factory_supplier_id,e.credit_amount,e.transaction_credit_amount
    FROM vouchers v JOIN voucher_entries e ON e.voucher_id=v.id
    WHERE v.company_id=${COMPANY} AND v.id=${row.originalVoucher}
      AND e.id=${row.originalCreditLine}
    FOR SHARE OF v,e
  `);
  const o = original.rows[0];
  if (original.rows.length!==1 || o.deleted_at!==null || o.optional!==false ||
      o.currency!=="EUR" ||
      !String(o.voucher_number).startsWith("FACTORY-IMPORT-"+row.container+"-") ||
      Number(o.factory_supplier_id)!==row.originalSupplier ||
      !toMoney(o.credit_amount as string).eq(row.usd) ||
      !toMoney(o.transaction_credit_amount as string).eq(row.eur)) {
    throw new Error("FPR_UNDO_ORIGINAL_CHANGED_"+row.container);
  }

  const originalAdjustment = await tx.execute(sql`
    SELECT v.id AS voucher_id,v.voucher_number,v.currency,v.deleted_at,v.optional,
           e.factory_supplier_id,e.ledger_account_id,e.bank_account_id,e.supplier_id,
           e.debit_amount,e.credit_amount,e.transaction_currency,
           e.transaction_debit_amount,e.transaction_credit_amount,e.historical_exchange_rate
    FROM vouchers v JOIN voucher_entries e ON e.voucher_id=v.id
    WHERE v.company_id=${COMPANY} AND v.voucher_number=${CORRECTION+row.container}
    ORDER BY e.id FOR UPDATE OF v,e
  `);
  const l = originalAdjustment.rows;
  const debit=l.find(x=>Number(x.factory_supplier_id)===row.originalSupplier);
  const credit=l.find(x=>Number(x.factory_supplier_id)===row.currentSupplier);
  if(l.length!==2 || !debit || !credit || debit===credit ||
      l.some(x=>x.deleted_at!==null || x.optional!==false || x.currency!=="EUR" ||
        x.transaction_currency!=="EUR" || x.ledger_account_id!==null ||
        x.bank_account_id!==null || x.supplier_id!==null ||
        !toMoney(x.historical_exchange_rate as string).eq(RATE)) ||
      !toMoney(debit.debit_amount as string).eq(row.usd) ||
      !toMoney(debit.transaction_debit_amount as string).eq(row.eur) ||
      !toMoney(debit.credit_amount as string).isZero() ||
      !toMoney(credit.credit_amount as string).eq(row.usd) ||
      !toMoney(credit.transaction_credit_amount as string).eq(row.eur) ||
      !toMoney(credit.debit_amount as string).isZero()) {
    throw new Error("FPR_UNDO_CORRECTION_CHANGED_"+row.container);
  }

  const existing=await tx.execute(sql`
    SELECT v.id,v.deleted_at,v.optional,v.currency,
       count(e.id)::int AS lines,
       coalesce(sum(e.transaction_debit_amount)
          FILTER (WHERE e.factory_supplier_id=${row.currentSupplier}),0)::text AS current_debit,
       coalesce(sum(e.transaction_credit_amount)
          FILTER (WHERE e.factory_supplier_id=${row.originalSupplier}),0)::text AS old_credit,
       coalesce(sum(e.debit_amount-e.credit_amount),0)::text AS usd_net
    FROM vouchers v LEFT JOIN voucher_entries e ON e.voucher_id=v.id
    WHERE v.company_id=${COMPANY} AND v.voucher_number=${REVERSAL+row.container}
    GROUP BY v.id
  `);
  if (existing.rows.length>1) throw new Error("FPR_UNDO_DUPLICATE_"+row.container);
  if(existing.rows.length===1){
    const a=existing.rows[0];
    if(a.deleted_at!==null || a.optional!==false || a.currency!=="EUR" ||
       Number(a.lines)!==2 || !toMoney(a.current_debit as string).eq(row.eur) ||
       !toMoney(a.old_credit as string).eq(row.eur) ||
       !toMoney(a.usd_net as string).isZero()){
      throw new Error("FPR_UNDO_POSTING_CHANGED_"+row.container);
    }
  }
  return existing.rows.length===1;
}

export async function reverseFactoryPayableReclass20261015(apply: boolean) {
  return runWithDatabaseScopeRuntimeContext(createTenantDatabaseScope(COMPANY),async()=>{
    const eur=REVIEWED_IMPORT_PAYABLES.reduce(
      (v,r)=>v.plus(toMoney(r.eur)),new MoneyDecimal(0));
    const usd=REVIEWED_IMPORT_PAYABLES.reduce(
      (v,r)=>v.plus(toMoney(r.usd)),new MoneyDecimal(0));
    if(REVIEWED_IMPORT_PAYABLES.length!==18 || !eur.eq("84302.10") ||
        !usd.eq("99476.48")) throw new Error("FPR_UNDO_PLAN_CHANGED");
    return db.transaction(async(tx)=>{
      const pending:Item[]=[];
      for(const row of REVIEWED_IMPORT_PAYABLES){
        if(!(await verifySource(tx,row))) pending.push(row);
      }
      console.log("[FPR_UNDO] checked=18 pending="+pending.length+
        " eur="+eur.toFixed(2)+" usd="+usd.toFixed(2)+" apply="+apply);
      if(!apply) return {checked:18,pending:pending.length,posted:0};
      for(const row of pending){
        await postFactoryVoucherTx(tx,{
          companyId:COMPANY,
          voucherType:"Journal",
          voucherNumber:REVERSAL+row.container,
          voucherDate:"2026-10-15",
          description:"Undo Oct-15 supplier payable reassignment at owner's request; original payable voucher "+
            row.originalVoucher+" and correction "+CORRECTION+row.container,
          currency:"EUR",
          fxRateToUsd:RATE,
          source:{
            sourceType:"factory-import-payable-undo",
            sourceId:String(row.originalVoucher)+":"+String(row.originalCreditLine),
            phase:"owner-requested-undo-20261015"
          },
          lines:[
            {factorySupplierId:row.currentSupplier,debit:row.eur,
              narration:"Undo correcting credit for old supplier allocation"},
            {factorySupplierId:row.originalSupplier,credit:row.eur,
              narration:"Return liability to original source supplier"}
          ]
        });
        if(!(await verifySource(tx,row))) throw new Error("FPR_UNDO_POSTCHECK_"+row.container);
      }
      return {checked:18,pending:0,posted:pending.length};
    });
  });
}

if(process.argv[1]?.includes("reverse-factory-payable-reclass-20261015")){
  const args=new Set(process.argv.slice(2));
  const apply=args.has("--apply");
  if(apply&&!args.has("--owner-approved")){
    console.error("FPR_UNDO_APPROVAL_REQUIRED");process.exitCode=1;
  } else {
    void reverseFactoryPayableReclass20261015(apply)
     .then(r=>console.log("[FPR_UNDO] "+JSON.stringify(r)))
     .catch(e=>{console.error(e);process.exitCode=1;})
     .finally(()=>pool.end());
  }
}

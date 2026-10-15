/**
 * Company 12 exact source-verified, one-time reassignment of nine historical
 * ZIAD-linked goods payable credits incorrectly left on ABO JABER (id 42).
 *
 * The July 3 import vouchers name ABO JABER, but their saved source containers
 * belong to Germany Ziad Abo Jaber (49), UK Ziad (48), Denmark Ziad (47).
 * The Oct 15 general-party correction and owner-requested reversal BOTH
 * remain posted. This new targeted entry reassigns ONLY the nine original
 * goods liabilities. No deletion or alteration of source transactions, rates,
 * external payments, commission, freight, or the unrelated remaining suppliers.
 *
 * Read-only preview by default; --apply additionally requires --owner-approved.
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
const JABER = 42;
const ZIAD = 43;
const RATE = "1.18";
const JOURNAL_DATE = "2026-10-15";
const FAMILY = "FACTORY-PAYABLE-RECLASS-JABER-20261015-";
const ORIGINAL_RECLASS = "FACTORY-PAYABLE-RECLASS-20261015-";
const PREVIOUS_UNDO = "FACTORY-PAYABLE-RECLASS-REV-20261015-";
const sources = REVIEWED_IMPORT_PAYABLES.filter(r => r.originalSupplier === JABER);

type Source = (typeof sources)[number];

const eurTotal = sources.reduce((s,r)=>s.plus(toMoney(r.eur)),new MoneyDecimal(0));
const usdTotal = sources.reduce((s,r)=>s.plus(toMoney(r.usd)),new MoneyDecimal(0));

async function supplierBalance(tx: DbTransaction, id: number) {
  const r = await tx.execute(sql`
    SELECT
      COALESCE(SUM(CASE WHEN e.transaction_currency = 'EUR'
        AND e.ledger_account_id IS NULL AND e.bank_account_id IS NULL
        AND e.supplier_id IS NULL AND e.fixed_asset_id IS NULL
        AND e.employee_id IS NULL AND e.base_debit_amount IS NOT NULL
        AND e.base_credit_amount IS NOT NULL
        THEN COALESCE(e.transaction_credit_amount,0) -
             COALESCE(e.transaction_debit_amount,0) ELSE 0 END),0)::text eur,
      COALESCE(SUM(CASE WHEN e.ledger_account_id IS NULL
        AND e.bank_account_id IS NULL AND e.supplier_id IS NULL
        AND e.fixed_asset_id IS NULL AND e.employee_id IS NULL
        THEN COALESCE(e.credit_amount,0)-COALESCE(e.debit_amount,0)
        ELSE 0 END),0)::text usd
    FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id
    WHERE v.company_id=${COMPANY} AND v.deleted_at IS NULL
      AND v.optional=false AND e.factory_supplier_id=${id}
  `);
  return { eur: toMoney(r.rows[0].eur as string),usd:toMoney(r.rows[0].usd as string) };
}

async function verifyTwoPartyVoucher(
  tx: DbTransaction, no: string, row: Source, direction: "old-to-new" | "new-to-old"
) {
  const data = (await tx.execute(sql`
    SELECT v.id AS voucher_id,v.currency,v.optional,v.deleted_at,e.id,
      e.factory_supplier_id,e.ledger_account_id,e.bank_account_id,e.supplier_id,
      e.employee_id,e.fixed_asset_id,e.debit_amount,e.credit_amount,
      e.transaction_currency,e.transaction_debit_amount,e.transaction_credit_amount,
      e.historical_exchange_rate
    FROM vouchers v JOIN voucher_entries e ON e.voucher_id=v.id
    WHERE v.company_id=${COMPANY} AND v.voucher_number=${no}
    ORDER BY e.id FOR SHARE OF v,e
  `)).rows;
  const debitId = direction === "old-to-new" ? JABER : row.currentSupplier;
  const creditId = direction === "old-to-new" ? row.currentSupplier : JABER;
  const debit = data.find(d=>Number(d.factory_supplier_id)===debitId);
  const credit = data.find(d=>Number(d.factory_supplier_id)===creditId);
  if(data.length!==2 || !debit || !credit || debit===credit ||
    data.some(d=>d.deleted_at!==null || d.optional!==false || d.currency!=="EUR" ||
      d.ledger_account_id!==null || d.bank_account_id!==null || d.supplier_id!==null ||
      d.employee_id!==null || d.fixed_asset_id!==null || d.transaction_currency!=="EUR" ||
      !toMoney(d.historical_exchange_rate as string).eq(RATE)) ||
    !toMoney(debit.transaction_debit_amount as string).eq(row.eur) ||
    !toMoney(debit.debit_amount as string).eq(row.usd) ||
    !toMoney(debit.transaction_credit_amount as string).isZero() ||
    !toMoney(debit.credit_amount as string).isZero() ||
    !toMoney(credit.transaction_credit_amount as string).eq(row.eur) ||
    !toMoney(credit.credit_amount as string).eq(row.usd) ||
    !toMoney(credit.transaction_debit_amount as string).isZero() ||
    !toMoney(credit.debit_amount as string).isZero()) {
    throw new Error("JABER_MISMATCHED_JOURNAL_"+row.container+"_"+direction);
  }
}

async function verifySource(tx: DbTransaction, row: Source): Promise<boolean> {
  const c = (await tx.execute(sql`
    SELECT id,supplier_id,deleted_at,company_id
    FROM factory_containers WHERE company_id=${COMPANY} AND id=${row.container}
    FOR SHARE
  `)).rows[0];
  const supplier = (await tx.execute(sql`
    SELECT id,parent_id,company_id FROM factory_suppliers
    WHERE company_id=${COMPANY} AND id=${row.currentSupplier}
    FOR SHARE
  `)).rows[0];
  if(!c || c.deleted_at!==null || Number(c.supplier_id)!==row.currentSupplier ||
     !supplier || Number(supplier.parent_id)!==ZIAD ||
     ![47,48,49].includes(row.currentSupplier)) {
    throw new Error("JABER_CONTAINER_OR_BROKER_CHANGED_"+row.container);
  }

  const r = (await tx.execute(sql`
    SELECT v.id voucher_id,v.voucher_number,v.currency,v.deleted_at,v.optional,
      e.id line_id,e.factory_supplier_id,e.ledger_account_id,
      e.transaction_currency,e.transaction_credit_amount,e.credit_amount,
      e.historical_exchange_rate
    FROM vouchers v JOIN voucher_entries e ON e.voucher_id=v.id
    WHERE v.company_id=${COMPANY} AND v.id=${row.originalVoucher}
      AND e.id=${row.originalCreditLine}
    FOR SHARE OF v,e
  `)).rows;
  const o=r[0];
  if(r.length!==1 || o.deleted_at!==null || o.optional!==false ||
     !String(o.voucher_number).startsWith("FACTORY-IMPORT-"+row.container+"-") ||
     o.currency!=="EUR" || o.transaction_currency!=="EUR" ||
     Number(o.factory_supplier_id)!==JABER || o.ledger_account_id!==null ||
     !toMoney(o.credit_amount as string).eq(row.usd) ||
     !toMoney(o.transaction_credit_amount as string).eq(row.eur) ||
     !toMoney(o.historical_exchange_rate as string).eq(RATE)) {
    throw new Error("JABER_ORIGINAL_GOODS_CHANGED_"+row.container);
  }

  // Both earlier corrections must remain intact. We are not undoing unrelated
  // source accounting; this new voucher is an auditable third, targeted entry.
  await verifyTwoPartyVoucher(tx,ORIGINAL_RECLASS+row.container,row,"old-to-new");
  await verifyTwoPartyVoucher(tx,PREVIOUS_UNDO+row.container,row,"new-to-old");

  const exists=(await tx.execute(sql`
    SELECT id FROM vouchers WHERE company_id=${COMPANY}
      AND voucher_number=${FAMILY+row.container}
    LIMIT 2
  `)).rows;
  if(exists.length>1) throw new Error("JABER_DUPLICATE_CORRECTION_"+row.container);
  if(exists.length===1){
    await verifyTwoPartyVoucher(tx,FAMILY+row.container,row,"old-to-new");
  }
  return exists.length===1;
}

export async function repairAboJaberSupplierAttribution(apply:boolean) {
  return runWithDatabaseScopeRuntimeContext(createTenantDatabaseScope(COMPANY),async()=>{
    if(sources.length!==9 || !eurTotal.eq("41126.50") || !usdTotal.eq("48529.27") ||
       sources.some(s=>s.originalSupplier!==JABER || ![47,48,49].includes(s.currentSupplier))){
      throw new Error("JABER_SOURCE_PLAN_MISMATCH");
    }
    return db.transaction(async tx=>{
      const before=await supplierBalance(tx,JABER);
      const pending:Source[]=[];
      for(const row of sources) if(!(await verifySource(tx,row))) pending.push(row);
      const corrected = pending.length===0;
      if(!(corrected
          ? before.eur.isZero() && before.usd.isZero()
          : pending.length===9 && before.eur.eq(eurTotal) && before.usd.eq(usdTotal))){
        throw new Error("JABER_EXPECTED_BALANCE_CHANGED");
      }
      console.log("[JABER_REASSIGN] preview 9="+sources.length+
        " pending="+pending.length+" eur="+before.eur.toFixed(2)+
        " usd="+before.usd.toFixed(2)+" apply="+apply);
      if(!apply || pending.length===0) return {
        checked:9,pending:pending.length,posted:0,balanceEur:before.eur.toFixed(2)
      };
      for(const row of pending){
        await postFactoryVoucherTx(tx,{
          companyId:COMPANY,voucherType:"Journal",
          voucherDate:JOURNAL_DATE,
          voucherNumber:FAMILY+row.container,
          description:"Owner-approved correction: original goods payable wrongly assigned to ABO JABER; actual supplier is linked to ZIAD, source container "+row.container,
          currency:"EUR",fxRateToUsd:RATE,
          source:{sourceType:"factory-jaber-goods-reassignment",
            sourceId:String(row.originalVoucher)+":"+String(row.originalCreditLine),
            phase:"owner-approved-oct15-source-reconciliation"},
          lines:[
            {factorySupplierId:JABER,debit:row.eur,
             narration:"Remove imported-goods payable mistakenly attributed to ABO JABER"},
            {factorySupplierId:row.currentSupplier,credit:row.eur,
             narration:"Assign original imported-goods payable to actual ZIAD-linked goods supplier"},
          ],
        });
        if(!(await verifySource(tx,row))) throw new Error("JABER_POSTCHECK_MISSING_"+row.container);
      }
      const after=await supplierBalance(tx,JABER);
      if(!after.eur.isZero() || !after.usd.isZero())
        throw new Error("JABER_ZERO_BALANCE_POSTCHECK_FAILED");
      return {checked:9,pending:0,posted:9,balanceEur:after.eur.toFixed(2)};
    });
  });
}
if(process.argv[1]?.includes("repair-abo-jaber-supplier-attribution-20261015")){
  const args=new Set(process.argv.slice(2));
  const apply=args.has("--apply");
  if(apply&&!args.has("--owner-approved")){
    console.error("JABER_EXPLICIT_APPROVAL_REQUIRED");
    process.exitCode=1;
  }else{
    void repairAboJaberSupplierAttribution(apply)
      .then(x=>console.log("[JABER_REASSIGN] "+JSON.stringify(x)))
      .catch(e=>{console.error(e);process.exitCode=1;})
      .finally(()=>pool.end());
  }
}

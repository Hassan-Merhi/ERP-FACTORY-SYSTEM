/**
 * Read-only preview / explicitly owner-approved one-time goods-payable
 * correction for ABO SOBHI DIRECT, company 12, container TCLU8160430.
 *
 * Historical import voucher dated May 13 captured 21,460 kg at EUR 0.32/kg
 * = EUR 6,867.20; saved container now has EUR 0.36/kg = EUR 7,725.60.
 * Posts EUR 858.40 extra inventory / payable at its confirmed original
 * USD/EUR rate 1.18, with a new Oct 15 journal (no original edits).
 * No other supplier/container is touched.
 */
import { sql } from "drizzle-orm";
import { db, pool, type DbTransaction } from "../server/db";
import { toMoney } from "../server/lib/money";
import { postFactoryVoucherTx } from "../server/services/factory/factoryVoucherPosting";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../server/services/security/databaseScopeRuntimeContext";

const COMPANY = 12;
const SUPPLIER = 41;
const CONTAINER = 82;
const ORIGINAL = 7681;
const ORIGINAL_DEBIT_LINE = 26566;
const ORIGINAL_CREDIT_LINE = 26567;
const INVENTORY_ACCOUNT = 814;
const VOUCHER_NO = "FACTORY-GOODS-DELTA-20261015-82";
const EUR_DELTA = "858.40";
const EUR_BEFORE = "41572.00";
const EUR_AFTER = "42430.40";
const USD_PER_EUR = "1.18";

async function inspect(tx: DbTransaction) {
  const c = (await tx.execute(sql`
    SELECT id, company_id, supplier_id, container_number, deleted_at, status,
           currency_code, total_kg, rate_per_kg, fx_rate_confirmed, fx_rate_to_usd
      FROM factory_containers
     WHERE id = ${CONTAINER} AND company_id = ${COMPANY}
     FOR SHARE
  `)).rows;
  if (c.length !== 1 || c[0].deleted_at !== null ||
      Number(c[0].supplier_id) !== SUPPLIER || c[0].container_number !== "TCLU8160430" ||
      c[0].currency_code !== "EUR" || c[0].fx_rate_confirmed !== true ||
      !toMoney(c[0].fx_rate_to_usd as string).eq(USD_PER_EUR) ||
      !toMoney(c[0].total_kg as string).eq("21460") ||
      !toMoney(c[0].rate_per_kg as string).eq("0.36") ||
      !toMoney(c[0].total_kg as string).times(c[0].rate_per_kg as string).eq("7725.60")) {
    throw new Error("ABO82_CONTAINER_SOURCE_CHANGED");
  }

  const orig = (await tx.execute(sql`
    SELECT v.id voucher_id,v.voucher_number,v.currency,v.voucher_type,
           v.deleted_at,v.optional,v.company_id,
           e.id,e.ledger_account_id,e.factory_supplier_id,
           e.bank_account_id,e.supplier_id,e.employee_id,e.fixed_asset_id,
           e.transaction_currency,e.transaction_debit_amount,e.transaction_credit_amount,
           e.debit_amount,e.credit_amount,e.historical_exchange_rate
      FROM vouchers v JOIN voucher_entries e ON e.voucher_id=v.id
     WHERE v.id=${ORIGINAL} AND v.company_id=${COMPANY}
     ORDER BY e.id FOR SHARE OF v,e
  `)).rows;
  const asset=orig.find(x=>Number(x.id)===ORIGINAL_DEBIT_LINE);
  const payable=orig.find(x=>Number(x.id)===ORIGINAL_CREDIT_LINE);
  if(orig.length!==2 || !asset || !payable ||
     orig.some(x=>x.deleted_at!==null || x.optional!==false || x.currency!=="EUR" ||
       x.voucher_type!=="Journal" || x.voucher_number!=="FACTORY-IMPORT-82-1778647817953" ||
       x.bank_account_id!==null || x.supplier_id!==null || x.employee_id!==null ||
       x.fixed_asset_id!==null || x.transaction_currency!=="EUR" ||
       !toMoney(x.historical_exchange_rate as string).eq(USD_PER_EUR)) ||
     Number(asset.ledger_account_id)!==INVENTORY_ACCOUNT ||
     asset.factory_supplier_id!==null ||
     !toMoney(asset.transaction_debit_amount as string).eq("6867.20") ||
     !toMoney(asset.debit_amount as string).eq("8103.30") ||
     !toMoney(asset.credit_amount as string).isZero() ||
     Number(payable.factory_supplier_id)!==SUPPLIER ||
     payable.ledger_account_id!==null ||
     !toMoney(payable.transaction_credit_amount as string).eq("6867.20") ||
     !toMoney(payable.credit_amount as string).eq("8103.30") ||
     !toMoney(payable.debit_amount as string).isZero()) {
    throw new Error("ABO82_ORIGINAL_IMPORT_CHANGED");
  }

  const fix=(await tx.execute(sql`
    SELECT v.id voucher_id,v.voucher_number,v.currency,v.deleted_at,v.optional,
           e.id line_id,e.factory_supplier_id,e.ledger_account_id,
           e.bank_account_id,e.supplier_id,e.employee_id,e.fixed_asset_id,
           e.transaction_currency,e.transaction_debit_amount,e.transaction_credit_amount,
           e.debit_amount,e.credit_amount,e.historical_exchange_rate
      FROM vouchers v JOIN voucher_entries e ON e.voucher_id=v.id
     WHERE v.company_id=${COMPANY} AND v.voucher_number=${VOUCHER_NO}
     ORDER BY e.id FOR SHARE OF v,e
  `)).rows;
  if(fix.length!==0){
    const dr=fix.find(x=>Number(x.ledger_account_id)===INVENTORY_ACCOUNT);
    const cr=fix.find(x=>Number(x.factory_supplier_id)===SUPPLIER);
    if(fix.length!==2 || !dr || !cr || dr===cr ||
      fix.some(x=>x.deleted_at!==null || x.optional!==false || x.currency!=="EUR" ||
        x.transaction_currency!=="EUR" || x.bank_account_id!==null ||
        x.supplier_id!==null || x.employee_id!==null || x.fixed_asset_id!==null ||
        !toMoney(x.historical_exchange_rate as string).eq(USD_PER_EUR)) ||
      dr.factory_supplier_id!==null || cr.ledger_account_id!==null ||
      !toMoney(dr.transaction_debit_amount as string).eq(EUR_DELTA) ||
      !toMoney(cr.transaction_credit_amount as string).eq(EUR_DELTA) ||
      !toMoney(dr.debit_amount as string).eq("1012.91") ||
      !toMoney(cr.credit_amount as string).eq("1012.91") ||
      !toMoney(dr.credit_amount as string).isZero() ||
      !toMoney(cr.debit_amount as string).isZero()) {
      throw new Error("ABO82_EXISTING_CORRECTION_MISMATCH");
    }
  }

  const sum=(await tx.execute(sql`
    SELECT COALESCE(SUM(COALESCE(e.transaction_credit_amount,0) -
                        COALESCE(e.transaction_debit_amount,0)),0)::text AS net
      FROM vouchers v JOIN voucher_entries e ON e.voucher_id=v.id
     WHERE v.company_id=${COMPANY} AND v.deleted_at IS NULL AND v.optional=false
       AND e.factory_supplier_id=${SUPPLIER}
       AND e.ledger_account_id IS NULL AND e.bank_account_id IS NULL
       AND e.fixed_asset_id IS NULL AND e.supplier_id IS NULL AND e.employee_id IS NULL
       AND e.transaction_currency='EUR'
       AND e.base_credit_amount IS NOT NULL AND e.base_debit_amount IS NOT NULL
  `)).rows[0];
  const exists=fix.length===2;
  if(!toMoney(sum?.net as string).eq(exists ? EUR_AFTER : EUR_BEFORE)) {
    throw new Error("ABO82_SUPPLIER_BALANCE_CHANGED");
  }
  return { exists, nativeBalance: toMoney(sum?.net as string).toFixed(2) };
}

export async function repairAboSobhiGoods82(apply: boolean) {
  return runWithDatabaseScopeRuntimeContext(createTenantDatabaseScope(COMPANY),async()=>{
    return db.transaction(async tx=>{
      const before=await inspect(tx);
      if(!apply || before.exists) return {
        checked:1,pending:before.exists?0:1,posted:0,nativeBalance:before.nativeBalance,
      };
      await postFactoryVoucherTx(tx,{
        companyId:COMPANY,
        voucherType:"Journal",
        voucherNumber:VOUCHER_NO,
        voucherDate:"2026-10-15",
        description:"ABO SOBHI DIRECT TCLU8160430: EUR 0.32/kg original import increased to saved EUR 0.36/kg; 21,460 kg × 0.04 = EUR 858.40; owner-approved accounting catch-up",
        currency:"EUR",
        fxRateToUsd:USD_PER_EUR,
        source:{sourceType:"factory-goods-value-catchup",sourceId:"82-20261015",phase:"owner-approved-exact-import-delta"},
        lines:[
          {ledgerAccountId:INVENTORY_ACCOUNT,debit:EUR_DELTA,narration:"Increase imported raw goods account for saved rate EUR 0.36/kg"},
          {factorySupplierId:SUPPLIER,credit:EUR_DELTA,narration:"Increase ABO SOBHI EUR supplier payable to EUR 42,430.40"},
        ],
      });
      const after=await inspect(tx);
      if(!after.exists || after.nativeBalance!==EUR_AFTER) throw new Error("ABO82_POSTCHECK_FAILED");
      return {checked:1,pending:0,posted:1,nativeBalance:after.nativeBalance};
    });
  });
}

if(process.argv[1]?.includes("repair-abo-sobhi-goods-82-20261015")){
  const args=new Set(process.argv.slice(2));
  const apply=args.has("--apply");
  if(apply && !args.has("--owner-approved")){
    console.error("ABO82_OWNER_APPROVAL_REQUIRED");
    process.exitCode=1;
  }else{
    void repairAboSobhiGoods82(apply)
      .then(r=>console.log("[ABO82] "+JSON.stringify(r)))
      .catch(e=>{console.error(e);process.exitCode=1;})
      .finally(()=>pool.end());
  }
}

/**
 * Audited one-time reconciliation, company 12, UK BASMA #38.
 *
 * The operational statement nets to 0.00 USD. Original posted GL only has
 * -5615.10 USD because (a) container #85 supplier-paid freight 3361.00
 * was credited to the general Freight ledger account #805 instead of the
 * supplier, and (b) container #126 was re-priced from USD .75/kg (import
 * journal) to its current saved USD .8684/kg with 19038 kg (delta 2254.10).
 *
 * Preserve ALL original journals, offload costs, payments, container data,
 * and historical dates; post only new balanced correction journals dated
 * 2026-10-15, once, after exact original-source verification. No new charge
 * is added for the already-booked freight: its credit is re-attributed.
 */
import { sql } from "drizzle-orm";
import { db, pool, type DbTransaction } from "../server/db";
import { MoneyDecimal, toMoney } from "../server/lib/money";
import { postFactoryVoucherTx } from "../server/services/factory/factoryVoucherPosting";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../server/services/security/databaseScopeRuntimeContext";

const COMPANY = 12;
const BASMA = 38;
const GOODS = 126;
const FREIGHT = 85;
const INVENTORY_LEDGER = 814;
const FREIGHT_LEDGER = 805;
const FACTORY_CHARGES_LEDGER = 812;
const GOODS_IMPORT = 9287;
const FREIGHT_VOUCHER = 9627;
const DATE = "2026-10-15";
const GOOD_DELTA = "2254.10";
const FREIGHT_REASSIGN = "3361.00";
const BEFORE = "-5615.10";
const AFTER = "0.00";
const GOODS_VOUCHER_NO = "FACTORY-BASMA-GOODS-CATCHUP-20261015-126";
const FREIGHT_VOUCHER_NO = "FACTORY-BASMA-FREIGHT-RECLASS-20261015-85";

type Entry = {
  voucher_id: number | string;
  voucher_number: string;
  deleted_at: string | null;
  optional: boolean;
  company_id: number | string;
  currency: string;
  line_id: number | string;
  ledger_account_id: number | null;
  factory_supplier_id: number | null;
  debit_amount: string | number;
  credit_amount: string | number;
};

function sameAmount(v: unknown, n: string) {
  return toMoney(v as string).eq(n);
}

async function originalLines(tx: DbTransaction, id: number): Promise<Entry[]> {
  const r = await tx.execute(sql`
    SELECT v.id voucher_id, v.voucher_number, v.deleted_at, v.optional,
           v.company_id, v.currency, e.id line_id, e.ledger_account_id,
           e.factory_supplier_id, e.debit_amount, e.credit_amount
    FROM vouchers v JOIN voucher_entries e ON e.voucher_id=v.id
    WHERE v.company_id=${COMPANY} AND v.id=${id}
    ORDER BY e.id FOR SHARE OF v,e
  `);
  return r.rows as unknown as Entry[];
}

function expectTwoSided(
  lines: Entry[], noPrefix: string, debitAccount: number,
  creditAccount: number | null, creditSupplier: number | null, amount: string,
  debitLineId: number, creditLineId: number,
) {
  if(lines.length!==2 || lines.some(x=>x.deleted_at!==null ||
      x.optional!==false || x.currency!=="USD" ||
      Number(x.company_id)!==COMPANY || !x.voucher_number.startsWith(noPrefix))) {
    throw new Error("BASMA_SOURCE_VOUCHER_CHANGED_"+noPrefix);
  }
  const dr=lines.find(x=>Number(x.line_id)===debitLineId);
  const cr=lines.find(x=>Number(x.line_id)===creditLineId);
  if(!dr || !cr || Number(dr.ledger_account_id)!==debitAccount ||
     dr.factory_supplier_id!==null || !sameAmount(dr.debit_amount,amount) ||
     !sameAmount(dr.credit_amount,"0") ||
     (creditAccount!==null ? Number(cr.ledger_account_id)!==creditAccount : cr.ledger_account_id!==null) ||
     (creditSupplier!==null ? Number(cr.factory_supplier_id)!==creditSupplier : cr.factory_supplier_id!==null) ||
     !sameAmount(cr.debit_amount,"0") || !sameAmount(cr.credit_amount,amount)) {
    throw new Error("BASMA_ORIGINAL_LINES_CHANGED_"+noPrefix);
  }
}

async function inspect(tx: DbTransaction) {
  const s=(await tx.execute(sql`
    SELECT id,name,company_id,opening_balance FROM factory_suppliers
    WHERE id=${BASMA} AND company_id=${COMPANY}
    FOR SHARE
  `)).rows[0];
  if(!s || s.name!=="UK BASMA" || !sameAmount(s.opening_balance,"0")) {
    throw new Error("BASMA_PARTY_SOURCE_CHANGED");
  }

  const c=(await tx.execute(sql`
    SELECT id,company_id,supplier_id,container_number,status,deleted_at,
           currency_code,total_kg,rate_per_kg,freight,freight_currency_code,
           freight_paid_by,freight_account_id,freight_supplier_id
    FROM factory_containers WHERE company_id=${COMPANY}
      AND id IN(${GOODS},${FREIGHT}) ORDER BY id FOR SHARE
  `)).rows;
  const goods=c.find(x=>Number(x.id)===GOODS);
  const freight=c.find(x=>Number(x.id)===FREIGHT);
  if(c.length!==2 || !goods || !freight ||
     c.some(x=>x.deleted_at!==null || Number(x.company_id)!==COMPANY ||
                 Number(x.supplier_id)!==BASMA || x.currency_code!=="USD") ||
     goods.container_number!=="FFAU5563078" || goods.status!=="OFFLOADED" ||
     !sameAmount(goods.total_kg,"19038") ||
     !sameAmount(goods.rate_per_kg,"0.8684") ||
     !toMoney(goods.total_kg as string).times(goods.rate_per_kg as string).eq("16532.5992") ||
     freight.container_number!=="MSDU8616353" ||
     freight.freight_paid_by!=="supplier" ||
     !sameAmount(freight.freight,"3361") ||
     Number(freight.freight_account_id)!==FREIGHT_LEDGER ||
     freight.freight_supplier_id!==null ||
     freight.freight_currency_code!=="USD") {
    throw new Error("BASMA_CONTAINER_SOURCE_CHANGED");
  }

  expectTwoSided(await originalLines(tx,GOODS_IMPORT),"FACTORY-IMPORT-126-",
    INVENTORY_LEDGER,null,BASMA,"14278.50",32006,32007);
  expectTwoSided(await originalLines(tx,FREIGHT_VOUCHER),"FACTORY-FREIGHT-85-",
    FACTORY_CHARGES_LEDGER,FREIGHT_LEDGER,null,"3361.00",33102,33103);

  const repairs=(await tx.execute(sql`
    SELECT v.id voucher_id,v.voucher_number,v.deleted_at,v.optional,v.currency,
      e.id line_id,e.ledger_account_id,e.factory_supplier_id,e.bank_account_id,
      e.supplier_id,e.employee_id,e.fixed_asset_id,e.debit_amount,e.credit_amount
    FROM vouchers v JOIN voucher_entries e ON e.voucher_id=v.id
    WHERE v.company_id=${COMPANY}
      AND v.voucher_number IN(${GOODS_VOUCHER_NO},${FREIGHT_VOUCHER_NO})
    ORDER BY v.id,e.id FOR SHARE OF v,e
  `)).rows;
  const grouped=new Map<string, typeof repairs>();
  for(const x of repairs)grouped.set(String(x.voucher_number),
    [...(grouped.get(String(x.voucher_number))??[]),x]);

  function validateRepair(no:string,debitLedger:number,amount:string) {
    const lines=grouped.get(no);
    if(!lines) return false;
    const d=lines.find(x=>Number(x.ledger_account_id)===debitLedger);
    const cr=lines.find(x=>Number(x.factory_supplier_id)===BASMA);
    if(lines.length!==2 || !d || !cr || d===cr ||
      lines.some(x=>x.deleted_at!==null || x.optional!==false ||
        x.currency!=="USD" || x.bank_account_id!==null ||
        x.supplier_id!==null || x.employee_id!==null || x.fixed_asset_id!==null) ||
      d.factory_supplier_id!==null || cr.ledger_account_id!==null ||
      !sameAmount(d.debit_amount,amount) || !sameAmount(d.credit_amount,"0") ||
      !sameAmount(cr.debit_amount,"0") || !sameAmount(cr.credit_amount,amount)) {
      throw new Error("BASMA_CORRECTION_EXISTING_MISMATCH_"+no);
    }
    return true;
  }
  const alreadyGoods=validateRepair(GOODS_VOUCHER_NO,INVENTORY_LEDGER,GOOD_DELTA);
  const alreadyFreight=validateRepair(FREIGHT_VOUCHER_NO,FREIGHT_LEDGER,FREIGHT_REASSIGN);
  if(alreadyGoods!==alreadyFreight)throw new Error("BASMA_PARTIAL_CORRECTION_REQUIRES_REVIEW");

  const existing=alreadyGoods&&alreadyFreight;
  const balanceRow=(await tx.execute(sql`
    SELECT COALESCE(SUM(COALESCE(e.credit_amount,0) -
                        COALESCE(e.debit_amount,0)),0)::text AS net
    FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id
    WHERE v.company_id=${COMPANY} AND v.deleted_at IS NULL
      AND v.optional=false AND e.factory_supplier_id=${BASMA}
      AND e.ledger_account_id IS NULL AND e.bank_account_id IS NULL
      AND e.supplier_id IS NULL AND e.employee_id IS NULL
      AND e.fixed_asset_id IS NULL
  `)).rows[0];
  const balance=toMoney(balanceRow?.net as string).toFixed(2);
  if(balance!==(existing?AFTER:BEFORE))
    throw new Error("BASMA_BASE_LEDGER_BALANCE_CHANGED_"+balance);
  return {existing,balance};
}

export async function repairUkBasma38(apply:boolean) {
  return runWithDatabaseScopeRuntimeContext(createTenantDatabaseScope(COMPANY),async()=>{
    return db.transaction(async tx=>{
      const before=await inspect(tx);
      if(!apply||before.existing) {
        return {checked:2,pending:before.existing?0:2,posted:0,baseBalance:before.balance};
      }
      await postFactoryVoucherTx(tx,{
        companyId:COMPANY,voucherType:"Journal",voucherDate:DATE,
        voucherNumber:GOODS_VOUCHER_NO,currency:"USD",fxRateToUsd:"1",
        description:"UK BASMA container FFAU5563078: source 19,038kg × $0.8684 less original $14,278.50 goods journal = $2,254.10 catch-up. Original import/offload unchanged.",
        source:{sourceType:"factory-basma-import-cost-catchup",
          sourceId:"126:9287",phase:"owner-approved-company12-reconciliation"},
        lines:[
          {ledgerAccountId:INVENTORY_LEDGER,debit:GOOD_DELTA,
            narration:"Goods cost changed from original $0.7500/kg to saved $0.8684/kg"},
          {factorySupplierId:BASMA,credit:GOOD_DELTA,
            narration:"UK BASMA current saved container goods payable"},
        ],
      });
      await postFactoryVoucherTx(tx,{
        companyId:COMPANY,voucherType:"Journal",voucherDate:DATE,
        voucherNumber:FREIGHT_VOUCHER_NO,currency:"USD",fxRateToUsd:"1",
        description:"UK BASMA container MSDU8616353: original $3,361 freight journal credited account 805 instead of supplier; move that credit, do not add a second freight charge.",
        source:{sourceType:"factory-basma-freight-credit-reclassification",
          sourceId:"85:9627",phase:"owner-approved-company12-reconciliation"},
        lines:[
          {ledgerAccountId:FREIGHT_LEDGER,debit:FREIGHT_REASSIGN,
            narration:"Offset misattributed credit to general Freight account"},
          {factorySupplierId:BASMA,credit:FREIGHT_REASSIGN,
            narration:"Supplier-paid $3,361 freight from original journal 9627"},
        ],
      });
      const after=await inspect(tx);
      if(!after.existing||after.balance!==AFTER)
        throw new Error("BASMA_REPAIR_POSTCHECK_FAILED");
      return {checked:2,pending:0,posted:2,baseBalance:after.balance};
    });
  });
}

if(process.argv[1]?.includes("repair-uk-basma-38-20261015")) {
  const args=new Set(process.argv.slice(2)),apply=args.has("--apply");
  if(apply&&!args.has("--owner-approved")) {
    console.error("BASMA_OWNER_APPROVAL_REQUIRED");process.exitCode=1;
  } else {
    void repairUkBasma38(apply)
      .then(r=>console.log("[BASMA_REPAIR] "+JSON.stringify(r)))
      .catch(e=>{console.error(e);process.exitCode=1;})
      .finally(()=>pool.end());
  }
}

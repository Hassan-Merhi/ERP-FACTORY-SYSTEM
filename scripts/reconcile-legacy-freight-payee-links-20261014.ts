/**
 * Company 12: recover freight supplier METADATA ONLY from 36 existing,
 * uniquely identifiable, balanced posted freight vouchers.
 * No vouchers/entries/daybook/costs/FX amounts are created or modified.
 * 20 other legacy containers have only clearing-account entries and must
 * remain unresolved pending a separate source-ledger reconciliation.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../server/services/security/databaseScopeRuntimeContext";

const COMPANY = 12;
const EXPECTED_IDS = [
  53,54,55,56,57,58,59,60,83,88,90,91,92,96,97,98,99,100,
  101,102,103,104,109,110,111,112,113,114,115,116,117,118,119,120,123,125,
];

type Row = {
  id: number;
  company_id: number;
  freight: string;
  supplier_id: number | null;
  freight_supplier_id: number | null;
  freight_own_account_id: number | null;
  freight_paid_by: string;
};
async function reconcile(apply:boolean) {
  await db.transaction(async tx => {
    // One source transaction prevents gaps between beneficiary validation and
    // link creation. The deterministic ID list refuses unfamiliar/new records.
    const result = await tx.execute(sql`
      SELECT id,company_id,freight::text,supplier_id,freight_supplier_id,
             freight_own_account_id,freight_paid_by
      FROM factory_containers
      WHERE company_id=${COMPANY} AND deleted_at IS NULL
        AND id IN (${sql.join(EXPECTED_IDS.map(id => sql`${id}`),sql`,`)})
      ORDER BY id FOR UPDATE
    `);
    const rows = result.rows as unknown as Row[];
    if (rows.length !== EXPECTED_IDS.length ||
        rows.some((c,i) => Number(c.id)!==EXPECTED_IDS[i] ||
          c.freight_paid_by!=="supplier" ||
          Number(c.freight) <= 0 ||
          c.freight_own_account_id !== null)) {
      throw new Error("Freight source rows changed; refuse legacy beneficiary repair");
    }
    let linked=0;
    for (const source of rows) {
      // The entire source voucher family for each container must have exactly
      // one real supplier-credit entry. The identity is read from the POSTED
      // journal, never from the goods supplier.
      const evidence = await tx.execute(sql`
        SELECT v.id voucher_id, v.voucher_number,
               e.factory_supplier_id freight_supplier_id,
               e.credit_amount::text supplier_credit,
               (SELECT COUNT(*)::int FROM voucher_entries ve
                WHERE ve.voucher_id=v.id) AS total_lines,
               (SELECT COALESCE(SUM(ve.debit_amount-ve.credit_amount),0)::text
                FROM voucher_entries ve WHERE ve.voucher_id=v.id) balance
        FROM vouchers v JOIN voucher_entries e ON e.voucher_id=v.id
        WHERE v.company_id=${COMPANY} AND v.deleted_at IS NULL
          AND v.optional=false AND e.credit_amount>0
          AND e.factory_supplier_id IS NOT NULL
          AND (v.voucher_number=${`FACTORY-FREIGHT-${source.id}`}
            OR v.voucher_number LIKE ${`FACTORY-FREIGHT-${source.id}-%`})
        ORDER BY v.id FOR SHARE OF v
      `);
      if (evidence.rows.length!==1) {
        throw new Error(`Freight #${source.id}: expected one supplier credit; found ${evidence.rows.length}`);
      }
      const e=evidence.rows[0] as Record<string,unknown>;
      const supplier=Number(e.freight_supplier_id);
      if (Number(e.total_lines)!==2 || Number(e.balance)!==0 ||
          !(Number(e.supplier_credit)>0) || !Number.isSafeInteger(supplier)) {
        throw new Error(`Freight #${source.id}: source voucher is not a balanced two-line supplier payable`);
      }
      const exists=await tx.execute(sql`
        SELECT id FROM factory_suppliers
        WHERE company_id=${COMPANY} AND id=${supplier} FOR SHARE
      `);
      if (exists.rows.length!==1) {
        throw new Error(`Freight #${source.id}: supplier ${supplier} is missing or cross-company`);
      }
      if (source.freight_supplier_id !== null && source.freight_supplier_id !== supplier) {
        throw new Error(`Freight #${source.id}: saved beneficiary changed; refuse overwrite`);
      }
      if(source.freight_supplier_id===supplier)continue; // retry-safe
      linked++;
      if(apply){
        const x=await tx.execute(sql`
          UPDATE factory_containers
             SET freight_supplier_id=${supplier}
           WHERE company_id=${COMPANY} AND id=${source.id}
             AND deleted_at IS NULL AND freight_supplier_id IS NULL
             AND freight_paid_by='supplier'
          RETURNING id
        `);
        if (x.rows.length!==1) throw new Error(`Freight #${source.id}: metadata update lost race`);
      }
    }
    console.log(`[LegacyFreightPayees] ${apply?"APPLY":"DRY RUN"} verified=${rows.length}, missing_links=${linked}, no voucher/FX/cost changes`);
    if(apply)console.log("[LegacyFreightPayees] DONE: uniquely documented freight payees restored; 20 clearing-only exceptions deliberately untouched");
  });
}
export function reconcileLegacyFreightPayeeLinks20261014(apply:boolean){
  return runWithDatabaseScopeRuntimeContext(createTenantDatabaseScope(COMPANY),()=>reconcile(apply));
}
if(process.argv[1]?.includes("reconcile-legacy-freight-payee-links-20261014")){
  void reconcileLegacyFreightPayeeLinks20261014(process.argv.includes("--apply"))
    .catch(error=>{console.error(error);process.exitCode=1;})
    .finally(()=>pool.end());
}

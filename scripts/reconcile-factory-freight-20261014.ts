/**
 * One-time reviewed company 12 accounting adjustment. Existing June/July
 * vouchers remain immutable; offsetting journals are dated 2026-10-14.
 * Preview before apply. All three corrections commit or roll back together.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";
import { toMoney } from "../server/lib/money";
import { postFactoryVoucherTx } from "../server/services/factory/factoryVoucherPosting";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../server/services/security/databaseScopeRuntimeContext";

const COMPANY = 12;
const CORRECTION_DATE = "2026-10-14";

type Original = {
  id: number;
  voucher_number: string;
  deleted_at: string | null;
  debit: string;
  credit: string;
  freight_debit: string;
  payable_debit: string;
  walid_credit: string;
  freight_credit: string;
  supplier31_credit: string;
  supplier37_credit: string;
};

async function run(apply: boolean) {
  await db.transaction(async (tx) => {
    // Exact source-document lock: no guess based on currently configured FX.
    const containers = await tx.execute(sql`
      SELECT id, container_number, freight::text, freight_currency_code,
             freight_supplier_id, currency_code, fx_rate_to_usd::text, fx_rate_confirmed
        FROM factory_containers
       WHERE company_id = ${COMPANY} AND deleted_at IS NULL AND id IN (89, 122)
       ORDER BY id FOR UPDATE
    `);
    if (containers.rows.length !== 2) throw new Error("Expected 2 original container sources");
    const c89 = containers.rows[0];
    const c122 = containers.rows[1];
    if (Number(c89.id) !== 89 || c89.container_number !== "CMAU8538717" ||
        !toMoney(c89.freight as string).eq("2290") || c89.freight_currency_code !== "EUR" ||
        Number(c89.freight_supplier_id) !== 31 || !toMoney(c89.fx_rate_to_usd as string).eq("1.18") ||
        Number(c122.id) !== 122 || c122.container_number !== "MSMU4364711" ||
        !toMoney(c122.freight as string).eq("1750") || c122.freight_currency_code !== "EUR" ||
        c122.currency_code !== "EUR" || !toMoney(c122.fx_rate_to_usd as string).eq("1.18") ||
        c122.fx_rate_confirmed !== true ||
        (c122.freight_supplier_id !== null && Number(c122.freight_supplier_id) !== 37)) {
      throw new Error("Original freight documents or the entered EUR rate have changed");
    }
    const supplier = await tx.execute(sql`
      SELECT id, name FROM factory_suppliers
       WHERE company_id = ${COMPANY} AND id IN (31,37)
       ORDER BY id FOR SHARE
    `);
    if (supplier.rows.length !== 2 ||
        supplier.rows[0].name !== "SPAIN MANSOUR" ||
        supplier.rows[1].name !== "MODA ZAKARIA DIRECT") {
      throw new Error("Freight payees no longer match the audited supplier identities");
    }
    const charge = await tx.execute(sql`
      SELECT id,container_id,amount::text,ledger_account_id,voucher_id,deleted_at
        FROM factory_offload_additional_charges
       WHERE company_id = ${COMPANY} AND id = 64 FOR UPDATE
    `);
    const ch = charge.rows[0];
    if (!ch || Number(ch.container_id)!==83 || ch.deleted_at !== null ||
        !toMoney(ch.amount as string).eq("1692") || Number(ch.ledger_account_id)!==793 ||
        Number(ch.voucher_id)!==9341) {
      throw new Error("Charge 64 no longer matches its corrected source and voucher");
    }
    const q = await tx.execute(sql`
      SELECT v.id, v.voucher_number, v.deleted_at,
             count(e.id)::int AS lines,
             coalesce(sum(e.debit_amount),0)::text AS debit,
             coalesce(sum(e.credit_amount),0)::text AS credit,
             coalesce(sum(CASE WHEN e.ledger_account_id=805 THEN e.debit_amount ELSE 0 END),0)::text freight_debit,
             coalesce(sum(CASE WHEN e.ledger_account_id=805 THEN e.credit_amount ELSE 0 END),0)::text freight_credit,
             coalesce(sum(CASE WHEN e.ledger_account_id=812 THEN e.debit_amount ELSE 0 END),0)::text payable_debit,
             coalesce(sum(CASE WHEN e.ledger_account_id=793 THEN e.credit_amount ELSE 0 END),0)::text walid_credit,
             coalesce(sum(CASE WHEN e.factory_supplier_id=31 THEN e.credit_amount ELSE 0 END),0)::text supplier31_credit,
             coalesce(sum(CASE WHEN e.factory_supplier_id=37 THEN e.credit_amount ELSE 0 END),0)::text supplier37_credit
        FROM vouchers v JOIN voucher_entries e ON e.voucher_id=v.id
       WHERE v.company_id=${COMPANY} AND v.id IN(8708,10015,9022,10277,9309,9341)
       GROUP BY v.id
       ORDER BY v.id
    `);
    const byId = new Map(q.rows.map((r) => [Number(r.id), r]));
    const check = (id: number, number: string, amount: string, field: string) => {
      const row = byId.get(id);
      if (!row || row.voucher_number !== number || row.deleted_at !== null ||
          Number(row.lines)!==2 ||
          !toMoney(row.debit as string).eq(amount) ||
          !toMoney(row.credit as string).eq(amount) ||
          !toMoney(row[field] as string).eq(amount)) {
        throw new Error(`Original voucher ${id} is no longer an exact verified source`);
      }
    };
    check(8708,"FACTORY-FREIGHT-89","2702.20","supplier31_credit");
    check(10015,"FACTORY-FREIGHT-89-1783057940016","2702.20","supplier31_credit");
    check(9022,"FACTORY-FREIGHT-122","1750","supplier37_credit");
    check(10277,"FACTORY-FREIGHT-122-1783421852305","2065","payable_debit");
    check(9309,"FACTORY-POC-83-64-1781674089261","1692.96","walid_credit");
    check(9341,"FACTORY-POC-BACKFILL-83-64","1692","walid_credit");

    console.log("[FactoryFreightCorrection] Reviewed sources verified: " +
      "CMAU8538717 duplicate $2702.20, MSMU4364711 freight EUR1750 @ 1.18 = USD2065 " +
      "(supplier 37, legacy paid USD1750, delta $315), charge 64 extra $1692.96.");
    if (!apply) {
      console.log("[FactoryFreightCorrection] DRY RUN only; no database changes.");
      return;
    }

    // Only source metadata is corrected; old paid vouchers and native FX remain.
    if (c122.freight_supplier_id === null) {
      const updated = await tx.execute(sql`
        UPDATE factory_containers SET freight_supplier_id=37
         WHERE company_id=${COMPANY} AND id=122 AND freight_supplier_id IS NULL
         RETURNING id
      `);
      if (updated.rows.length!==1) throw new Error("Failed to attach confirmed freight payee");
    }

    const vouchers = [
      {
        sourceId: "89:duplicate-freight",
        number: "FACTORY-CORRECTION-20261014-89",
        description: "Reverse duplicated EUR2290 freight payable at original 1.18: CMAU8538717, voucher 8708; retain 10015",
        lines: [
          { factorySupplierId: 31, debit: "2290.00", narration: "Reverse duplicate freight payable EUR2290, USD2702.20; source 8708" },
          { ledgerAccountId: 805, credit: "2290.00", narration: "Reverse duplicate freight expense EUR2290 at 1.18" },
        ],
        currency: "EUR",
        rate: "1.18",
      },
      {
        sourceId: "83:charge64-legacy-extra",
        number: "FACTORY-CORRECTION-20261014-83",
        description: "Audit reversal of superseded WALID charge 64 voucher 9309; corrected voucher 9341 retained",
        lines: [
          { ledgerAccountId: 793, debit: "1692.96", narration: "Reverse obsolete WALID payable from voucher 9309" },
          { ledgerAccountId: 812, credit: "1692.96", narration: "Reverse obsolete charge 64 posting; retain corrected 1692 voucher" },
        ],
        currency: "USD",
        rate: "1",
      },
      {
        sourceId: "122:retire-legacy-usd-economics",
        number: "FACTORY-CORRECTION-20261014-122-USD",
        description: "Reverse wrong-currency USD1750 freight economics of original voucher 9022, retained for audit",
        lines: [
          { factorySupplierId: 37, debit: "1750.00", narration: "Reverse original USD payable for EUR freight, source 9022" },
          { ledgerAccountId: 805, credit: "1750.00", narration: "Reverse legacy USD freight expense, source 9022" },
        ],
        currency: "USD",
        rate: "1",
      },
      {
        sourceId: "122:correct-eur-freight-1p18",
        number: "FACTORY-CORRECTION-20261014-122-EUR",
        description: "Record MSMU4364711 supplier freight EUR1750 at historical 1.18 as EUR liability, USD2065 base",
        lines: [
          { ledgerAccountId: 805, debit: "1750.00", narration: "Freight expense EUR1750 at USD/EUR 1.18" },
          { factorySupplierId: 37, credit: "1750.00", narration: "MODA ZAKARIA DIRECT freight EUR1750, USD2065 base" },
        ],
        currency: "EUR",
        rate: "1.18",
      },
    ];
    for (const item of vouchers) {
      const response = await postFactoryVoucherTx(tx,{
        companyId:COMPANY,
        voucherType:"Journal",
        voucherNumber:item.number,
        voucherDate:CORRECTION_DATE,
        description:item.description,
        currency:item.currency,
        fxRateToUsd:item.rate,
        source:{ sourceType:"factory-historical-freight-review-20261014", sourceId:item.sourceId, phase:"correction" },
        lines:item.lines,
      });
      console.log(`[FactoryFreightCorrection] ${item.number} voucher=${response.voucher.id} replay=${response.replayed}`);
    }
    console.log("[FactoryFreightCorrection] DONE: 4 compensating journals; original USD freight reversed and proper EUR liability recorded; historical vouchers unchanged.");
  });
}

export function reconcileFactoryFreight20261014(apply:boolean) {
  return runWithDatabaseScopeRuntimeContext(createTenantDatabaseScope(COMPANY),()=>run(apply));
}
if (process.argv[1]?.includes("reconcile-factory-freight-20261014")) {
  void reconcileFactoryFreight20261014(process.argv.includes("--apply"))
    .catch((e)=>{console.error(e);process.exitCode=1;})
    .finally(()=>pool.end());
}

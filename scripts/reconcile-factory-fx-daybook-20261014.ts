import { sql } from "drizzle-orm";
import { db, type DbTransaction } from "../server/db";
import { toMoney } from "../server/lib/money";
import { writeDaybookEntry } from "../server/routes/factory/_helpers";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../server/services/security/databaseScopeRuntimeContext";

const COMPANY = 12;

async function run(apply: boolean) {
  const result = await db.execute(sql`
    SELECT f.id, f.date, f.source_type, f.from_currency_code, f.from_amount,
           f.to_amount_usd, a.name AS source_name, b.name AS target_name
    FROM factory_supplier_fx_transfers f
    JOIN factory_suppliers a ON a.company_id = f.company_id AND a.id = f.from_supplier_id
    JOIN factory_suppliers b ON b.company_id = f.company_id AND b.id = f.to_supplier_id
    WHERE f.company_id = ${COMPANY} ORDER BY f.id
  `);
  const expectedIds = [4,5,6,12,14,15,16,17,18,19,20,21,23,24,25,29,30,31,33,34,35,36,37,38,39,40,42,43,44,45,46,47,49,52,53,54,55,57,58,59,60,61,63,64,65,66,67,68,69,70,71,73,74,75,76,77];
  if (result.rows.length !== expectedIds.length ||
      result.rows.some((record, index) => Number(record.id) !== expectedIds[index])) {
    throw new Error("Audited historical FX transfer IDs changed");
  }
  let linked = 0;
  let inserted = 0;
  let duplicatesRetained = 0;
  for (const doc of result.rows) {
    await db.transaction(async (tx: DbTransaction) => {
      const locked = await tx.execute(sql`
        SELECT date,from_currency_code,from_amount,to_amount_usd
          FROM factory_supplier_fx_transfers
         WHERE company_id=${COMPANY} AND id=${doc.id} FOR UPDATE
      `);
      const latest = locked.rows[0];
      if (!latest || latest.date!==doc.date ||
          latest.from_currency_code!==doc.from_currency_code ||
          !toMoney(latest.from_amount as string).eq(doc.from_amount as string) ||
          !toMoney(latest.to_amount_usd as string).eq(doc.to_amount_usd as string)) {
        throw new Error(`Source FX transfer #${doc.id} changed during audit`);
      }
      const rows = await tx.execute(sql`
        SELECT id, tx_date::text AS date, reference_table,
               currency_code, amount_currency, amount_usd
        FROM factory_daybook_entries
        WHERE company_id = ${COMPANY} AND reference_id = ${doc.id}
          AND tx_type = 'SUPPLIER_FX_TRANSFER' ORDER BY id DESC FOR UPDATE
      `);
      if (rows.rows.length) {
        const matching = rows.rows.filter((row) =>
          row.date === doc.date &&
          String(row.currency_code).toUpperCase() === String(doc.from_currency_code).toUpperCase() &&
          toMoney(row.amount_currency as string).minus(doc.from_amount as string).abs().lt("0.03") &&
          toMoney(row.amount_usd as string).minus(doc.to_amount_usd as string).abs().lt("0.03") &&
          (row.reference_table === null || row.reference_table === "factory_supplier_fx_transfers")
        );
        if (matching.length!==rows.rows.length) {
          throw new Error(`FX daybook data mismatch for transfer #${doc.id}`);
        }
        duplicatesRetained += matching.length-1;
        const current = matching[0];
        if (apply && current.reference_table === null) {
          await tx.execute(sql`UPDATE factory_daybook_entries
            SET reference_table = 'factory_supplier_fx_transfers'
            WHERE company_id = ${COMPANY} AND id = ${current.id} AND reference_table IS NULL`);
        }
        linked += 1;
        return;
      }
      const voucherCheck = await tx.execute(sql`
        SELECT count(*)::int n FROM vouchers
         WHERE company_id=${COMPANY} AND deleted_at IS NULL AND optional=false
           AND voucher_number LIKE ${`FACTORY-SFX-${doc.id}-%`}
      `);
      if (doc.source_type==="supplier" && Number(voucherCheck.rows[0]?.n)!==1) {
        throw new Error(`Supplier FX transfer #${doc.id} lacks its unique ledger voucher`);
      }
      if (apply) {
        await writeDaybookEntry(tx, {
          companyId: COMPANY,
          txDate: String(doc.date),
          txType: "SUPPLIER_FX_TRANSFER",
          referenceId: Number(doc.id),
          referenceTable: "factory_supplier_fx_transfers",
          description: `FX Transfer: ${doc.source_name} ${doc.from_currency_code} ${toMoney(doc.from_amount as string).toFixed(2)} → ${doc.target_name} USD ${toMoney(doc.to_amount_usd as string).toFixed(2)}`,
          amountCurrency: toMoney(doc.from_amount as string).toNumber(),
          amountUsd: toMoney(doc.to_amount_usd as string).toNumber(),
          currencyCode: String(doc.from_currency_code),
          fxRateToUsd: toMoney(doc.to_amount_usd as string).div(doc.from_amount as string).toNumber(),
        });
      }
      inserted += 1;
    });
  }
  if (apply) {
    const check = await db.execute(sql`
      SELECT count(*)::int n FROM factory_supplier_fx_transfers f
       WHERE f.company_id=${COMPANY} AND EXISTS (
         SELECT 1 FROM factory_daybook_entries d
          WHERE d.company_id=f.company_id AND d.reference_id=f.id
            AND d.reference_table='factory_supplier_fx_transfers'
            AND d.tx_type='SUPPLIER_FX_TRANSFER'
       )
    `);
    if (Number(check.rows[0]?.n)!==56) {
      throw new Error("Not all 56 active FX documents have linked daybook records");
    }
  }
  console.log(`[SupplierFxDaybook] ${apply ? "APPLY" : "DRY RUN"}: existing ${linked}, inserted ${inserted}, preserved_duplicates ${duplicatesRetained}`);
  if (apply) console.log("[SupplierFxDaybook] DONE: 56/56 live FX source references reconciled.");
}

export function reconcileSupplierFxDaybook20261014(apply: boolean) {
  return runWithDatabaseScopeRuntimeContext(createTenantDatabaseScope(COMPANY), () => run(apply));
}

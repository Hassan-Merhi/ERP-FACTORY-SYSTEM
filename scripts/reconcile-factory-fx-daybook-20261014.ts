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
  if (result.rows.length !== 56) throw new Error("Expected 56 FX transfers");
  let linked = 0;
  let inserted = 0;
  for (const doc of result.rows) {
    await db.transaction(async (tx: DbTransaction) => {
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
        if (!matching.length) throw new Error(`FX daybook data mismatch for transfer #${doc.id}`);
        const current = matching[0];
        if (apply && current.reference_table === null) {
          await tx.execute(sql`UPDATE factory_daybook_entries
            SET reference_table = 'factory_supplier_fx_transfers'
            WHERE company_id = ${COMPANY} AND id = ${current.id} AND reference_table IS NULL`);
        }
        linked += 1;
        return;
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
        });
      }
      inserted += 1;
    });
  }
  console.log(`[SupplierFxDaybook] ${apply ? "APPLY" : "DRY RUN"}: existing ${linked}, missing ${inserted}`);
}

export function reconcileSupplierFxDaybook20261014(apply: boolean) {
  return runWithDatabaseScopeRuntimeContext(createTenantDatabaseScope(COMPANY), () => run(apply));
}

/**
 * Production company 12 legacy supplier FX transfer journal backfill.
 * No source rates/amounts modified. Explicitly enabled once by Render switch.
 *
 * 51 financial supplier FX transfers => 51 balanced source/destination
 * journals using recorded native amounts and recorded USD settlements.
 * 5 commission allocations => proven covered by original NASRA vouchers,
 * so no duplicate NASRA liability created.
 */
import { sql } from "drizzle-orm";
import { db, pool, type DbTransaction } from "../server/db";
import { MoneyDecimal, toMoney } from "../server/lib/money";
import { getPartyBalance } from "../server/services/accounting/balances/ledgerBalanceEngine";
import {
  assertCommissionAllocationCoveredTx,
  describeSupplierFxConversion,
  postSupplierFxTransferJournalTx,
  type SupplierFxJournalDocument,
} from "../server/services/factory/supplierFxTransferJournal";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../server/services/security/databaseScopeRuntimeContext";

const COMPANY = 12;
const SUPPLIER_IDS = new Set([4,5,6,17,18,19,20,21,24,25,29,30,31,33,34,35,36,37,38,39,40,42,43,44,45,46,47,49,52,53,54,55,57,58,59,60,61,63,64,65,66,67,68,69,70,71,73,74,75,76,77]);
const COMMISSION_IDS = new Set([12,14,15,16,23]);

type Source = SupplierFxJournalDocument & { notes: string | null };

async function snapshot(tx: DbTransaction | typeof db): Promise<Source[]> {
  const result = await tx.execute(sql`
    SELECT id, company_id AS "companyId", date, from_supplier_id AS "fromSupplierId",
           to_supplier_id AS "toSupplierId", source_type AS "sourceType",
           from_currency_code AS "fromCurrencyCode", from_amount::text AS "fromAmount",
           fx_rate_to_usd::text AS "fxRateToUsd",
           to_amount_usd::text AS "toAmountUsd", notes
      FROM factory_supplier_fx_transfers WHERE company_id = ${COMPANY}
     ORDER BY id
  `);
  return result.rows as unknown as Source[];
}

function fieldsEqual(x: Source, y: Source): boolean {
  return (
    x.id === y.id &&
    x.companyId === y.companyId &&
    x.date === y.date &&
    x.fromSupplierId === y.fromSupplierId &&
    x.toSupplierId === y.toSupplierId &&
    x.sourceType === y.sourceType &&
    x.fromCurrencyCode === y.fromCurrencyCode &&
    toMoney(x.fromAmount).eq(y.fromAmount) &&
    toMoney(x.fxRateToUsd).eq(y.fxRateToUsd) &&
    toMoney(x.toAmountUsd).eq(y.toAmountUsd)
  );
}

async function lockAndValidate(tx: DbTransaction, initial: Source): Promise<Source> {
  const result = await tx.execute(sql`
    SELECT id, company_id AS "companyId", date, from_supplier_id AS "fromSupplierId",
           to_supplier_id AS "toSupplierId", source_type AS "sourceType",
           from_currency_code AS "fromCurrencyCode", from_amount::text AS "fromAmount",
           fx_rate_to_usd::text AS "fxRateToUsd",
           to_amount_usd::text AS "toAmountUsd", notes
      FROM factory_supplier_fx_transfers
     WHERE company_id = ${COMPANY} AND id = ${initial.id} FOR UPDATE
  `);
  const latest = result.rows[0] as unknown as Source | undefined;
  if (!latest || !fieldsEqual(initial, latest)) throw new Error(`Transfer #${initial.id} changed since audit`);
  return latest;
}

async function closing(tx: DbTransaction, supplierId: number) {
  const balance = await getPartyBalance(tx, {
    companyId: COMPANY, kind: "factorySupplier", id: supplierId, memo: true,
  });
  if (!balance) throw new Error(`Supplier ${supplierId} was not found in ledger balance engine`);
  return toMoney(balance.closing);
}

async function existingVoucher(tx: DbTransaction, id: number): Promise<boolean> {
  const result = await tx.execute(sql`
    SELECT id FROM vouchers WHERE company_id = ${COMPANY}
      AND deleted_at IS NULL AND optional = false
      AND voucher_number LIKE ${`FACTORY-SFX-${id}-%`}
    LIMIT 1
  `);
  return result.rows.length > 0;
}

async function run(apply: boolean): Promise<void> {
  const docs = await snapshot(db);
  const ids = docs.map((d) => d.id);
  if (docs.length !== 56 ||
    ids.some((id) => !SUPPLIER_IDS.has(id) && !COMMISSION_IDS.has(id)) ||
    [...SUPPLIER_IDS, ...COMMISSION_IDS].some((id) => !ids.includes(id))) {
    throw new Error("FX transfer set changed from audited 56: no posting");
  }
  const supplierDocs = docs.filter((d) => SUPPLIER_IDS.has(d.id));
  const total = supplierDocs.reduce((sum, d) => sum.plus(toMoney(d.toAmountUsd)), new MoneyDecimal(0));
  if (!total.eq("1282143.9553")) throw new Error("FX transfer financial total changed since audit");
  for (const d of supplierDocs) {
    if (d.sourceType !== "supplier") throw new Error(`Transfer #${d.id} source kind changed`);
    describeSupplierFxConversion(d);
  }

  console.log(`[SupplierFxRepair] ${apply ? "APPLY" : "DRY RUN"}: ${supplierDocs.length} supplier transfers, 5 existing commission allocations, USD ${total.toFixed(4)}`);

  for (const original of docs.filter((d) => COMMISSION_IDS.has(d.id))) {
    await db.transaction(async (tx) => {
      const row = await lockAndValidate(tx, original);
      await assertCommissionAllocationCoveredTx(tx, COMPANY, row);
      console.log(`[SupplierFxRepair] Commission allocation #${row.id} backed by existing NASRA commission vouchers; no second posting`);
    });
  }
  if (!apply) {
    console.log("[SupplierFxRepair] DRY RUN verified all 56 source records and direct NASRA commission coverage; no database changes");
    return;
  }

  let posted = 0;
  let replayed = 0;
  for (const original of supplierDocs) {
    await db.transaction(async (tx) => {
      const row = await lockAndValidate(tx, original);
      if (await existingVoucher(tx, row.id)) {
        replayed += 1;
        console.log(`[SupplierFxRepair] Transfer #${row.id} already journaled; skipped`);
        return;
      }
      const beforeSource = await closing(tx, row.fromSupplierId);
      const beforeTarget = row.toSupplierId === row.fromSupplierId
        ? beforeSource
        : await closing(tx, row.toSupplierId);
      const result = await postSupplierFxTransferJournalTx(tx, row);
      if (result.replayed) {
        replayed += 1;
        console.log(`[SupplierFxRepair] Transfer #${row.id} replayed existing voucher`);
        return;
      }
      const usd = toMoney(row.toAmountUsd);
      const afterSource = await closing(tx, row.fromSupplierId);
      const afterTarget = row.toSupplierId === row.fromSupplierId
        ? afterSource
        : await closing(tx, row.toSupplierId);
      const expectedSource = row.fromSupplierId === row.toSupplierId
        ? new MoneyDecimal(0) : usd;
      const expectedTarget = row.fromSupplierId === row.toSupplierId
        ? new MoneyDecimal(0) : usd.negated();
      if (afterSource.minus(beforeSource).minus(expectedSource).abs().gt("0.02") ||
          afterTarget.minus(beforeTarget).minus(expectedTarget).abs().gt("0.02")) {
        throw new Error(`Transfer #${row.id} changed a supplier balance beyond its booked USD amount`);
      }
      const voucher = await tx.execute(sql`
        SELECT COALESCE(SUM(debit_amount-credit_amount),0)::text AS net
          FROM voucher_entries WHERE voucher_id = ${result.voucherId}
      `);
      if (toMoney(voucher.rows[0]?.net as string).abs().gt("0.000001")) {
        throw new Error(`Transfer #${row.id} posted an unbalanced voucher`);
      }
      posted += 1;
      console.log(`[SupplierFxRepair] Posted supplier transfer #${row.id}, voucher #${result.voucherId} (native ${row.fromAmount} ${row.fromCurrencyCode}, USD ${usd.toFixed(4)}), balanced`);
    });
  }

  const verification = await db.execute(sql`
    SELECT f.id
      FROM factory_supplier_fx_transfers f
     WHERE f.company_id = ${COMPANY} AND f.source_type = 'supplier'
       AND NOT EXISTS (SELECT 1 FROM vouchers v WHERE v.company_id = ${COMPANY}
         AND v.deleted_at IS NULL AND v.optional = false
         AND v.voucher_number LIKE 'FACTORY-SFX-' || f.id::text || '-%')
     ORDER BY f.id
  `);
  if (verification.rows.length) {
    throw new Error(`Remaining unjournaled supplier transfers: ${verification.rows.map((r) => r.id).join(",")}`);
  }
  console.log(`[SupplierFxRepair] DONE: ${posted} posted, ${replayed} already posted; 5 commission allocations accounted by their existing NASRA vouchers. USD ${total.toFixed(4)} reconciled.`);
}

export function reconcileFactorySupplierFx20261014(apply: boolean) {
  return runWithDatabaseScopeRuntimeContext(createTenantDatabaseScope(COMPANY), () => run(apply));
}

if (process.argv[1]?.includes("reconcile-factory-supplier-fx-20261014")) {
  void reconcileFactorySupplierFx20261014(process.argv.includes("--apply"))
    .catch((error) => { console.error(error); process.exitCode = 1; })
    .finally(() => pool.end());
}

/**
 * Audited company-12 correction: 18 legacy factory goods payable credits belong
 * to a different CURRENT goods supplier from the party on their old import voucher.
 *
 * Source: original posted vouchers (not the current container goods price).
 * Avoid the unrelated BANIN/#67 numeric-reference collision.
 * Corrections are NEW balanced journals in an open period: debit original payee,
 * credit currently verified goods supplier in original EUR at the original 1.18.
 * No revaluation, original voucher mutation, freight reclassification, or
 * changes to source container economics.
 *
 * Dry-run: npx tsx scripts/reclassify-factory-import-payables-20261015.ts
 * Apply:   npx tsx scripts/reclassify-factory-import-payables-20261015.ts --apply --company-12-reviewed
 *
 * Fail-closed, single transaction, original ID + original native/base + company
 * + currency + payee checks, with idempotency in the central posting engine.
 * Rerunning after success verifies the already-posted adjustment and skips it.
 */
import { sql } from "drizzle-orm";
import { db, pool, type DbTransaction } from "../server/db";
import { MoneyDecimal, toMoney } from "../server/lib/money";
import { postFactoryVoucherTx } from "../server/services/factory/factoryVoucherPosting";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../server/services/security/databaseScopeRuntimeContext";

const COMPANY_ID = 12;
const JOURNAL_DATE = "2026-10-15";
const RATE = "1.18";
const FAMILY = "FACTORY-PAYABLE-RECLASS-20261015-";

type VerifiedSource = {
  container: number;
  originalSupplier: number;
  currentSupplier: number;
  originalVoucher: number;
  originalCreditLine: number;
  eur: string;
  usd: string;
};

// Frozen source evidence independently checked on live production 2026-10-15.
// New historical journal/line IDs or amounts require a NEW review, not widening
// this one-time script's acceptance criteria.
export const REVIEWED_IMPORT_PAYABLES: readonly VerifiedSource[] = [
  { container: 71,  originalSupplier: 37, currentSupplier: 60, originalVoucher: 6335,  originalCreditLine: 22285, eur: "7311.20", usd: "8627.22" },
  { container: 73,  originalSupplier: 37, currentSupplier: 60, originalVoucher: 6609,  originalCreditLine: 23548, eur: "6859.00", usd: "8093.62" },
  { container: 78,  originalSupplier: 37, currentSupplier: 60, originalVoucher: 7607,  originalCreditLine: 26281, eur: "7562.00", usd: "8923.16" },
  { container: 96,  originalSupplier: 37, currentSupplier: 60, originalVoucher: 8188,  originalCreditLine: 28198, eur: "2709.00", usd: "3196.62" },
  { container: 97,  originalSupplier: 37, currentSupplier: 60, originalVoucher: 8189,  originalCreditLine: 28200, eur: "2709.00", usd: "3196.62" },
  { container: 98,  originalSupplier: 37, currentSupplier: 60, originalVoucher: 8190,  originalCreditLine: 28202, eur: "2709.00", usd: "3196.62" },
  { container: 99,  originalSupplier: 37, currentSupplier: 60, originalVoucher: 8191,  originalCreditLine: 28204, eur: "2709.00", usd: "3196.62" },
  { container: 100, originalSupplier: 37, currentSupplier: 60, originalVoucher: 8192,  originalCreditLine: 28206, eur: "2709.00", usd: "3196.62" },
  { container: 74,  originalSupplier: 28, currentSupplier: 35, originalVoucher: 6613,  originalCreditLine: 23556, eur: "7898.40", usd: "9320.11" },
  { container: 153, originalSupplier: 42, currentSupplier: 49, originalVoucher: 10003, originalCreditLine: 34408, eur: "3692.00", usd: "4356.56" },
  { container: 154, originalSupplier: 42, currentSupplier: 49, originalVoucher: 10004, originalCreditLine: 34410, eur: "3960.00", usd: "4672.80" },
  { container: 155, originalSupplier: 42, currentSupplier: 48, originalVoucher: 10005, originalCreditLine: 34412, eur: "3640.00", usd: "4295.20" },
  { container: 158, originalSupplier: 42, currentSupplier: 48, originalVoucher: 10008, originalCreditLine: 34418, eur: "8397.00", usd: "9908.46" },
  { container: 156, originalSupplier: 42, currentSupplier: 47, originalVoucher: 10006, originalCreditLine: 34414, eur: "3760.00", usd: "4436.80" },
  { container: 157, originalSupplier: 42, currentSupplier: 47, originalVoucher: 10007, originalCreditLine: 34416, eur: "3840.00", usd: "4531.20" },
  { container: 159, originalSupplier: 42, currentSupplier: 47, originalVoucher: 10009, originalCreditLine: 34420, eur: "4500.00", usd: "5310.00" },
  { container: 160, originalSupplier: 42, currentSupplier: 47, originalVoucher: 10010, originalCreditLine: 34422, eur: "4675.00", usd: "5516.50" },
  { container: 161, originalSupplier: 42, currentSupplier: 47, originalVoucher: 10011, originalCreditLine: 34424, eur: "4662.50", usd: "5501.75" },
];

type QueryTx = DbTransaction;

async function verifyOriginal(tx: QueryTx, source: VerifiedSource): Promise<void> {
  const container = await tx.execute(sql`
    SELECT id, supplier_id, container_number
    FROM factory_containers
    WHERE company_id = ${COMPANY_ID} AND id = ${source.container} AND deleted_at IS NULL
    FOR UPDATE
  `);
  const c = container.rows[0];
  if (!c || Number(c.supplier_id) !== source.currentSupplier) {
    throw new Error("Factory container #" + source.container + " has a changed goods supplier; abort all corrections");
  }

  const voucher = await tx.execute(sql`
    SELECT v.id, v.voucher_number, v.currency, v.deleted_at, v.optional,
           v.source_module, e.id AS entry_id, e.factory_supplier_id,
           e.ledger_account_id, e.supplier_id, e.debit_amount, e.credit_amount,
           e.transaction_currency, e.transaction_credit_amount, e.base_credit_amount,
           e.historical_exchange_rate
      FROM vouchers v JOIN voucher_entries e ON e.voucher_id = v.id
     WHERE v.company_id = ${COMPANY_ID} AND v.id = ${source.originalVoucher}
     ORDER BY e.id FOR UPDATE OF v, e
  `);
  const rows = voucher.rows;
  const old = rows.find((r) => Number(r.id) === source.originalVoucher &&
    Number(r.entry_id) === source.originalCreditLine);
  const balance = rows.reduce(
    (s, r) => s.plus(toMoney(r.debit_amount as string).minus(toMoney(r.credit_amount as string))),
    new MoneyDecimal(0)
  );
  if (rows.length !== 2 || !old ||
      !String(old.voucher_number).startsWith("FACTORY-IMPORT-" + source.container + "-") ||
      old.deleted_at !== null || old.optional !== false || old.source_module !== "FACTORY" ||
      old.currency !== "EUR" || Number(old.factory_supplier_id) !== source.originalSupplier ||
      old.ledger_account_id !== null || old.supplier_id !== null ||
      !toMoney(old.debit_amount as string).isZero() ||
      !toMoney(old.transaction_credit_amount as string).eq(source.eur) ||
      !toMoney(old.credit_amount as string).eq(source.usd) ||
      !toMoney(old.base_credit_amount as string).minus(toMoney(source.eur).times(RATE)).abs().lte("0.005") ||
      old.transaction_currency !== "EUR" ||
      !toMoney(old.historical_exchange_rate as string).eq(RATE) ||
      !balance.isZero()) {
    throw new Error("Original EUR payable voucher evidence no longer matches container #" + source.container);
  }
}

async function existingAdjustment(tx: QueryTx, source: VerifiedSource): Promise<number | null> {
  const number = FAMILY + source.container;
  const r = await tx.execute(sql`
    SELECT v.id, v.deleted_at, v.optional,
           COUNT(e.id)::int AS entry_count,
           COALESCE(SUM(e.transaction_debit_amount)
             FILTER (WHERE e.factory_supplier_id = ${source.originalSupplier}), 0)::text AS old_debit,
           COALESCE(SUM(e.transaction_credit_amount)
             FILTER (WHERE e.factory_supplier_id = ${source.currentSupplier}), 0)::text AS new_credit,
           COALESCE(SUM(e.debit_amount-e.credit_amount), 0)::text AS usd_difference
      FROM vouchers v LEFT JOIN voucher_entries e ON e.voucher_id = v.id
     WHERE v.company_id = ${COMPANY_ID} AND v.voucher_number = ${number}
     GROUP BY v.id
  `);
  if (!r.rows.length) return null;
  if (r.rows.length !== 1) throw new Error("Ambiguous correction vouchers for #" + source.container);
  const row = r.rows[0];
  if (row.deleted_at !== null || row.optional !== false ||
      Number(row.entry_count) !== 2 ||
      !toMoney(row.old_debit as string).eq(source.eur) ||
      !toMoney(row.new_credit as string).eq(source.eur) ||
      !toMoney(row.usd_difference as string).isZero()) {
    throw new Error("Existing correction does not match reviewed EUR payable source #" + source.container);
  }
  return Number(row.id);
}

export async function reclassifyFactoryImportPayables20261015(apply: boolean) {
  return runWithDatabaseScopeRuntimeContext(createTenantDatabaseScope(COMPANY_ID), async () => {
    const totalEur = REVIEWED_IMPORT_PAYABLES.reduce(
      (v, row) => v.plus(toMoney(row.eur)), new MoneyDecimal(0));
    const totalUsd = REVIEWED_IMPORT_PAYABLES.reduce(
      (v, row) => v.plus(toMoney(row.usd)), new MoneyDecimal(0));
    if (REVIEWED_IMPORT_PAYABLES.length !== 18 ||
        !totalEur.eq("84302.10") || !totalUsd.eq("99476.48")) {
      throw new Error("Source review totals changed; abort");
    }
    return db.transaction(async (tx) => {
      // Check EVERY source and existing correction before changing ANY ledger row.
      const needed: VerifiedSource[] = [];
      for (const row of REVIEWED_IMPORT_PAYABLES) {
        await verifyOriginal(tx, row);
        const existing = await existingAdjustment(tx, row);
        if (!existing) needed.push(row);
      }
      console.log("[FactoryPartyReclass] Verified 18 original goods vouchers, " +
        needed.length + " remaining. EUR " + totalEur.toFixed(2) +
        ", USD " + totalUsd.toFixed(2) + ". Mode=" + (apply ? "APPLY" : "DRY-RUN"));
      if (!apply) return { inspected: 18, pending: needed.length, posted: 0 };

      for (const row of needed) {
        const post = await postFactoryVoucherTx(tx, {
          companyId: COMPANY_ID,
          voucherType: "Journal",
          voucherNumber: FAMILY + row.container,
          voucherDate: JOURNAL_DATE,
          description: "Audited reclassification of original import voucher #" +
            row.originalVoucher + ", container #" + row.container +
            ": transfer ORIGINAL EUR payable from supplier " + row.originalSupplier +
            " to goods supplier " + row.currentSupplier,
          currency: "EUR",
          fxRateToUsd: RATE,
          source: {
            sourceType: "factory-import-payable-reclassification",
            sourceId: String(row.originalVoucher) + ":" + String(row.originalCreditLine),
            phase: "20261015-audited",
          },
          lines: [
            { factorySupplierId: row.originalSupplier, debit: row.eur,
              narration: "Offset original payable, source entry " + row.originalCreditLine },
            { factorySupplierId: row.currentSupplier, credit: row.eur,
              narration: "Recognize original payable, source entry " + row.originalCreditLine },
          ],
        });
        if (!post.voucher.id) throw new Error("Missing posted reclassification #" + row.container);
        if (!(await existingAdjustment(tx, row))) {
          throw new Error("Posted journal missing or does not match reviewed source #" + row.container);
        }
        console.log("[FactoryPartyReclass] container=" + row.container +
          " original=" + row.originalSupplier + " new=" + row.currentSupplier +
          " EUR=" + row.eur + " voucher=" + post.voucher.id);
      }
      return { inspected: 18, pending: 0, posted: needed.length };
    });
  });
}

if (process.argv[1]?.includes("reclassify-factory-import-payables-20261015")) {
  const args = new Set(process.argv.slice(2));
  const apply = args.has("--apply");
  if (apply && !args.has("--company-12-reviewed")) {
    console.error("Refusing to apply: add --company-12-reviewed after reviewing DRY RUN.");
    process.exitCode = 1;
  } else {
    void reclassifyFactoryImportPayables20261015(apply)
      .then((summary) => console.log("[FactoryPartyReclass] " + JSON.stringify(summary)))
      .catch((error) => { console.error(error); process.exitCode = 1; })
      .finally(() => pool.end());
  }
}

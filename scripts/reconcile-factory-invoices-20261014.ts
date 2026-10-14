/**
 * Historical Factory Customer invoice journals — company 12 only.
 *
 * DRY RUN:  npx tsx scripts/reconcile-factory-invoices-20261014.ts
 * POST:     npx tsx scripts/reconcile-factory-invoices-20261014.ts --apply
 *
 * No automatic execution at boot. Uses existing engine with historical invoice
 * dates, transaction-scoped reconciliation, and rollback on balance drift.
 * Existing CHARGE-* vouchers are retained. Does NOT post COGS: inventory cutover
 * has not been enabled for company 12.
 */
import { sql } from "drizzle-orm";
import { db, pool, type DbTransaction } from "../server/db";
import { MoneyDecimal, toMoney } from "../server/lib/money";
import { getPartyBalance } from "../server/services/accounting/balances/ledgerBalanceEngine";
import { syncFactoryInvoiceTx } from "../server/services/accounting/perpetualInventory/factoryInvoice";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../server/services/security/databaseScopeRuntimeContext";

const COMPANY = 12;
const APPLY = process.argv.includes("--apply");

interface Candidate {
  id: number;
  customer_id: number;
  customer_name: string;
  invoice_number: string;
  gross: string;
  already_posted_charges: string;
  unlinked_positive_charges: string;
  unlinked_charge_ids: string | null;
  invoice_date: string;
  currency_code: string;
  cache_count: number;
  cache_total: string;
}

async function candidates(): Promise<Candidate[]> {
  const result = await db.execute<Candidate & Record<string, unknown>>(sql`
    SELECT co.id, co.customer_id, c.legal_name AS customer_name, co.invoice_number,
           co.grand_total::text AS gross,
           COALESCE((SELECT SUM(ch.amount) FROM customer_order_charges ch
             JOIN vouchers v ON v.id = ch.voucher_id AND v.company_id = co.company_id
               AND v.deleted_at IS NULL AND v.optional = false
             WHERE ch.order_id = co.id), 0)::text AS already_posted_charges,
           COALESCE((SELECT SUM(ch.amount) FROM customer_order_charges ch
             WHERE ch.order_id = co.id AND ch.voucher_id IS NULL AND ch.amount > 0), 0)::text
             AS unlinked_positive_charges,
           (SELECT string_agg(ch.id::text, ',') FROM customer_order_charges ch
             WHERE ch.order_id = co.id AND ch.voucher_id IS NULL AND ch.amount > 0) AS unlinked_charge_ids,
           COALESCE(co.finalized_at, co.created_at)::date::text AS invoice_date,
           UPPER(COALESCE(b.currency, 'USD')) AS currency_code,
           (SELECT COUNT(*)::int FROM customer_balances cb
              WHERE cb.company_id = co.company_id AND cb.customer_id = co.customer_id
                AND cb.reference_type = 'INVOICE' AND cb.transaction_type = 'SALE'
                AND cb.reference_id = co.id) AS cache_count,
           COALESCE((SELECT SUM(cb.debit_amount - cb.credit_amount)
              FROM customer_balances cb WHERE cb.company_id = co.company_id
                AND cb.customer_id = co.customer_id AND cb.reference_type = 'INVOICE'
                AND cb.transaction_type = 'SALE' AND cb.reference_id = co.id), 0)::text AS cache_total
      FROM customer_orders co
      JOIN customers c ON c.id = co.customer_id AND c.company_id = co.company_id
      LEFT JOIN customer_dispatch_batches b ON b.id = co.dispatch_batch_id AND b.company_id = co.company_id
     WHERE co.company_id = ${COMPANY} AND co.status = 'FINALIZED' AND co.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM vouchers v WHERE v.company_id = co.company_id
         AND v.deleted_at IS NULL AND v.optional = false
         AND v.voucher_number = 'INV-GL-' || co.company_id::text || '-' || co.id::text)
     ORDER BY co.id
  `);
  return result.rows as Candidate[];
}

async function assertCandidateBeforePosting(
  tx: DbTransaction,
  candidate: Candidate
) {
  const lock = await tx.execute(sql`
    SELECT id, status, grand_total FROM customer_orders
     WHERE company_id = ${COMPANY} AND id = ${candidate.id} FOR UPDATE
  `);
  if (lock.rows.length !== 1 || lock.rows[0].status !== "FINALIZED" ||
      !toMoney(lock.rows[0].grand_total as string).eq(toMoney(candidate.gross))) {
    throw new Error(`Invoice ${candidate.invoice_number} changed after the audit`);
  }
  const conflict = await tx.execute(sql`
    SELECT id FROM vouchers WHERE company_id = ${COMPANY}
      AND voucher_number = ${`INV-GL-${COMPANY}-${candidate.id}`}
      AND deleted_at IS NULL AND optional = false LIMIT 1
  `);
  if (conflict.rows.length) return false;
  return true;
}

async function run() {
  const pending = await candidates();
  console.log(`Company=${COMPANY}, mode=${APPLY ? "APPLY" : "DRY RUN"}, missing=${pending.length}`);
  const gross = pending.reduce((s, r) => s.plus(toMoney(r.gross)), new MoneyDecimal(0));
  const posted = pending.reduce((s, r) => s.plus(toMoney(r.already_posted_charges)), new MoneyDecimal(0));
  const expected = gross.minus(posted);
  console.log(`Gross=${gross.toFixed(2)} already-journaled charges=${posted.toFixed(2)} outstanding-invoice-GL=${expected.toFixed(2)}`);

  if (pending.length === 63 &&
      (!gross.eq("1896442.70") || !posted.eq("333722.35") || !expected.eq("1562720.35"))) {
    throw new Error("Production preflight changed: historical totals differ from the verified snapshot");
  }
  if (pending.length > 63) throw new Error("More missing invoices than the audited 63: stop and re-audit");

  const blocked: Candidate[] = [];
  const ready: Candidate[] = [];
  for (const invoice of pending) {
    const reasons: string[] = [];
    if (invoice.currency_code !== "USD") reasons.push("non-USD: verify historical FX");
    if (!Number.isInteger(Number(invoice.cache_count)) || Number(invoice.cache_count) !== 1 ||
      !toMoney(invoice.cache_total).eq(toMoney(invoice.gross))) reasons.push("invoice cache mismatch");
    if (toMoney(invoice.unlinked_positive_charges).greaterThan(0))
      reasons.push(`unposted charge(s) #${invoice.unlinked_charge_ids}`);
    if (toMoney(invoice.already_posted_charges).greaterThan(toMoney(invoice.gross)))
      reasons.push("posted charges exceed invoice");
    if (reasons.length) {
      blocked.push(invoice);
      console.warn(`BLOCKED ${invoice.invoice_number} ${invoice.customer_name}: ${reasons.join("; ")}`);
    } else ready.push(invoice);
  }
  console.log(`Eligible=${ready.length}; blocked=${blocked.length}`);

  if (!APPLY) {
    for (const invoice of ready) {
      console.log(`READY ${invoice.id} ${invoice.invoice_number}: gross ${invoice.gross}, charge ${invoice.already_posted_charges}, invoice posting ${toMoney(invoice.gross).minus(toMoney(invoice.already_posted_charges)).toFixed(2)}`);
    }
    console.log("DRY RUN complete; no database rows changed. Use --apply only after reviewing the full report.");
    return;
  }

  let postedCount = 0;
  let postedAmount = new MoneyDecimal(0);
  for (const invoice of ready) {
    await db.transaction(async (tx) => {
      if (!(await assertCandidateBeforePosting(tx, invoice))) {
        console.log(`SKIPPED ${invoice.invoice_number}: already posted`);
        return;
      }
      const before = await getPartyBalance(tx, {
        companyId: COMPANY, kind: "customer", id: invoice.customer_id, memo: true,
      });
      if (!before) throw new Error(`Missing customer ${invoice.customer_id}`);
      const beforeTotal = toMoney(before.closing).plus(toMoney(before.memoTotal));
      const voucherId = await syncFactoryInvoiceTx(tx, COMPANY, invoice.id);
      if (!voucherId) throw new Error(`No invoice voucher posted for ${invoice.invoice_number}`);
      const after = await getPartyBalance(tx, {
        companyId: COMPANY, kind: "customer", id: invoice.customer_id, memo: true,
      });
      if (!after) throw new Error(`Missing after-post customer ${invoice.customer_id}`);
      const afterTotal = toMoney(after.closing).plus(toMoney(after.memoTotal));
      if (!beforeTotal.eq(afterTotal))
        throw new Error(`Customer balance changed for ${invoice.invoice_number}: ${beforeTotal.toFixed(2)} -> ${afterTotal.toFixed(2)}`);

      const postedEntry = await tx.execute(sql`
        SELECT COALESCE(SUM(debit_amount),0)::text AS debit,
               COALESCE(SUM(credit_amount),0)::text AS credit
          FROM voucher_entries WHERE voucher_id = ${voucherId}
      `);
      const amounts = postedEntry.rows[0] as {debit: string; credit: string};
      if (!toMoney(amounts.debit).eq(toMoney(amounts.credit)))
        throw new Error(`Unbalanced voucher for ${invoice.invoice_number}`);
      console.log(`POSTED ${invoice.invoice_number} voucher=${voucherId} customer=${invoice.customer_name} unchanged=${afterTotal.toFixed(2)}`);
      postedCount += 1;
      postedAmount = postedAmount.plus(toMoney(invoice.gross).minus(toMoney(invoice.already_posted_charges)));
    });
  }
  console.log(`DONE: ${postedCount} invoices posted, total receivable and revenue ${postedAmount.toFixed(2)}, ${blocked.length} exceptions not posted.`);
}
void runWithDatabaseScopeRuntimeContext(
  createTenantDatabaseScope(COMPANY), run
).catch((err) => { console.error(err); process.exitCode = 1; })
.finally(() => pool.end());
